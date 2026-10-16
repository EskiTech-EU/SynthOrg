/*
 * SynthOrg code editor.
 *
 * Runs entirely inside the project's container. It has no window: it draws to
 * a framebuffer and writes what changed to stdout, and it reads keyboard and
 * mouse from stdin. That pair of pipes is the only thing between the container
 * and the desktop, and all that ever crosses it outwards is pixels.
 *
 * Wire format (host -> editor), little endian:  u8 type, u16 length, payload
 *   IN_RESIZE  u16 w, u16 h, u16 scale*100
 *   IN_MOVE    i16 x, i16 y
 *   IN_BUTTON  u8 button, u8 down, i16 x, i16 y, u8 mods, u8 clicks
 *   IN_WHEEL   i16 x, i16 y, i16 dx, i16 dy, u8 mods
 *   IN_KEY     u8 down, u16 key, u8 mods
 *   IN_TEXT    utf-8 typed text
 *   IN_THEME   u8 dark, 8 x RGB (bg, surface, input, text, muted, primary, on_primary, border), u8 italian
 *   IN_FOCUS   u8 focused
 *   IN_QUIT
 *   IN_PASTE   u8 last, utf-8: the host clipboard at the moment the user pasted, in pieces
 *   IN_INSET   u16 h: device pixels to leave empty between the tree's title and its rows
 *   IN_SAVE    (empty) save every file with unsaved changes: the host is about to move files on disk
 *   IN_TREE    u8 shown: 0 when the host shows the project's files itself, and the tree here stays closed
 *   IN_FILE    utf-8: a file of the project, by its place in it, to open in a tab
 *   IN_DO      u8 what, asked from the host's bar: 1 undo, 2 redo, 3 save, on the file in view;
 *              4 larger, 5 smaller, 6 the size the text starts with
 *   IN_SHUT    utf-8: an open file, by its place in the project, to close as its tab's cross would
 *
 * Build: cc -O2 -static -o synthorg-editor main.c vterm/src/(every .c) -Ivterm/include -lm
 */

#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#include "stb_truetype.h"

#include "gfx.c"
#include "doc.c"
#include "syntax.c"
#include "ui.c"

enum { IN_RESIZE = 1, IN_MOVE, IN_BUTTON, IN_WHEEL, IN_KEY, IN_TEXT, IN_THEME, IN_FOCUS, IN_QUIT, IN_PASTE, IN_INSET, IN_SAVE, IN_TREE, IN_FILE, IN_DO, IN_SHUT };

#define FONT_DIR "/opt/synthorg-code/fonts"
#define BLINK_MS 530
#define WATCH_MS 1500

static int rd16(const unsigned char *p) { return p[0] | (p[1] << 8); }
static int rds16(const unsigned char *p) { return (int16_t)(p[0] | (p[1] << 8)); }

/* What is kept for the next start. Written when the window loses the keyboard too: the terminals and what runs in them stay. */
static void keep(void) { recovery_write(); session_save(); }
static void leave(void) { keep(); run_shutdown(); term_shutdown(); }

static void handle(int type, const unsigned char *p, int len) {
    switch (type) {
    case IN_RESIZE:
        if (len < 6) return;
        U.scale100 = rd16(p + 4); if (U.scale100 < 50) U.scale100 = 50; if (U.scale100 > 400) U.scale100 = 400;
        gfx_resize(rd16(p), rd16(p + 2));
        metrics_update();
        U.shown_doc = NULL; U.redraw = 1;
        break;
    case IN_MOVE: if (len >= 4) ui_mouse_move(rds16(p), rds16(p + 2)); break;
    case IN_BUTTON: if (len >= 8) ui_mouse_button(p[0], p[1], rds16(p + 2), rds16(p + 4), p[6], p[7]); break;
    case IN_WHEEL: if (len >= 9) ui_wheel(rds16(p), rds16(p + 2), rds16(p + 4), rds16(p + 6), p[8]); break;
    case IN_KEY: if (len >= 4) ui_key(p[0], rd16(p + 1), p[3]); break;
    case IN_TEXT: if (len > 0) ui_text((const char *)p, len, 0); break;
    case IN_PASTE: {
        /* A message carries at most 64 KB: a long paste arrives in pieces, the last one flagged. */
        static char *paste; static size_t paste_len;
        if (len < 1) return;
        paste = realloc(paste, paste_len + (size_t)len);
        if (!paste) { paste_len = 0; return; }
        memcpy(paste + paste_len, p + 1, (size_t)len - 1); paste_len += (size_t)len - 1;
        if (p[0]) { ui_paste(paste, (int)paste_len); paste_len = 0; }
        break; }
    case IN_THEME: {
        if (len < 26) return;
        U.dark = p[0];
        Color *slots[] = { &U.bg, &U.surface, &U.input, &U.text, &U.muted, &U.primary, &U.on_primary, &U.border };
        for (int i = 0; i < 8; i++) *slots[i] = RGB(p[1 + i * 3], p[2 + i * 3], p[3 + i * 3]);
        U.italian = p[25];
        theme_apply();
        U.shown_doc = NULL; U.redraw = 1;
        break; }
    case IN_FOCUS: if (len >= 1) { U.focused = p[0]; U.caret_on = 1; U.blink_at = now_ms(); U.redraw = 1; if (!p[0]) { U.drag = DRAG_NONE; keep(); } else watch_files(); } break;
    case IN_INSET: if (len >= 2) { int h = rd16(p); U.tree_inset = h > 600 ? 600 : h; U.redraw = 1; } break;
    case IN_SAVE: for (int i = 0; i < U.ndocs; i++) if (U.docs[i]->dirty) save_doc(U.docs[i]); U.redraw = 1; break;
    case IN_TREE: if (len >= 1) ui_host_files(!p[0]); break;
    case IN_FILE: ui_open_rel((const char *)p, len); break;
    case IN_DO: if (len >= 1) ui_do(p[0]); break;
    case IN_SHUT: ui_close_rel((const char *)p, len); break;
    case IN_QUIT: leave(); exit(0);
    }
}

