/*
 * term — terminals inside the editor.
 *
 * Each tab is a shell on a pseudo-terminal of this container, emulated by
 * libvterm and drawn as a grid of cells with the mono face. The shell, its
 * output and its scrollback never leave the pod: the host only ever gets the
 * pixels, and text copied here stays in the editor's own clipboard.
 *
 * Included by ui.c after the layout helpers: it reads U for metrics, theme and
 * focus, and ui.c calls into it for drawing, input and the file descriptors
 * the main loop waits on.
 */

#include <pty.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include "vterm/include/vterm.h"

#define MAX_TERMS 8
#define SB_LINES 2000
#define TERM_HEAD 30                                    /* logical px: the tab strip of the panel */

typedef struct { int n; VTermScreenCell *cells; } SbLine; /* a scrolled-off line, trailing blanks dropped */

typedef struct Term {
    VTerm *vt; VTermScreen *vts;
    int fd; pid_t pid;
    int rows, cols;
    SbLine sb[SB_LINES]; int sb_n, sb_head;              /* ring: sb[(sb_head + i) % SB_LINES], i in [0, sb_n) */
    int view;                                           /* lines scrolled back into history; 0 = live */
    char title[96];                                     /* what the program set with OSC 0/2 */
    char proc[32];                                      /* the program in the foreground, from /proc */
    int cursor_visible, cursor_shape, altscreen, mouse;
    VTermPos cursor;
    int selecting; VTermPos sel_a, sel_b;               /* rows are relative to the live screen: negative = history */
    int sel_on;
    /* the prompt hook (see TERM_RC): what the shell said about itself, read from its own byte stream */
    int hooked, seq, at_prompt, typed, bpaste;          /* seq: prompts so far; typed: the user typed since the last one */
    int ready; long prompt_at;                          /* readline listening (it turns bracketed paste on when it starts) */
    struct Run *run;                                    /* the model's command running here, if any (run.c) */
    int ps, plen; char pbuf[64];                        /* escape-sequence scanner */
} Term;

/* The shell's setup, read by bash from a pipe (--rcfile): the user's own ~/.bashrc first, then two markers that
 * nothing on screen shows. At every prompt: OSC 7771;P;<count>;<exit code of the line before>. When a line starts
 * running (PS0): OSC 7771;S. The model's commands are told apart from the user's by the count. */
static const char TERM_RC[] =
    "[ -r ~/.bashrc ] && . ~/.bashrc\n"
    "__synthorg_n=0\n"
    "__synthorg_prompt() { local e=$?; __synthorg_n=$((__synthorg_n + 1)); printf '\\033]7771;P;%d;%d\\007' \"$__synthorg_n\" \"$e\"; return $e; }\n"
    "PROMPT_COMMAND=\"__synthorg_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}\"\n"
    "PS0='\\e]7771;S\\a'\"$PS0\"\n"
    "exec 63<&-\n";

static void run_prompt(Term *t, int seq, int code);
static void run_started(Term *t);
static void run_text(Term *t, unsigned char c);
static void run_term_gone(Term *t);
static void run_user_interrupt(Term *t);

static void term_output(const char *s, size_t len, void *user) {
    Term *t = user;
    while (len && t->fd >= 0) {
        ssize_t n = write(t->fd, s, len);
        if (n < 0) { if (errno == EINTR || errno == EAGAIN) { struct pollfd p = { t->fd, POLLOUT, 0 }; poll(&p, 1, 200); continue; } return; }
        s += n; len -= (size_t)n;
    }
}

/* ---- scrollback ------------------------------------------------------------ */

static SbLine *sb_at(Term *t, int i) { return &t->sb[(t->sb_head + i) % SB_LINES]; }

static int term_sb_pushline(int cols, const VTermScreenCell *cells, void *user) {
    Term *t = user;
    int n = cols;
    while (n > 0 && cells[n - 1].chars[0] == 0 && VTERM_COLOR_IS_DEFAULT_BG(&cells[n - 1].bg) && !cells[n - 1].attrs.reverse) n--;
    SbLine *line;
    if (t->sb_n == SB_LINES) { line = sb_at(t, 0); free(line->cells); t->sb_head = (t->sb_head + 1) % SB_LINES; t->sb_n--; }
    line = sb_at(t, t->sb_n);
    line->n = n;
    line->cells = n ? malloc((size_t)n * sizeof *cells) : NULL;
    if (line->cells) memcpy(line->cells, cells, (size_t)n * sizeof *cells); else line->n = 0;
    t->sb_n++;
    if (t->view) t->view++;                             /* keep what the user is looking at in place */
    if (t->view > t->sb_n) t->view = t->sb_n;
    return 1;
}

static int term_sb_popline(int cols, VTermScreenCell *cells, void *user) {
    Term *t = user;
    if (!t->sb_n) return 0;
    SbLine *line = sb_at(t, t->sb_n - 1);
    int n = line->n < cols ? line->n : cols;
    if (n) memcpy(cells, line->cells, (size_t)n * sizeof *cells);
    for (int i = n; i < cols; i++) { memset(&cells[i], 0, sizeof cells[i]); cells[i].width = 1; cells[i].fg.type = VTERM_COLOR_DEFAULT_FG; cells[i].bg.type = VTERM_COLOR_DEFAULT_BG; }
    free(line->cells); line->cells = NULL; line->n = 0;
    t->sb_n--;
    if (t->view > t->sb_n) t->view = t->sb_n;
    return 1;
}

static int term_sb_clear(void *user) {
    Term *t = user;
    for (int i = 0; i < t->sb_n; i++) { SbLine *l = sb_at(t, i); free(l->cells); l->cells = NULL; l->n = 0; }
    t->sb_n = 0; t->sb_head = 0; t->view = 0;
    return 1;
}

