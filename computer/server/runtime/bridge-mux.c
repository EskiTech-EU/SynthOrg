/*
 * synthorg-mux: every connection to the router, over one channel.
 *
 * The router's SAM interface wants a socket for the session, one for each
 * stream and one for each wait for a caller. Reached through the engine,
 * each would be a chain of processes of its own on the host. This program
 * runs inside the router's container, beside the router: it is given frames
 * on its standard input, opens the sockets there, and gives back on its
 * standard output what comes from them. One process on the host, however
 * many connections.
 *
 * A frame is a type (1 byte), a channel (4 bytes, big endian), a length
 * (4 bytes, big endian) and that many bytes.
 *
 *   in:   O open the channel    D bytes for it    C close it
 *   out:  O it is open          D bytes from it   C it is closed (or never opened)
 *
 * When the standard input ends the program ends: the app that held it is
 * gone, and what started this program stops the router.
 *
 * Nothing waits while something else could go on: sockets and pipes are
 * non-blocking, what cannot be written yet is kept, and when too much is
 * kept on one side the other side is not read until it has gone down.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define CHANNELS 64
#define FRAME_MOST (64 * 1024)
#define HEAD 9
/* Kept for a socket before the input stops being read; kept for the output before the sockets stop being read. */
#define SOCKET_KEPT_MOST (1024 * 1024)
#define OUTPUT_KEPT_MOST (4 * 1024 * 1024)

struct queue {
    unsigned char *data;
    size_t from, length, room;
};

struct channel {
    int used;
    uint32_t id;
    int fd;
    int connecting;
    int closing; /* asked to close: closed when what is kept for it has been written */
    struct queue out;
};

static struct channel channels[CHANNELS];
static struct queue output;
static unsigned char input[HEAD + FRAME_MOST];
static size_t input_length;
static struct sockaddr_in target;

static void die(const char *what) {
    fprintf(stderr, "synthorg-mux: %s\n", what);
    exit(1);
}

static void keep(struct queue *queue, const unsigned char *bytes, size_t length) {
    if (!length) return;
    if (queue->from && queue->from + queue->length + length > queue->room) {
        memmove(queue->data, queue->data + queue->from, queue->length);
        queue->from = 0;
    }
    if (queue->from + queue->length + length > queue->room) {
        size_t room = queue->room ? queue->room : 16 * 1024;
        while (room < queue->from + queue->length + length) room *= 2;
        unsigned char *data = realloc(queue->data, room);
        if (!data) die("out of memory");
        queue->data = data;
        queue->room = room;
    }
    memcpy(queue->data + queue->from + queue->length, bytes, length);
    queue->length += length;
}

/* Writes what it can of what is kept. -1 when the other end is gone. */
static int drain(int fd, struct queue *queue) {
    while (queue->length) {
        ssize_t done = write(fd, queue->data + queue->from, queue->length);
        if (done < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
            return -1;
        }
        queue->from += (size_t)done;
        queue->length -= (size_t)done;
    }
    queue->from = 0;
    return 0;
}

static void frame(unsigned char type, uint32_t id, const unsigned char *bytes, size_t length) {
    unsigned char head[HEAD];
    head[0] = type;
    head[1] = (unsigned char)(id >> 24); head[2] = (unsigned char)(id >> 16); head[3] = (unsigned char)(id >> 8); head[4] = (unsigned char)id;
    head[5] = (unsigned char)(length >> 24); head[6] = (unsigned char)(length >> 16); head[7] = (unsigned char)(length >> 8); head[8] = (unsigned char)length;
    keep(&output, head, HEAD);
    keep(&output, bytes, length);
}

static struct channel *find(uint32_t id) {
    for (int i = 0; i < CHANNELS; i++) if (channels[i].used && channels[i].id == id) return &channels[i];
    return NULL;
}

static void drop(struct channel *channel, int tell) {
    if (tell) frame('C', channel->id, NULL, 0);
    if (channel->fd >= 0) close(channel->fd);
    free(channel->out.data);
    memset(channel, 0, sizeof *channel);
    channel->fd = -1;
}

static void nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) die("fcntl");
}

static void open_channel(uint32_t id) {
    struct channel *channel = NULL;
    if (find(id)) return;
    for (int i = 0; i < CHANNELS; i++) if (!channels[i].used) { channel = &channels[i]; break; }
    int fd = channel ? socket(AF_INET, SOCK_STREAM, 0) : -1;
    if (fd < 0) { frame('C', id, NULL, 0); return; }
    nonblocking(fd);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    memset(channel, 0, sizeof *channel);
    channel->used = 1;
    channel->id = id;
    channel->fd = fd;
    if (connect(fd, (struct sockaddr *)&target, sizeof target) == 0) {
        frame('O', id, NULL, 0);
    } else if (errno == EINPROGRESS) {
        channel->connecting = 1;
    } else {
        drop(channel, 1);
    }
}

