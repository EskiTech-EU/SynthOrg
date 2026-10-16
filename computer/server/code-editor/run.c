/*
 * run — the model's commands, in the terminals of this editor.
 *
 * The same place as the user's commands, as on a local project: a command of
 * the model is typed into a terminal of the panel — the one on screen when it
 * is free, else another free one, else a new tab — and runs there in plain
 * view. Free means back at its prompt, with nothing typed by the user, in the
 * project's root: the model never types into a program the user is running,
 * nor after half a line of theirs, nor somewhere its relative paths would miss.
 *
 * Requests come as files, in a folder of this container the service reaches
 * with its own exec, as it always has for the model's commands:
 *   <id>.req   the command (written elsewhere, renamed in: whole when seen)
 *   <id>.stop  why it has to end: interrupted:stop, timeout, interrupted:disconnect
 * and the answer goes back the same way, never through the host's window:
 *   <id>.acc   seen; the service now waits for the end
 *   <id>.out   the output, as text
 *   <id>.exit  "<exit code> <reason or ->", or "-1 reject:<why>" when it never
 *              ran here (the service then runs it the older way, unseen)
 * The editor's own channel to the host stays what it is: pixels out, input in.
 *
 * The end of a command is the first prompt counted after it was sent (the hook
 * in term.c), so every end is seen the same way: on its own, after a Ctrl+C of
 * the user, stopped from the chat, or killed from outside. A stop is a Ctrl+C
 * first; a program still running after RUN_GRACE_MS is ended with its process
 * group, as the container's runs are.
 */

#include <sys/inotify.h>
#undef IN_MOVE                                         /* the editor's own IN_MOVE is a mouse move (main.c) */

#define RUN_DIR "/tmp/.synthorg-run"
#define MAX_RUNS 16
#define RUN_OUT_MAX (4 << 20)
#define RUN_GRACE_MS 2500
#define RUN_HOOK_MS 8000                                /* a new tab's shell has this long to show its first prompt */

typedef struct { char *s; size_t n, cap, line; int cr, cut; } TextBuf;

typedef struct Run {
    char id[65];
    char *cmd; size_t cmd_len;
    Term *t;
    int sent, started, sent_seq;
    TextBuf out, all;                                   /* out: from the line's start (PS0); all: from the send, echo included */
    char reason[40];
    long hook_until, stop_at;
    int stage;                                          /* after a stop: 1 Ctrl+C sent, 2 TERM, 3 KILL */
} Run;

static struct { int fd, wd; long checked; Run *runs[MAX_RUNS]; int n; } R = { -1, -1, 0, { 0 }, 0 };

static int run_id_ok(const char *id) {
    size_t n = strlen(id);
    if (!n || n > 64) return 0;
    for (size_t i = 0; i < n; i++) if (!isalnum((unsigned char)id[i]) && id[i] != '-') return 0;
    return 1;
}

static void run_file(char *out, size_t size, const char *id, const char *ext) { snprintf(out, size, RUN_DIR "/%s.%s", id, ext); }

/* Whole or not at all: the service sees a file only once it is complete. */
static void run_publish(const char *id, const char *ext, const char *data, size_t len) {
    char tmp[PATH_MAX], path[PATH_MAX];
    snprintf(tmp, sizeof tmp, RUN_DIR "/.%s.%s.tmp", id, ext);
    run_file(path, sizeof path, id, ext);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) return;
    size_t done = 0;
    while (done < len) { ssize_t n = write(fd, data + done, len - done); if (n < 0) { if (errno == EINTR) continue; break; } done += (size_t)n; }
    close(fd);
    rename(tmp, path);
}

/* The output as the terminal showed it: a lone CR goes back to the start of its line (progress bars), BS takes a
 * character back, other control characters are dropped. */
static void tb_put(TextBuf *b, unsigned char c) {
    if (b->cr) { b->cr = 0; if (c != '\n') b->n = b->line; }
    if (c == '\r') { b->cr = 1; return; }
    if (c == '\b') { if (b->n > b->line) { b->n--; while (b->n > b->line && ((unsigned char)b->s[b->n] & 0xC0) == 0x80) b->n--; } return; }
    if ((c < 0x20 && c != '\n' && c != '\t') || c == 0x7f) return;
    if (b->n >= RUN_OUT_MAX) { b->cut = 1; return; }
    if (b->n == b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        char *s = realloc(b->s, cap);
        if (!s) { b->cut = 1; return; }
        b->s = s; b->cap = cap;
    }
    b->s[b->n++] = (char)c;
    if (c == '\n') b->line = b->n;
}

static void run_free(Run *r) {
    for (int i = 0; i < R.n; i++) if (R.runs[i] == r) { memmove(R.runs + i, R.runs + i + 1, (size_t)(R.n - i - 1) * sizeof *R.runs); R.n--; break; }
    if (r->t && r->t->run == r) r->t->run = NULL;
    free(r->cmd); free(r->out.s); free(r->all.s); free(r);
    U.redraw = 1;
}