/* ---- screen callbacks --------------------------------------------------- */

static int term_damage(VTermRect r, void *user) { (void)r; (void)user; U.redraw = 1; return 1; }
static int term_moverect(VTermRect d, VTermRect s, void *user) { (void)d; (void)s; (void)user; U.redraw = 1; return 1; }
static int term_movecursor(VTermPos pos, VTermPos old, int visible, void *user) { Term *t = user; (void)old; t->cursor = pos; t->cursor_visible = visible; U.redraw = 1; return 1; }
static int term_bell(void *user) { (void)user; U.redraw = 1; return 1; }
static int term_resize_cb(int rows, int cols, void *user) { Term *t = user; t->rows = rows; t->cols = cols; return 1; }

static int term_settermprop(VTermProp prop, VTermValue *val, void *user) {
    Term *t = user;
    switch (prop) {
    case VTERM_PROP_CURSORVISIBLE: t->cursor_visible = val->boolean; break;
    case VTERM_PROP_CURSORSHAPE: t->cursor_shape = val->number; break;
    case VTERM_PROP_ALTSCREEN: t->altscreen = val->boolean; t->view = 0; break;
    case VTERM_PROP_MOUSE: t->mouse = val->number; break;
    case VTERM_PROP_TITLE: {
        VTermStringFragment f = val->string;
        if (f.initial) t->title[0] = 0;
        size_t have = strlen(t->title), room = sizeof t->title - 1 - have, take = f.len < room ? f.len : room;
        memcpy(t->title + have, f.str, take); t->title[have + take] = 0;
        break; }
    default: break;
    }
    U.redraw = 1;
    return 1;
}

static const VTermScreenCallbacks TERM_CB = {
    term_damage, term_moverect, term_movecursor, term_settermprop, term_bell, term_resize_cb, term_sb_pushline, term_sb_popline, term_sb_clear
};

/* ---- palette ---------------------------------------------------------------- */

static const uint32_t ANSI_DARK[16] = { 0x1e1e1e, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xcccccc, 0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff };
static const uint32_t ANSI_LIGHT[16] = { 0x000000, 0xcd3131, 0x00a000, 0x949800, 0x0451a5, 0xbc05bc, 0x0598bc, 0x555555, 0x666666, 0xcd3131, 0x14ce14, 0xb5ba00, 0x0451a5, 0xbc05bc, 0x0598bc, 0xa5a5a5 };

static void term_theme(Term *t) {
    VTermState *st = vterm_obtain_state(t->vt);
    const uint32_t *pal = U.dark ? ANSI_DARK : ANSI_LIGHT;
    for (int i = 0; i < 16; i++) { VTermColor c; vterm_color_rgb(&c, (pal[i] >> 16) & 0xFF, (pal[i] >> 8) & 0xFF, pal[i] & 0xFF); vterm_state_set_palette_color(st, i, &c); }
    VTermColor fg, bg;
    vterm_color_rgb(&fg, C_R(U.text), C_G(U.text), C_B(U.text));
    vterm_color_rgb(&bg, C_R(U.bg), C_G(U.bg), C_B(U.bg));
    vterm_screen_set_default_colors(t->vts, &fg, &bg);
}

static void term_theme_all(void) { for (int i = 0; i < U.nterms; i++) term_theme(U.terms[i]); }

/* ---- layout ------------------------------------------------------------------ */

/* The panel is a section under the editor, as wide as it: as tall as the user left it, never so tall that the
   editor is left with nothing; folded, it is its bar alone. */
static int dock_h(void) {
    if (!panel_h()) return 0;
    if (U.float_min) return S(TERM_HEAD);
    int most = G.h - tabs_h() - status_h() - S(90), h = panel_h();
    if (h > most) h = most;
    return h < S(TERM_HEAD) ? S(TERM_HEAD) : h;
}
static Rect r_panel(void) {
    if (!panel_h()) return (Rect){ 0, 0, 0, 0 };
    Rect e = r_editor();
    return (Rect){ e.x, e.y + e.h, e.w, dock_h() };
}
static Rect r_panel_head(void) { Rect p = r_panel(); return (Rect){ p.x, p.y, p.w, p.h ? S(TERM_HEAD) : 0 }; }
/* Where the section is resized from: its upper edge. */
static Rect r_panel_corner(void) { Rect p = r_panel(); return (Rect){ p.x, p.y - S(2), p.w, S(5) }; }
static Rect r_grid(void) {
    Rect p = r_panel();
    if (U.float_min || !p.h) return (Rect){ p.x, p.y, 0, 0 };
    return (Rect){ p.x + S(8), p.y + S(TERM_HEAD) + S(4), p.w - S(8) - bar_w(), p.h - S(TERM_HEAD) - S(4) };
}
static Term *cur_term(void) { return U.nterms ? U.terms[U.active_term] : NULL; }

static void term_fit(Term *t) {
    if (U.float_min) return;                 /* put aside: the shell keeps the size it had */
    Rect g = r_grid();
    int rows = g.h / U.line_h, cols = g.w / U.cell_w;
    if (rows < 2) rows = 2;
    if (cols < 10) cols = 10;
    if (rows == t->rows && cols == t->cols) return;
    vterm_set_size(t->vt, rows, cols);
    t->rows = rows; t->cols = cols;
    struct winsize ws = { (unsigned short)rows, (unsigned short)cols, 0, 0 };
    if (t->fd >= 0) ioctl(t->fd, TIOCSWINSZ, &ws);
    t->sel_on = 0;
    U.redraw = 1;
}

static void term_resize_all(void) { for (int i = 0; i < U.nterms; i++) term_fit(U.terms[i]); }