int main(int argc, char **argv) {
    const char *root = argc > 1 ? argv[1] : "/workspace";
    if (!realpath(root, U.root)) { fprintf(stderr, "synthorg-editor: %s: %s\n", root, strerror(errno)); return 1; }
    if (argc > 2) snprintf(U.title, sizeof U.title, "%s", argv[2]);
    signal(SIGPIPE, SIG_IGN);
    if (!face_load(FACE_MONO, FONT_DIR "/mono.ttf") || !face_load(FACE_UI, FONT_DIR "/ui.ttf")) {
        fprintf(stderr, "synthorg-editor: fonts missing in %s\n", FONT_DIR);
        return 1;
    }
    syntax_init();
    theme_default();
    U.scale100 = 100; U.sidebar_w = 260; U.sidebar_on = 1; U.focused = 1; U.caret_on = 1; U.italian = 1; U.panel_h = 240;
    gfx_resize(1280, 800);
    metrics_update();
    U.tree = node_new(NULL, "", U.root, 1);
    U.tree->expanded = 1;
    node_load(U.tree);
    session_load();
    metrics_update();
    run_init();
    U.redraw = 1;

    static unsigned char buf[1 << 20];
    size_t have = 0;
    for (;;) {
        if (U.redraw) ui_draw();
        long now = now_ms(), wait = BLINK_MS - (now - U.blink_at) % BLINK_MS;
        if (U.toast[0] && U.toast_until - now < wait) wait = U.toast_until - now > 0 ? U.toast_until - now + 1 : 1;
        if ((run_active() || U.drag == DRAG_TREE_MOVE) && wait > 100) wait = 100;                       /* a command of the model: its stop and its clock */
        struct pollfd pfds[2 + MAX_TERMS] = { { STDIN_FILENO, POLLIN, 0 }, { R.fd, POLLIN, 0 } };
        int nfds = 2 + term_pollfds(pfds + 2, MAX_TERMS);
        int ready = poll(pfds, (nfds_t)nfds, U.focused || U.nterms ? (int)wait : WATCH_MS);
        now = now_ms();
        if (ready > 0 && nfds > 2) term_service(pfds + 2, nfds - 2);
        if (ready > 0 && (pfds[1].revents & POLLIN)) run_service();
        run_tick(now);
        tree_drag_tick(now);
        if (ready > 0 && (pfds[0].revents & (POLLIN | POLLHUP | POLLERR))) {
            ssize_t n = read(STDIN_FILENO, buf + have, sizeof buf - have);
            if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) { leave(); return 0; }     /* the host went away */
            if (n > 0) have += (size_t)n;
            size_t at = 0;
            while (have - at >= 3) {
                int len = buf[at + 1] | (buf[at + 2] << 8);
                if (have - at < (size_t)len + 3) break;
                handle(buf[at], buf + at + 3, len);
                at += (size_t)len + 3;
            }
            memmove(buf, buf + at, have - at);
            have -= at;
        }
        if (U.focused) {
            int on = ((now - U.blink_at) / BLINK_MS) % 2 == 0;
            if (on != U.caret_on) { U.caret_on = on; U.redraw = 1; }
        }
        if (U.toast[0] && now > U.toast_until) U.redraw = 1;
        if (now - U.last_watch > WATCH_MS) { U.last_watch = now; watch_files(); }
    }
}