static void run_finish(Run *r, int code) {
    const char *text = r->out.s ? r->out.s : ""; size_t len = r->out.n; int cut = r->out.cut;
    if (!r->started) {                                  /* no PS0 (a line the shell did not run): what came after the echoed line */
        const char *nl = r->all.n ? memchr(r->all.s, '\n', r->all.n) : NULL;
        text = nl ? nl + 1 : ""; len = nl ? r->all.n - (size_t)(nl + 1 - r->all.s) : 0; cut = r->all.cut;
    }
    char *body = malloc(len + 64);
    if (body) {
        memcpy(body, text, len);
        if (cut) len += (size_t)snprintf(body + len, 64, "\n[output troncato oltre %d MB]", RUN_OUT_MAX >> 20);
        run_publish(r->id, "out", body, len);
        free(body);
    }
    char exit[80]; int n = snprintf(exit, sizeof exit, "%d %s\n", code, r->reason[0] ? r->reason : "-");
    run_publish(r->id, "exit", exit, (size_t)n);
    run_free(r);
}

static void run_reject(Run *r, const char *why) {
    char exit[120]; int n = snprintf(exit, sizeof exit, "-1 reject:%s\n", why);
    run_publish(r->id, "exit", exit, (size_t)n);
    run_free(r);
}

/* Back at its prompt and listening: typed before readline is, a line would be echoed twice. */
static int run_term_ready(Term *t) { return t->hooked && t->at_prompt && (t->ready || now_ms() - t->prompt_at > 300); }

/* At its prompt, nothing typed, nothing of the model's in it, no program in the foreground, in the project's root. */
static int run_term_free(Term *t) {
    if (!run_term_ready(t) || t->typed || t->run || t->fd < 0 || t->pid <= 0) return 0;
    if (tcgetpgrp(t->fd) != t->pid) return 0;
    char link[48], cwd[PATH_MAX];
    snprintf(link, sizeof link, "/proc/%d/cwd", (int)t->pid);
    ssize_t n = readlink(link, cwd, sizeof cwd - 1);
    if (n <= 0) return 0;
    cwd[n] = 0;
    return !strcmp(cwd, U.root);
}

static void run_show(Term *t) {
    for (int i = 0; i < U.nterms; i++) if (U.terms[i] == t) U.active_term = i;
    U.panel_on = 1; U.shown_doc = NULL; U.redraw = 1;
    term_resize_all();
}

static void run_send(Run *r) {
    Term *t = r->t;
    r->sent = 1; r->sent_seq = t->seq; t->typed = 0; t->view = 0;
    int lines = memchr(r->cmd, '\n', r->cmd_len) != NULL;
    if (lines && t->bpaste) term_output("\x1b[200~", 6, t);     /* one line for readline, one prompt at the end */
    term_output(r->cmd, r->cmd_len, t);
    if (lines && t->bpaste) term_output("\x1b[201~", 6, t);
    term_output("\r", 1, t);
    U.redraw = 1;
}

static void run_request(const char *id) {
    char path[PATH_MAX];
    run_file(path, sizeof path, id, "req");
    FILE *f = fopen(path, "rb");
    if (!f) return;
    Run *r = calloc(1, sizeof *r);
    size_t cap = 4096; char *cmd = malloc(cap); size_t n = 0, got;
    while (cmd && (got = fread(cmd + n, 1, cap - n, f)) > 0) { n += got; if (n == cap) { char *more = realloc(cmd, cap * 2); if (!more) break; cmd = more; cap *= 2; } }
    fclose(f);
    unlink(path);
    if (!r || !cmd) { free(r); free(cmd); return; }
    snprintf(r->id, sizeof r->id, "%s", id);
    while (n && (cmd[n - 1] == '\n' || cmd[n - 1] == '\r')) n--;
    r->cmd = cmd; r->cmd_len = n;
    if (R.n == MAX_RUNS) { run_reject(r, "too many commands"); return; }
    R.runs[R.n++] = r;
    run_publish(id, "acc", "", 0);
    if (!n) { run_reject(r, "empty command"); return; }
    Term *active = cur_term(), *pick = NULL;
    if (active && run_term_free(active)) pick = active;
    for (int i = 0; !pick && i < U.nterms; i++) if (run_term_free(U.terms[i])) pick = U.terms[i];
    if (!pick) {                                        /* a new tab, in view, without taking the keyboard */
        int focus = U.focus, had = U.nterms;
        pick = term_open();
        U.focus = focus;
        if (!pick || U.nterms == had) { run_reject(r, "no free terminal"); return; }
        r->hook_until = now_ms() + RUN_HOOK_MS;
    }
    r->t = pick; pick->run = r;
    run_show(pick);
    if (run_term_ready(pick)) run_send(r);
}

static Run *run_find(const char *id) { for (int i = 0; i < R.n; i++) if (!strcmp(R.runs[i]->id, id)) return R.runs[i]; return NULL; }