/* ---- lifecycle ------------------------------------------------------------- */

static Term *term_open(void) {
    if (U.nterms == MAX_TERMS) { toast(TR("Troppi terminali aperti", "Too many terminals open")); return NULL; }
    Term *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    Rect g = r_grid();
    int rows = g.h / U.line_h, cols = g.w / U.cell_w;
    if (rows < 2) rows = 24;
    if (cols < 10) cols = 80;
    t->rows = rows; t->cols = cols; t->fd = -1; t->cursor_visible = 1; t->cursor_shape = VTERM_PROP_CURSORSHAPE_BLOCK;
    snprintf(t->title, sizeof t->title, "bash");
    t->vt = vterm_new(rows, cols);
    vterm_set_utf8(t->vt, 1);
    vterm_output_set_callback(t->vt, term_output, t);
    t->vts = vterm_obtain_screen(t->vt);
    vterm_screen_set_callbacks(t->vts, &TERM_CB, t);
    vterm_screen_set_damage_merge(t->vts, VTERM_DAMAGE_SCROLL);
    vterm_screen_enable_altscreen(t->vts, 1);
    vterm_screen_enable_reflow(t->vts, true);
    vterm_screen_reset(t->vts, 1);
    term_theme(t);
    struct winsize ws = { (unsigned short)rows, (unsigned short)cols, 0, 0 };
    int rc[2] = { -1, -1 };
    if (pipe(rc) == 0) {                                /* far smaller than a pipe's buffer: written whole, before the shell starts */
        if (write(rc[1], TERM_RC, sizeof TERM_RC - 1) != (ssize_t)(sizeof TERM_RC - 1)) { close(rc[0]); rc[0] = -1; }
        close(rc[1]);
    }
    pid_t pid = forkpty(&t->fd, NULL, NULL, &ws);
    if (pid < 0) { if (rc[0] >= 0) close(rc[0]); toast(TR("Impossibile aprire un terminale", "Cannot open a terminal")); vterm_free(t->vt); free(t); return NULL; }
    if (pid == 0) {
        if (chdir(U.root) != 0) (void)chdir("/");
        setenv("TERM", "xterm-256color", 1);
        setenv("COLORTERM", "truecolor", 1);
        if (!getenv("LANG")) setenv("LANG", "C.UTF-8", 1);
        if (!getenv("HOME")) setenv("HOME", "/root", 1);
        /* the working directory in the accent colour instead of the container's id (Alpine keeps a PS1 that is set) */
        if (!getenv("PS1")) setenv("PS1", "\\[\\e[35m\\]\\w\\[\\e[0m\\] \\$ ", 1);
        signal(SIGPIPE, SIG_DFL);
        if (rc[0] >= 0 && dup2(rc[0], 63) == 63) { if (rc[0] != 63) close(rc[0]); execlp("bash", "bash", "--rcfile", "/dev/fd/63", (char *)NULL); }
        execlp("bash", "bash", (char *)NULL);
        execl("/bin/sh", "sh", (char *)NULL);
        _exit(127);
    }
    t->pid = pid;
    if (rc[0] >= 0) close(rc[0]);
    fcntl(t->fd, F_SETFL, fcntl(t->fd, F_GETFL) | O_NONBLOCK);
    fcntl(t->fd, F_SETFD, FD_CLOEXEC);
    U.terms[U.nterms] = t; U.active_term = U.nterms++;
    U.panel_on = 1; U.float_min = 0; U.focus = FOCUS_TERM; U.shown_doc = NULL; U.redraw = 1;
    term_resize_all();
    return t;
}

static void term_free(Term *t) {
    if (t->fd >= 0) close(t->fd);
    if (t->pid > 0) { kill(t->pid, SIGHUP); waitpid(t->pid, NULL, WNOHANG); }
    term_sb_clear(t);
    vterm_free(t->vt);
    free(t);
}

static void term_close(int index) {
    if (index < 0 || index >= U.nterms) return;
    run_term_gone(U.terms[index]);
    term_free(U.terms[index]);
    memmove(U.terms + index, U.terms + index + 1, (size_t)(U.nterms - index - 1) * sizeof *U.terms);
    U.nterms--;
    if (U.active_term >= U.nterms) U.active_term = U.nterms - 1;
    if (U.active_term < 0) U.active_term = 0;
    if (!U.nterms) { U.focus = FOCUS_EDITOR; }
    U.shown_doc = NULL; U.redraw = 1;
    term_resize_all();
}

static void term_shutdown(void) {
    for (int i = 0; i < U.nterms; i++) { Term *t = U.terms[i]; if (t->pid > 0) kill(t->pid, SIGHUP); }
    for (int i = 0; i < U.nterms; i++) { Term *t = U.terms[i]; if (t->fd >= 0) { close(t->fd); t->fd = -1; } }
}

/* The tab is named after the program in the foreground, as the SideX terminals are: bash, python, vim. */
static void term_proc_update(Term *t) {
    pid_t pg = t->fd >= 0 ? tcgetpgrp(t->fd) : -1;
    if (pg <= 0) return;
    char path[48], name[sizeof t->proc] = "";
    snprintf(path, sizeof path, "/proc/%d/comm", (int)pg);
    FILE *f = fopen(path, "r");
    if (!f) return;
    if (fgets(name, sizeof name, f)) name[strcspn(name, "\n")] = 0;
    fclose(f);
    if (name[0] && strcmp(name, t->proc)) { snprintf(t->proc, sizeof t->proc, "%s", name); U.redraw = 1; }
}

/* What the shell wrote, read once more before libvterm draws it: the prompt hook's markers, bracketed paste on or
 * off, and — while a command of the model runs here — its output as text, without colours or cursor moves. */