static void take(unsigned char type, uint32_t id, const unsigned char *bytes, size_t length) {
    struct channel *channel;
    switch (type) {
    case 'O':
        open_channel(id);
        break;
    case 'D':
        channel = find(id);
        if (channel && !channel->closing) keep(&channel->out, bytes, length);
        break;
    case 'C':
        channel = find(id);
        if (!channel) break;
        if (channel->out.length && !channel->connecting) channel->closing = 1;
        else drop(channel, 0);
        break;
    default:
        die("unknown frame");
    }
}

/* What was read of the input, taken a frame at a time. */
static void parse(void) {
    size_t at = 0;
    while (input_length - at >= HEAD) {
        const unsigned char *head = input + at;
        uint32_t id = ((uint32_t)head[1] << 24) | ((uint32_t)head[2] << 16) | ((uint32_t)head[3] << 8) | head[4];
        uint32_t length = ((uint32_t)head[5] << 24) | ((uint32_t)head[6] << 16) | ((uint32_t)head[7] << 8) | head[8];
        if (length > FRAME_MOST) die("frame too long");
        if (input_length - at < HEAD + length) break;
        take(head[0], id, head + HEAD, length);
        at += HEAD + length;
    }
    if (at) {
        memmove(input, input + at, input_length - at);
        input_length -= at;
    }
}

int main(int argc, char **argv) {
    if (argc != 3) die("usage: synthorg-mux <address> <port>");
    memset(&target, 0, sizeof target);
    target.sin_family = AF_INET;
    target.sin_port = htons((uint16_t)atoi(argv[2]));
    if (inet_pton(AF_INET, argv[1], &target.sin_addr) != 1) die("address");
    signal(SIGPIPE, SIG_IGN);
    nonblocking(0);
    nonblocking(1);
    for (int i = 0; i < CHANNELS; i++) channels[i].fd = -1;

    static unsigned char read_buffer[32 * 1024];
    for (;;) {
        struct pollfd fds[CHANNELS + 2];
        struct channel *owner[CHANNELS + 2];
        int count = 0;
        int full = 0;
        for (int i = 0; i < CHANNELS; i++) if (channels[i].used && channels[i].out.length > SOCKET_KEPT_MOST) full = 1;

        fds[count].fd = 0;
        fds[count].events = full ? 0 : POLLIN;
        fds[count].revents = 0;
        owner[count++] = NULL;
        fds[count].fd = 1;
        fds[count].events = output.length ? POLLOUT : 0;
        fds[count].revents = 0;
        owner[count++] = NULL;
        for (int i = 0; i < CHANNELS; i++) {
            struct channel *channel = &channels[i];
            if (!channel->used) continue;
            short events = 0;
            if (channel->connecting || channel->out.length) events |= POLLOUT;
            if (!channel->connecting && !channel->closing && output.length < OUTPUT_KEPT_MOST) events |= POLLIN;
            fds[count].fd = channel->fd;
            fds[count].events = events;
            fds[count].revents = 0;
            owner[count++] = channel;
        }

        if (poll(fds, (nfds_t)count, -1) < 0) {
            if (errno == EINTR) continue;
            die("poll");
        }

        if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            ssize_t got = read(0, input + input_length, sizeof input - input_length);
            if (got == 0) return 0;
            if (got < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return 0;
            } else {
                input_length += (size_t)got;
                parse();
            }
        }

        for (int i = 2; i < count; i++) {
            struct channel *channel = owner[i];
            if (!channel->used || channel->fd != fds[i].fd) continue;
            if (channel->connecting) {
                if (!(fds[i].revents & (POLLOUT | POLLERR | POLLHUP))) continue;
                int failed = 0;
                socklen_t size = sizeof failed;
                if (getsockopt(channel->fd, SOL_SOCKET, SO_ERROR, &failed, &size) < 0 || failed) { drop(channel, 1); continue; }
                channel->connecting = 0;
                frame('O', channel->id, NULL, 0);
            }
            if (fds[i].revents & POLLOUT) {
                if (drain(channel->fd, &channel->out) < 0) { drop(channel, 1); continue; }
                if (channel->closing && !channel->out.length) { drop(channel, 0); continue; }
            }
            if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
                ssize_t got = read(channel->fd, read_buffer, sizeof read_buffer);
                if (got > 0) frame('D', channel->id, read_buffer, (size_t)got);
                else if (got == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) { drop(channel, 1); continue; }
            }
        }

        if (output.length && drain(1, &output) < 0) return 0;
    }
}