static void run_stop(const char *id) {
    char path[PATH_MAX], why[40] = "";
    run_file(path, sizeof path, id, "stop");
    FILE *f = fopen(path, "rb");
    if (f) { size_t n = fread(why, 1, sizeof why - 1, f); why[n] = 0; why[strcspn(why, "\r\n")] = 0; fclose(f); }
    unlink(path);
    Run *r = run_find(id);
    if (!r) return;
    if (!r->reason[0]) snprintf(r->reason, sizeof r->reason, "%s", why[0] ? why : "interrupted:stop");
    if (!r->sent) { run_finish(r, -1); return; }        /* never typed: it simply does not run */
    if (!r->stop_at) r->stop_at = now_ms();
}

/* ---- what term.c reports ------------------------------------------------------ */

static void run_prompt(Term *t, int seq, int code) {
    Run *r = t->run;
    if (!r || !r->sent || seq <= r->sent_seq) return;
    if (!r->reason[0] && code == 130) snprintf(r->reason, sizeof r->reason, "interrupted:ctrl-c");
    run_finish(r, code);
}

static void run_started(Term *t) { Run *r = t->run; if (r && r->sent) r->started = 1; }

static void run_text(Term *t, unsigned char c) {
    Run *r = t->run;
    if (!r || !r->sent) return;
    tb_put(&r->all, c);
    if (r->started) tb_put(&r->out, c);
}

static void run_user_interrupt(Term *t) {
    Run *r = t->run;
    if (r && r->sent && !r->reason[0]) snprintf(r->reason, sizeof r->reason, "interrupted:ctrl-c");
}

static void run_term_gone(Term *t) {
    Run *r = t->run;
    if (!r) return;
    r->t = NULL; t->run = NULL;
    if (!r->reason[0]) snprintf(r->reason, sizeof r->reason, "terminal closed");
    if (r->sent) run_finish(r, -1); else run_reject(r, "terminal closed");
}

/* ---- the folder, the clock ------------------------------------------------------ */

static void run_init(void) {
    mkdir(RUN_DIR, 0755);
    char pid[24]; int n = snprintf(pid, sizeof pid, "%d\n", (int)getpid());
    run_publish("editor", "pid", pid, (size_t)n);
    if (R.fd < 0) R.fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (R.fd >= 0 && R.wd < 0) R.wd = inotify_add_watch(R.fd, RUN_DIR, IN_MOVED_TO | IN_CLOSE_WRITE);
}

static void run_service(void) {
    char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
    for (;;) {
        ssize_t n = read(R.fd, buf, sizeof buf);
        if (n <= 0) return;
        for (char *p = buf; p < buf + n;) {
            struct inotify_event *e = (struct inotify_event *)p;
            p += sizeof *e + e->len;
            if (e->mask & IN_IGNORED) { R.wd = -1; continue; }
            if (!e->len) continue;
            char id[80]; snprintf(id, sizeof id, "%s", e->name);
            char *dot = strrchr(id, '.');
            if (!dot || id[0] == '.') continue;
            *dot = 0;
            if (!run_id_ok(id)) continue;
            if (!strcmp(dot + 1, "req")) run_request(id);
            else if (!strcmp(dot + 1, "stop")) run_stop(id);
        }
    }
}

static void run_tick(long now) {
    /* the folder is in the container, where anything may remove it: set up again when it goes */
    if (now - R.checked > 2000) {
        R.checked = now;
        struct stat st;
        if (R.wd < 0 || stat(RUN_DIR "/editor.pid", &st) != 0) run_init();
    }
    for (int i = R.n - 1; i >= 0; i--) {
        Run *r = R.runs[i];
        if (!r->t) continue;
        if (!r->sent) {
            if (run_term_ready(r->t) && !r->t->typed) run_send(r);
            else if (now > r->hook_until) run_reject(r, "the shell of the new terminal has no prompt hook");
            continue;
        }
        if (!r->stop_at) continue;
        long el = now - r->stop_at;
        pid_t pg = r->t->fd >= 0 ? tcgetpgrp(r->t->fd) : -1;
        int foreign = pg > 0 && pg != r->t->pid;
        if (r->stage == 0) { term_output("\x03", 1, r->t); r->stage = 1; }
        else if (r->stage == 1 && el >= RUN_GRACE_MS) { if (foreign) kill(-pg, SIGTERM); r->stage = 2; }
        else if (r->stage == 2 && el >= RUN_GRACE_MS + 1000) { if (foreign) kill(-pg, SIGKILL); r->stage = 3; }
        else if (r->stage == 3 && el >= RUN_GRACE_MS + 4000) run_finish(r, -1);  /* the shell itself does not answer */
    }
}

static int run_active(void) { return R.n > 0; }

static void run_shutdown(void) {
    while (R.n) {                                       /* the editor is closing: its terminals go with it */
        Run *r = R.runs[R.n - 1];
        if (!r->reason[0]) snprintf(r->reason, sizeof r->reason, "terminal closed");
        if (r->sent) run_finish(r, -1); else run_reject(r, "editor closed");
    }
    unlink(RUN_DIR "/editor.pid");
}