static void term_osc(Term *t) {
    t->pbuf[t->plen] = 0;
    int seq, code;
    if (strncmp(t->pbuf, "7771;", 5)) return;
    if (sscanf(t->pbuf + 5, "P;%d;%d", &seq, &code) == 2) {
        t->hooked = 1; t->seq = seq; t->at_prompt = 1; t->typed = 0; t->ready = 0; t->prompt_at = now_ms();
        run_prompt(t, seq, code);
    } else if (!strcmp(t->pbuf + 5, "S")) { t->at_prompt = 0; run_started(t); }
}

static void term_scan(Term *t, const unsigned char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        unsigned char c = s[i];
        switch (t->ps) {
        case 0: if (c == 0x1b) t->ps = 1; else run_text(t, c); break;
        case 1:                                             /* after ESC */
            t->plen = 0;
            t->ps = c == '[' ? 2 : c == ']' ? 3 : (c == '(' || c == ')' || c == '*' || c == '+') ? 5 : 0;
            break;
        case 2:                                             /* CSI: parameters, then a final byte */
            if (c >= 0x40 && c <= 0x7e) {
                t->pbuf[t->plen] = 0;
                if ((c == 'h' || c == 'l') && !strcmp(t->pbuf, "?2004")) { t->bpaste = c == 'h'; if (t->bpaste && t->at_prompt) t->ready = 1; }
                t->ps = 0;
            } else if (t->plen < (int)sizeof t->pbuf - 1) t->pbuf[t->plen++] = (char)c;
            break;
        case 3:                                             /* OSC: to BEL or ESC \ */
            if (c == 0x07) { term_osc(t); t->ps = 0; }
            else if (c == 0x1b) t->ps = 4;
            else if (t->plen < (int)sizeof t->pbuf - 1) t->pbuf[t->plen++] = (char)c;
            break;
        case 4: if (c == '\\') term_osc(t); t->ps = 0; break;
        default: t->ps = 0; break;
        }
    }
}

/* Read what the shells wrote; reap the ones that left. Called with the fds poll() reported. */
static void term_service(struct pollfd *fds, int n) {
    for (int i = 0; i < n; i++) {
        if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
        Term *t = NULL;
        for (int k = 0; k < U.nterms; k++) if (U.terms[k]->fd == fds[i].fd) { t = U.terms[k]; break; }
        if (!t) continue;
        char buf[65536];
        int gone = 0;
        for (int round = 0; round < 8; round++) {
            ssize_t got = read(t->fd, buf, sizeof buf);
            if (got > 0) { term_scan(t, (const unsigned char *)buf, (size_t)got); vterm_input_write(t->vt, buf, (size_t)got); U.redraw = 1; if ((size_t)got < sizeof buf) break; continue; }
            if (got == 0 || (got < 0 && errno != EAGAIN && errno != EINTR)) gone = 1;
            break;
        }
        vterm_screen_flush_damage(t->vts);
        term_proc_update(t);
        if (gone) {
            int status = 0, code = 0;
            if (t->pid > 0 && waitpid(t->pid, &status, 0) == t->pid) { code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0); t->pid = 0; }
            if (code) { char msg[96]; snprintf(msg, sizeof msg, TR("Terminale chiuso con codice %d", "Terminal exited with code %d"), code); toast(msg); }
            for (int k = 0; k < U.nterms; k++) if (U.terms[k] == t) { term_close(k); break; }
        }
    }
}

static int term_pollfds(struct pollfd *fds, int max) {
    int n = 0;
    for (int i = 0; i < U.nterms && n < max; i++) if (U.terms[i]->fd >= 0) { fds[n].fd = U.terms[i]->fd; fds[n].events = POLLIN; fds[n].revents = 0; n++; }
    return n;
}

/* ---- text out of the grid -------------------------------------------------- */

static int utf8_put(char *out, uint32_t cp) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) { out[0] = (char)(0xC0 | (cp >> 6)); out[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
    if (cp < 0x10000) { out[0] = (char)(0xE0 | (cp >> 12)); out[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[2] = (char)(0x80 | (cp & 0x3F)); return 3; }
    out[0] = (char)(0xF0 | (cp >> 18)); out[1] = (char)(0x80 | ((cp >> 12) & 0x3F)); out[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[3] = (char)(0x80 | (cp & 0x3F)); return 4;
}

/* The cell at a row of the view: history rows are negative. */
static int term_cell(Term *t, int row, int col, VTermScreenCell *cell) {
    if (row >= 0) return vterm_screen_get_cell(t->vts, (VTermPos){ row, col }, cell);
    int i = t->sb_n + row;
    if (i < 0 || i >= t->sb_n) return 0;
    SbLine *l = sb_at(t, i);
    if (col >= l->n) { memset(cell, 0, sizeof *cell); cell->width = 1; cell->fg.type = VTERM_COLOR_DEFAULT_FG; cell->bg.type = VTERM_COLOR_DEFAULT_BG; return 1; }
    *cell = l->cells[col];
    return 1;
}

static int term_line_len(Term *t, int row) {
    if (row < 0) { int i = t->sb_n + row; return i >= 0 && i < t->sb_n ? sb_at(t, i)->n : 0; }
    int n = t->cols;
    VTermScreenCell c;
    while (n > 0 && vterm_screen_get_cell(t->vts, (VTermPos){ row, n - 1 }, &c) && c.chars[0] == 0) n--;
    return n;
}

static int term_sel_range(Term *t, VTermPos *a, VTermPos *b) {
    if (!t->sel_on) return 0;
    *a = t->sel_a; *b = t->sel_b;
    if (vterm_pos_cmp(*a, *b) > 0) { VTermPos s = *a; *a = *b; *b = s; }
    return vterm_pos_cmp(*a, *b) != 0;
}

static char *term_selection_text(Term *t, int *len) {
    VTermPos a, b;
    if (!term_sel_range(t, &a, &b)) return NULL;
    size_t cap = 4096, n = 0; char *out = malloc(cap);
    if (!out) return NULL;
    for (int row = a.row; row <= b.row; row++) {
        int c0 = row == a.row ? a.col : 0, c1 = row == b.row ? b.col : t->cols;
        int last = term_line_len(t, row); if (c1 > last) c1 = last;
        for (int col = c0; col < c1; col++) {
            VTermScreenCell cell;
            if (!term_cell(t, row, col, &cell)) continue;
            if (n + 32 > cap) { cap *= 2; char *g = realloc(out, cap); if (!g) { free(out); return NULL; } out = g; }
            if (cell.chars[0] == (uint32_t)-1) continue;                        /* right half of a wide glyph */
            if (cell.chars[0] == 0) { out[n++] = ' '; continue; }
            for (int k = 0; k < VTERM_MAX_CHARS_PER_CELL && cell.chars[k]; k++) n += (size_t)utf8_put(out + n, cell.chars[k]);
        }
        if (row < b.row) out[n++] = '\n';
    }
    out[n] = 0; *len = (int)n;
    return out;
}

static void term_copy(Term *t) {
    int len; char *text = term_selection_text(t, &len);
    if (!text) return;
    set_clip(text, len); free(text);
    t->sel_on = 0; U.redraw = 1;
}

/* ---- input ------------------------------------------------------------------- */

static VTermModifier term_mods(int mods) {
    VTermModifier m = VTERM_MOD_NONE;
    if (mods & M_SHIFT) m |= VTERM_MOD_SHIFT;
    if (mods & M_ALT) m |= VTERM_MOD_ALT;
    if (mods & (M_CTRL | M_META)) m |= VTERM_MOD_CTRL;
    return m;
}

static void term_write_text(Term *t, const char *text, int len, int paste) {
    t->typed = 1;
    if (paste) vterm_keyboard_start_paste(t->vt);
    for (int i = 0; i < len;) {
        uint32_t cp = (uint32_t)utf8_next(text, len, &i);
        if (cp == '\n') cp = '\r';
        if (cp == '\r' && i < len && text[i] == '\n') i++;
        vterm_keyboard_unichar(t->vt, cp, VTERM_MOD_NONE);
    }
    if (paste) vterm_keyboard_end_paste(t->vt);
    t->view = 0; U.redraw = 1;
}

static void term_key(Term *t, int key, int mods) {
    VTermModifier m = term_mods(mods);
    int shift = mods & M_SHIFT;
    if (key == K_PGUP && shift) { t->view += t->rows - 1; if (t->view > t->sb_n) t->view = t->sb_n; U.redraw = 1; return; }
    if (key == K_PGDN && shift) { t->view -= t->rows - 1; if (t->view < 0) t->view = 0; U.redraw = 1; return; }
    t->typed = 1;                                       /* the line is the user's now: the model will not type after it */
    if ((mods & M_CTRL) && key == 'C') run_user_interrupt(t);
    VTermKey vk = VTERM_KEY_NONE;
    switch (key) {
    case K_LEFT: vk = VTERM_KEY_LEFT; break;     case K_RIGHT: vk = VTERM_KEY_RIGHT; break;
    case K_UP: vk = VTERM_KEY_UP; break;         case K_DOWN: vk = VTERM_KEY_DOWN; break;
    case K_HOME: vk = VTERM_KEY_HOME; break;     case K_END: vk = VTERM_KEY_END; break;
    case K_PGUP: vk = VTERM_KEY_PAGEUP; break;   case K_PGDN: vk = VTERM_KEY_PAGEDOWN; break;
    case K_BACKSPACE: vk = VTERM_KEY_BACKSPACE; break; case K_DELETE: vk = VTERM_KEY_DEL; break;
    case K_ENTER: vk = VTERM_KEY_ENTER; break;   case K_TAB: vk = VTERM_KEY_TAB; break;
    case K_ESCAPE: vk = VTERM_KEY_ESCAPE; break; case K_INSERT: vk = VTERM_KEY_INS; break;
    default:
        if (key >= K_F1 && key <= K_F1 + 11) vk = VTERM_KEY_FUNCTION(key - K_F1 + 1);
        else if (key >= 32 && key < 127) {
            uint32_t cp = (uint32_t)key;
            if (cp >= 'A' && cp <= 'Z' && !shift) cp += 'a' - 'A';           /* the host sends letters upper-case */
            /* Ctrl only means something with letters, space and @ [ \ ] ^ _ (the C0 controls); elsewhere it is dropped, as xterm does. */
            if ((m & VTERM_MOD_CTRL) && !((cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z') || strchr("@[\\]^_ ", (int)cp))) m &= ~VTERM_MOD_CTRL;
            vterm_keyboard_unichar(t->vt, cp, m);
            t->view = 0; U.redraw = 1;
            return;
        }
        break;
    }
    if (vk == VTERM_KEY_NONE) return;
    vterm_keyboard_key(t->vt, vk, m);
    t->view = 0; U.redraw = 1;
}

static VTermPos term_pos_at(Term *t, int x, int y) {
    Rect g = r_grid();
    int row = (y - g.y) / U.line_h - t->view, col = (x - g.x + U.cell_w / 2) / U.cell_w;
    if (y < g.y) row = -t->view - 1;
    if (col < 0) col = 0;
    if (col > t->cols) col = t->cols;
    if (row < -t->sb_n) row = -t->sb_n;
    if (row >= t->rows) row = t->rows - 1;
    return (VTermPos){ row, col };
}

static int term_word_char(Term *t, int row, int col) {
    VTermScreenCell c;
    if (col < 0 || col >= t->cols || !term_cell(t, row, col, &c) || !c.chars[0] || c.chars[0] == (uint32_t)-1) return 0;
    uint32_t cp = c.chars[0];
    return cp > 127 || isalnum((int)cp) || cp == '_' || cp == '-' || cp == '.' || cp == '/';
}

static void term_mouse_button(Term *t, int button, int down, int x, int y, int mods, int clicks) {
    if (t->mouse && !(mods & M_SHIFT)) {
        VTermPos p = term_pos_at(t, x, y);
        if (p.row < 0) p.row = 0;
        vterm_mouse_move(t->vt, p.row, p.col, term_mods(mods));
        vterm_mouse_button(t->vt, button == 0 ? 1 : button == 1 ? 2 : 3, down != 0, term_mods(mods));
        return;
    }
    if (!down) { U.drag = DRAG_NONE; return; }
    if (button == 1) { if (U.clip) term_write_text(t, U.clip, U.clip_len, 1); return; }
    if (button != 0) return;
    VTermPos p = term_pos_at(t, x, y);
    if (clicks >= 3) { t->sel_a = (VTermPos){ p.row, 0 }; t->sel_b = (VTermPos){ p.row, t->cols }; t->sel_on = 1; return; }
    if (clicks == 2) {
        int a = p.col, b = p.col;
        while (a > 0 && term_word_char(t, p.row, a - 1)) a--;
        while (b < t->cols && term_word_char(t, p.row, b)) b++;
        t->sel_a = (VTermPos){ p.row, a }; t->sel_b = (VTermPos){ p.row, b }; t->sel_on = a != b;
        return;
    }
    if (mods & M_SHIFT && t->sel_on) { t->sel_b = p; U.drag = DRAG_TERM_SELECT; return; }
    t->sel_a = t->sel_b = p; t->sel_on = 0; U.drag = DRAG_TERM_SELECT;
}

static void term_mouse_move(Term *t, int x, int y) {
    if (U.drag == DRAG_TERM_SELECT) {
        VTermPos p = term_pos_at(t, x, y);
        t->sel_b = p; t->sel_on = vterm_pos_cmp(t->sel_a, t->sel_b) != 0;
        Rect g = r_grid();
        if (y < g.y && t->view < t->sb_n) t->view++;
        if (y > g.y + g.h && t->view > 0) t->view--;
        U.redraw = 1;
    } else if (t->mouse >= VTERM_PROP_MOUSE_MOVE) {
        VTermPos p = term_pos_at(t, x, y);
        if (p.row >= 0) vterm_mouse_move(t->vt, p.row, p.col, VTERM_MOD_NONE);
    }
}

static void term_wheel(Term *t, int dy, int mods) {
    int lines = dy / U.line_h; if (!lines) lines = dy < 0 ? -1 : 1;
    if (t->mouse && !(mods & M_SHIFT)) {
        int n = lines < 0 ? -lines : lines;
        for (int i = 0; i < n; i++) { vterm_mouse_button(t->vt, lines < 0 ? 4 : 5, true, term_mods(mods)); vterm_mouse_button(t->vt, lines < 0 ? 4 : 5, false, term_mods(mods)); }
        return;
    }
    if (t->altscreen) {                                  /* a full-screen program: the wheel is arrow keys */
        int n = lines < 0 ? -lines : lines;
        for (int i = 0; i < n; i++) vterm_keyboard_key(t->vt, lines < 0 ? VTERM_KEY_UP : VTERM_KEY_DOWN, VTERM_MOD_NONE);
        return;
    }
    t->view -= lines;
    if (t->view < 0) t->view = 0;
    if (t->view > t->sb_n) t->view = t->sb_n;
    U.redraw = 1;
}

/* ---- drawing ------------------------------------------------------------------- */

static Color term_color(Term *t, VTermColor c, int is_bg) {
    if (is_bg && VTERM_COLOR_IS_DEFAULT_BG(&c)) return U.bg;
    if (!is_bg && VTERM_COLOR_IS_DEFAULT_FG(&c)) return U.text;
    vterm_screen_convert_color_to_rgb(t->vts, &c);
    return RGB(c.rgb.red, c.rgb.green, c.rgb.blue);
}

/* The strip is the SideX one: icon, name, close on the active or hovered tab, then new terminal and hide panel. */
static const char *term_label(Term *t) { return t->proc[0] ? t->proc : t->title; }
static int tab_w_term(Term *t) {
    int w = gfx_text_width(FACE_UI, S(12), term_label(t), -1) + S(64);
    return w < S(100) ? S(100) : w > S(220) ? S(220) : w;
}
static Rect r_tab_close(Rect head, int x, int w) { return (Rect){ x + w - S(26), head.y + (head.h - S(20)) / 2, S(20), S(20) }; }
#define PANEL_ACTIONS 3
static Rect r_panel_action(int i) {                      /* 0 new terminal, 1 put the window aside (or bring it back), 2 close it */
    Rect head = r_panel_head();
    return (Rect){ head.x + head.w - S(30) * (PANEL_ACTIONS - i) - S(4), head.y + S(3), S(28), head.h - S(6) };
}

static void panel_frame(void);

static void draw_panel_body(void);
static void draw_panel(void) {
    if (!panel_h()) return;
    draw_panel_body();
    gfx_unclip();
    panel_frame();
}

/* The line between the section and the editor over it. */
static void panel_frame(void) {
    Rect p = r_panel();
    gfx_fill((Rect){ p.x, p.y, p.w, S(1) > 0 ? S(1) : 1 }, U.focus == FOCUS_TERM ? mix(U.border, U.primary, 120) : U.border);
}

static void draw_panel_body(void) {
    Rect p = r_panel(), head = r_panel_head(), g = r_grid();
    gfx_fill(p, U.bg);
    gfx_fill(head, U.surface);
    gfx_fill((Rect){ head.x, head.y, head.w, 1 }, U.border);
    gfx_fill((Rect){ head.x, head.y + head.h - 1, head.w, 1 }, U.border);
    Rect strip = { head.x, head.y, r_panel_action(0).x - S(4) - head.x, head.h };
    gfx_clip(strip);
    int x = head.x;
    for (int i = 0; i < U.nterms; i++) {
        Term *t = U.terms[i]; int w = tab_w_term(t), on = i == U.active_term;
        Rect tab = { x, head.y + 1, w, head.h - 2 };
        int hot = rect_has(tab, U.mx, U.my);
        if (on) gfx_fill(tab, U.bg);
        else if (hot) gfx_fill(tab, mix(U.surface, U.text, 12));
        if (on) gfx_fill((Rect){ x, head.y + head.h - S(2), w, S(2) }, U.focus == FOCUS_TERM ? U.primary : U.muted);
        Color ink = on ? U.text : U.muted;
        gfx_icon(ICON_TERMINAL, (Rect){ x + S(10), head.y, S(16), head.h }, S(16), ink);
        Rect close = r_tab_close(head, x, w);
        gfx_text_fit(FACE_UI, S(12), x + S(32), head.y + (head.h - S(12)) / 2 + font_ascent(FACE_UI, S(12)), term_label(t), close.x - S(4) - (x + S(32)), ink);
        if (on || hot) {
            int over = rect_has(close, U.mx, U.my);
            if (over) gfx_fill(close, U.input);
            gfx_icon(ICON_CLOSE, close, S(14), over ? U.text : ink);
        }
        gfx_fill((Rect){ x + w - 1, head.y + 1, 1, head.h - 2 }, U.border);
        x += w;
    }
    gfx_unclip();
    gfx_clip(head);
    for (int i = 0; i < PANEL_ACTIONS; i++) {
        Rect b = r_panel_action(i);
        int hot = rect_has(b, U.mx, U.my);
        if (hot) gfx_fill(b, U.input);
        Color ink = hot ? U.text : U.muted;
        if (i == 0) gfx_icon(ICON_ADD, b, S(16), ink);
        else if (i == 2) gfx_icon(ICON_CLOSE, b, S(16), ink);
        /* aside: a line at the foot; back: the outline of the window */
        else if (!U.float_min) gfx_fill((Rect){ b.x + (b.w - S(10)) / 2, b.y + b.h / 2 + S(3), S(10), S(1) > 0 ? S(1) : 1 }, ink);
        else gfx_frame((Rect){ b.x + (b.w - S(10)) / 2, b.y + (b.h - S(8)) / 2, S(10), S(8) }, ink);
    }
    gfx_unclip();

    Term *t = cur_term();
    if (!t || U.float_min) return;
    gfx_clip((Rect){ p.x, g.y, p.w, p.h - S(TERM_HEAD) - S(4) });
    VTermPos sa, sb; int sel = term_sel_range(t, &sa, &sb);
    int base_off = (U.line_h - U.font_px) / 2 + U.asc_mono;
    for (int r = 0; r < t->rows; r++) {
        int row = r - t->view, y = g.y + r * U.line_h;
        if (y >= g.y + g.h) break;
        for (int c = 0; c < t->cols; c++) {
            VTermScreenCell cell;
            if (!term_cell(t, row, c, &cell)) continue;
            if (cell.chars[0] == (uint32_t)-1) continue;
            int x = g.x + c * U.cell_w, w = U.cell_w * (cell.width > 1 ? cell.width : 1);
            Color fg = term_color(t, cell.fg, 0), bg = term_color(t, cell.bg, 1);
            if (cell.attrs.reverse) { Color s = fg; fg = bg; bg = s; }
            if (cell.attrs.bold && VTERM_COLOR_IS_INDEXED(&cell.fg) && cell.fg.indexed.idx < 8 && !cell.attrs.reverse) { VTermColor hi = cell.fg; hi.indexed.idx += 8; fg = term_color(t, hi, 0); }
            int in_sel = sel && (row > sa.row || (row == sa.row && c >= sa.col)) && (row < sb.row || (row == sb.row && c < sb.col));
            if (in_sel) bg = mix(bg, U.primary, 110);
            if (bg != U.bg) gfx_fill((Rect){ x, y, w, U.line_h }, bg);
            if (cell.attrs.conceal) continue;
            for (int k = 0; k < VTERM_MAX_CHARS_PER_CELL && cell.chars[k]; k++) {
                if (cell.chars[k] == ' ') continue;
                Glyph *gl = glyph_get(FACE_MONO, U.font_px, (int)cell.chars[k]);
                glyph_draw(gl, x, y + base_off, fg);
                if (cell.attrs.bold) glyph_draw(gl, x + 1, y + base_off, fg);
            }
            if (cell.attrs.underline) gfx_fill((Rect){ x, y + base_off + S(2), w, S(1) }, fg);
            if (cell.attrs.strike) gfx_fill((Rect){ x, y + U.line_h / 2, w, S(1) }, fg);
        }
    }
    /* the cursor */
    if (t->cursor_visible && t->view == 0 && t->cursor.row >= 0 && t->cursor.row < t->rows) {
        int x = g.x + t->cursor.col * U.cell_w, y = g.y + t->cursor.row * U.line_h;
        int focused = U.focused && U.focus == FOCUS_TERM && U.overlay == OV_NONE;
        if (!focused) gfx_frame((Rect){ x, y, U.cell_w, U.line_h }, U.muted);
        else if (!U.caret_on) { }
        else if (t->cursor_shape == VTERM_PROP_CURSORSHAPE_BAR_LEFT) gfx_fill((Rect){ x, y + S(2), S(2), U.line_h - S(4) }, U.primary);
        else if (t->cursor_shape == VTERM_PROP_CURSORSHAPE_UNDERLINE) gfx_fill((Rect){ x, y + U.line_h - S(3), U.cell_w, S(2) }, U.primary);
        else {
            gfx_fill((Rect){ x, y, U.cell_w, U.line_h }, U.primary);
            VTermScreenCell cell;
            if (vterm_screen_get_cell(t->vts, t->cursor, &cell) && cell.chars[0] && cell.chars[0] != (uint32_t)-1)
                glyph_draw(glyph_get(FACE_MONO, U.font_px, (int)cell.chars[0]), x, y + base_off, U.on_primary);
        }
    }
    gfx_unclip();
    if (t->sb_n) draw_scrollbar((Rect){ p.x + p.w - bar_w(), g.y, bar_w(), g.h }, t->sb_n + t->rows, t->rows, t->sb_n - t->view, 1);
    if (t->view) {
        char n[48]; snprintf(n, sizeof n, "-%d", t->view);
        int w = gfx_text_width(FACE_UI, S(11), n, -1) + S(12);
        Rect b = { p.x + p.w - bar_w() - w - S(6), g.y + S(4), w, S(18) };
        gfx_fill(b, U.input); gfx_frame(b, U.border);
        gfx_text(FACE_UI, S(11), b.x + S(6), b.y + (b.h - S(11)) / 2 + font_ascent(FACE_UI, S(11)), n, -1, U.muted);
    }
}

/* ---- the panel as a whole ------------------------------------------------------ */

static void panel_toggle(void) {
    if (!U.nterms) { term_open(); return; }
    if (U.panel_on && U.focus == FOCUS_TERM && !U.float_min) { U.panel_on = 0; U.focus = FOCUS_EDITOR; }
    else { U.panel_on = 1; U.float_min = 0; U.focus = FOCUS_TERM; }
    U.shown_doc = NULL; U.redraw = 1;
    term_resize_all();
    session_save();
}

static void panel_hide(void) { U.panel_on = 0; if (U.focus == FOCUS_TERM) U.focus = FOCUS_EDITOR; U.shown_doc = NULL; U.redraw = 1; session_save(); }

/* The Terminal button of the status bar: shows the panel (a shell in it if there is none) or hides it. */
static void panel_button(void) {
    if (!U.nterms) { term_open(); session_save(); return; }
    if (panel_h() && !U.float_min) { panel_hide(); return; }
    U.panel_on = 1; U.float_min = 0; U.focus = FOCUS_TERM; U.shown_doc = NULL; U.redraw = 1;
    term_resize_all();
    session_save();
}

/* A click in the panel. Returns 1 when it was handled. */
static int panel_mouse_button(int button, int down, int x, int y, int mods, int clicks) {
    Rect p = r_panel();
    if (!p.h) return 0;
    if (!down) return 0;
    if (!rect_has(p, x, y)) return 0;
    if (button == 0 && !U.float_min && rect_has(r_panel_corner(), x, y)) { U.drag = DRAG_PANEL; return 1; }
    Rect head = r_panel_head();
    if (rect_has(head, x, y)) {
        for (int i = 0; i < PANEL_ACTIONS; i++) if (rect_has(r_panel_action(i), x, y)) {
            if (i == 0) term_open();
            else if (i == 2) panel_hide();
            else { U.float_min = !U.float_min; if (U.float_min && U.focus == FOCUS_TERM) U.focus = FOCUS_EDITOR; U.shown_doc = NULL; U.redraw = 1; term_resize_all(); session_save(); }
            return 1;
        }
        int tx = head.x;
        for (int i = 0; i < U.nterms && x < r_panel_action(0).x - S(4); i++) {
            int w = tab_w_term(U.terms[i]);
            if (x >= tx && x < tx + w) {
                if (button == 1 || rect_has(r_tab_close(head, tx, w), x, y)) term_close(i);
                else { U.active_term = i; U.focus = FOCUS_TERM; U.shown_doc = NULL; }
                return 1;
            }
            tx += w;
        }
        if (!U.float_min) U.focus = FOCUS_TERM;
        return 1;
    }
    Term *t = cur_term();
    if (!t) return 1;
    U.focus = FOCUS_TERM; U.blink_at = now_ms(); U.caret_on = 1;
    term_mouse_button(t, button, down, x, y, mods, clicks);
    return 1;
}

/* Keys the panel keeps for itself while a terminal has the focus; everything else goes to the shell. */
static int panel_key(int key, int mods) {
    int ctrl = mods & (M_CTRL | M_META), shift = mods & M_SHIFT;
    Term *t = cur_term();
    if (ctrl && (key == '`' || key == 'J') && !shift) { panel_toggle(); return 1; }
    if (ctrl && shift && (key == '`' || key == '~' || key == 'T')) { term_open(); return 1; }
    if (!t || U.focus != FOCUS_TERM) return 0;
    if (ctrl && shift && key == 'C') { term_copy(t); return 1; }
    if (ctrl && shift && key == 'W') { term_close(U.active_term); return 1; }
    if (ctrl && key == 'C' && t->sel_on) { term_copy(t); return 1; }
    if (ctrl && (key == 'P' || key == 'B' || (key == 'E' && shift) || key == K_TAB || key == K_PGUP || key == K_PGDN || key == '=' || key == '+' || key == '-' || key == '0')) return 0;
    term_key(t, key, mods);
    return 1;
}
