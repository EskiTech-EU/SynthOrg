/*
 * ui — the editor itself: file tree, tabs, text view, command bar, status bar.
 *
 * Everything is drawn from state on every frame that needs one; gfx sends the
 * host only the pixels that actually changed. Nothing here knows about the
 * host: input arrives as events, output is the framebuffer.
 */

enum { K_LEFT = 1, K_RIGHT, K_UP, K_DOWN, K_HOME, K_END, K_PGUP, K_PGDN, K_BACKSPACE, K_DELETE, K_ENTER, K_TAB, K_ESCAPE, K_INSERT, K_F1 = 21 };
enum { M_SHIFT = 1, M_CTRL = 2, M_ALT = 4, M_META = 8 };
enum { OV_NONE, OV_FIND, OV_REPLACE, OV_GOTO, OV_QUICK, OV_NEW_FILE, OV_NEW_DIR, OV_RENAME, OV_DELETE, OV_CLOSE_DIRTY };
enum { DRAG_NONE, DRAG_SELECT, DRAG_VSCROLL, DRAG_HSCROLL, DRAG_SIDEBAR, DRAG_TREE_SCROLL, DRAG_PANEL, DRAG_TERM_SELECT, DRAG_TREE_PENDING, DRAG_TREE_MOVE, DRAG_PANEL_MOVE };
enum { FOCUS_EDITOR, FOCUS_TREE, FOCUS_TERM };

#define MAX_DOCS 64
#define STATE_DIR "/var/lib/synthorg-editor"

typedef struct Node {
    char *name, *path;
    int is_dir, expanded, loaded, depth;
    time_t mtime;
    struct Node **kids; int nkids;
    struct Node *parent;
} Node;

typedef struct { char text[1024]; int len, caret, fresh; } Field;

/* A line of the right-click menu; act 0 is a separator. */
typedef struct { int act; const char *label, *keys; int off; } MenuItem;
enum { MENU_NONE, MENU_TREE, MENU_TEXT, MENU_TERM };
#define MENU_MAX 12

static struct {
    char root[PATH_MAX];
    char title[512];                            /* the project's name, over the tree; else the folder's */
    int scale100, zoom;                         /* device scale and font zoom step */
    int font_px, ui_px, line_h, cell_w, asc_mono, asc_ui;
    int sidebar_w, sidebar_on;                  /* logical pixels */
    int host_files;                             /* the host shows the project's files in a column of its own: the tree here stays closed (IN_TREE) */
    int focus, focused;
    Doc *docs[MAX_DOCS]; int ndocs, active;
    struct Term *terms[8]; int nterms, active_term;  /* the terminal panel, see term.c */
    int panel_on, panel_h;                      /* logical pixels */
    /* The panel is a section under the editor, as wide as it: `float_min` is whether it is folded to its bar. (The
       others are from when it was a window over the editor: read from an old session, no longer used.) */
    int float_x, float_y, float_w, float_min, float_dx, float_dy;
    Node *tree; Node **rows; int nrows, rows_cap; int tree_scroll; char sel_path[PATH_MAX];
    int tree_inset;                             /* device pixels left empty over the tree: the host draws there (IN_INSET) */
    int overlay; Field field, field2; int field_active; int find_case;
    int menu, menu_n, menu_hot; Rect menu_box; MenuItem menu_items[MENU_MAX];   /* the right-click menu, see menu_open */
    char **quick; int nquick; int *quick_hit; int nquick_hit, quick_sel;
    char pending_path[PATH_MAX]; int pending_doc;
    char *clip; int clip_len; char *host_clip; int internal_newer;
    int mx, my, drag, drag_off, clicks;
    /* a file or folder dragged in the tree: where it came from, where it would land */
    char drag_path[PATH_MAX], drop_dir[PATH_MAX], hover_path[PATH_MAX]; int drag_x, drag_y, drop_ok; long hover_at;
    char toast[256]; long toast_until;
    long blink_at; int caret_on;
    long last_watch;
    int italian;
    int redraw;
    /* what the previous frame showed, to turn a pure scroll into a copy */
    Doc *shown_doc; int shown_scroll_y; Rect shown_text;
    /* theme */
    int dark;
    Color bg, surface, input, text, muted, primary, on_primary, border;
    Color syn[T_COUNT];
} U;

#define S(v) (((v) * U.scale100 + 50) / 100)
#define TR(it, en) (U.italian ? (it) : (en))

static Doc *cur(void) { return U.ndocs ? U.docs[U.active] : NULL; }
static void term_resize_all(void);
static void term_theme_all(void);
/* The user changed the project by hand (a save, a new file, a move, a delete): the service records it as a step.
 * Only the fact travels, as a line in a file of this container the service follows (projects.js watchChanges). */
static void note_change(void) {
    int fd = open("/tmp/.synthorg-run/events", O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (fd < 0) return;
    if (write(fd, "change\n", 7) != 7) { }
    close(fd);
}
static void toast(const char *msg) { snprintf(U.toast, sizeof U.toast, "%s", msg); U.toast_until = now_ms() + 3500; U.redraw = 1; }

/* ---- theme and metrics --------------------------------------------------- */

static Color mix(Color a, Color b, unsigned t) { return blend(a, b, t); }

static void theme_apply(void) {
    term_theme_all();
    static const unsigned char DARK[T_COUNT][3] = {
        {0,0,0}, {106,115,125}, {158,203,141}, {245,169,127}, {198,160,246}, {125,196,228}, {138,173,244}, {147,154,183}, {238,153,160} };
    static const unsigned char LIGHT[T_COUNT][3] = {
        {0,0,0}, {122,130,138}, {40,125,60}, {180,90,20}, {130,60,190}, {10,110,150}, {30,90,200}, {90,98,120}, {190,50,80} };
    for (int i = 0; i < T_COUNT; i++) {
        const unsigned char *c = U.dark ? DARK[i] : LIGHT[i];
        U.syn[i] = RGB(c[0], c[1], c[2]);
    }
    U.syn[T_TEXT] = U.text;
}

static void theme_default(void) {
    U.dark = 1;
    U.bg = RGB(17, 18, 23); U.surface = RGB(24, 25, 32); U.input = RGB(32, 34, 43);
    U.text = RGB(214, 218, 230); U.muted = RGB(134, 140, 160); U.primary = RGB(167, 139, 250);
    U.on_primary = RGB(20, 16, 36); U.border = RGB(44, 46, 58);
    theme_apply();
}

static void metrics_update(void) {
    U.font_px = S(14 + U.zoom);
    if (U.font_px < 8) U.font_px = 8;
    U.ui_px = S(13);
    U.line_h = (U.font_px * 3 + 1) / 2;
    U.cell_w = glyph_get(FACE_MONO, U.font_px, 'M')->advance;
    if (U.cell_w < 1) U.cell_w = 1;
    U.asc_mono = font_ascent(FACE_MONO, U.font_px);
    U.asc_ui = font_ascent(FACE_UI, U.ui_px);
    term_resize_all();
}

/* ---- layout --------------------------------------------------------------- */

static int side_w(void) { return U.sidebar_on ? S(U.sidebar_w) : 0; }
/* The tabs are the host's when it shows the files itself (IN_TREE): its bar lists what is open here. */
static int tabs_h(void) { return U.host_files ? 0 : S(36); }
static int status_h(void) { return S(24); }
static int row_h(void) { return S(24); }
/* Where the tree's rows start: under the title and whatever the host put between the two. */
static int tree_top(void) { return tabs_h() + U.tree_inset; }
static Rect r_sidebar(void) { return (Rect){ 0, 0, side_w(), G.h - status_h() }; }
static Rect r_tabs(void) { return (Rect){ side_w(), 0, G.w - side_w(), tabs_h() }; }
static int panel_h(void) { return U.panel_on && U.nterms ? S(U.panel_h) : 0; }
static int dock_h(void);                     /* what the panel takes under the editor, see term.c */
static Rect r_editor(void) { return (Rect){ side_w(), tabs_h(), G.w - side_w(), G.h - tabs_h() - status_h() - dock_h() }; }
static Rect r_status(void) { return (Rect){ 0, G.h - status_h(), G.w, status_h() }; }
static int bar_w(void) { return S(12); }

static int digits(int n) { int d = 1; while (n >= 10) { n /= 10; d++; } return d; }
static int gutter_w(Doc *d) { return (digits(d->n) + 3) * U.cell_w; }
static Rect r_text(Doc *d) { Rect e = r_editor(); int g = gutter_w(d); return (Rect){ e.x + g, e.y, e.w - g - bar_w(), e.h - bar_w() }; }

/* ---- columns: bytes <-> cells -------------------------------------------- */

#define TAB_CELLS 4
static int vis_col(Line *l, int col) {
    int v = 0;
    for (int i = 0; i < col && i < l->len;) {
        int cp = utf8_next(l->s, l->len, &i);
        v += cp == '\t' ? TAB_CELLS - v % TAB_CELLS : 1;
    }
    return v;
}
static int col_from_vis(Line *l, int want) {
    int v = 0, i = 0;
    while (i < l->len) {
        int j = i, cp = utf8_next(l->s, l->len, &j);
        int w = cp == '\t' ? TAB_CELLS - v % TAB_CELLS : 1;
        if (v + w > want) return (want - v) * 2 >= w ? j : i;
        v += w; i = j;
    }
    return l->len;
}
static int doc_max_cells(Doc *d, int from, int to) {
    int m = 0;
    for (int i = from; i < to && i < d->n; i++) { int v = vis_col(&d->ln[i], d->ln[i].len); if (v > m) m = v; }
    return m;
}

/* ---- scrolling ------------------------------------------------------------ */

static int max_scroll_y(Doc *d) { int m = d->n * U.line_h - r_text(d).h / 2; return m < 0 ? 0 : m; }
static void clamp_scroll(Doc *d) {
    if (d->scroll_y > max_scroll_y(d)) d->scroll_y = max_scroll_y(d);
    if (d->scroll_y < 0) d->scroll_y = 0;
    if (d->scroll_x < 0) d->scroll_x = 0;
}
static void reveal_caret(Doc *d) {
    Rect t = r_text(d);
    int y = d->caret.line * U.line_h;
    if (y < d->scroll_y) d->scroll_y = y;
    if (y + U.line_h > d->scroll_y + t.h) d->scroll_y = y + U.line_h - t.h;
    int x = vis_col(&d->ln[d->caret.line], d->caret.col) * U.cell_w;
    if (x < d->scroll_x) d->scroll_x = x - 4 * U.cell_w;
    if (x + 2 * U.cell_w > d->scroll_x + t.w) d->scroll_x = x + 6 * U.cell_w - t.w;
    clamp_scroll(d);
    U.blink_at = now_ms(); U.caret_on = 1;
}
static void center_caret(Doc *d) {
    d->scroll_y = d->caret.line * U.line_h - r_text(d).h / 2;
    clamp_scroll(d);
    reveal_caret(d);
}

/* ---- file tree ------------------------------------------------------------ */

static int node_cmp(const void *a, const void *b) {
    const Node *x = *(Node *const *)a, *y = *(Node *const *)b;
    if (x->is_dir != y->is_dir) return y->is_dir - x->is_dir;
    return strcasecmp(x->name, y->name);
}
static void node_free(Node *n) {
    for (int i = 0; i < n->nkids; i++) node_free(n->kids[i]);
    free(n->kids); free(n->name); free(n->path); free(n);
}
static Node *node_new(Node *parent, const char *name, const char *path, int is_dir) {
    Node *n = calloc(1, sizeof *n);
    n->name = strdup(name); n->path = strdup(path); n->is_dir = is_dir;
    n->parent = parent; n->depth = parent ? parent->depth + 1 : -1;
    return n;
}
static Node *node_kid(Node *n, const char *name) {
    for (int i = 0; i < n->nkids; i++) if (!strcmp(n->kids[i]->name, name)) return n->kids[i];
    return NULL;
}
/* (Re)reads a directory, keeping the expansion state of children that are still there. */
static void node_load(Node *n) {
    struct stat st;
    if (stat(n->path, &st) == 0) n->mtime = st.st_mtime;
    DIR *dir = opendir(n->path);
    Node **kids = NULL; int count = 0, cap = 0;
    struct dirent *e;
    while (dir && (e = readdir(dir))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..") || strstr(e->d_name, ".synthorg-tmp")) continue;
        char path[PATH_MAX];
        if (snprintf(path, sizeof path, "%s/%s", n->path, e->d_name) >= (int)sizeof path) continue;
        if (lstat(path, &st) != 0) continue;
        int is_dir = S_ISDIR(st.st_mode);
        Node *old = node_kid(n, e->d_name), *kid;
        if (old && old->is_dir == is_dir) {
            kid = old;
            for (int i = 0; i < n->nkids; i++) if (n->kids[i] == old) { n->kids[i] = n->kids[--n->nkids]; break; }
        } else kid = node_new(n, e->d_name, path, is_dir);
        if (count == cap) { cap = cap ? cap * 2 : 32; kids = realloc(kids, (size_t)cap * sizeof *kids); }
        kids[count++] = kid;
    }
    if (dir) closedir(dir);
    for (int i = 0; i < n->nkids; i++) node_free(n->kids[i]);
    free(n->kids);
    qsort(kids, (size_t)count, sizeof *kids, node_cmp);
    n->kids = kids; n->nkids = count; n->loaded = 1;
}
static void tree_flatten(Node *n) {
    for (int i = 0; i < n->nkids; i++) {
        if (U.nrows == U.rows_cap) { U.rows_cap = U.rows_cap ? U.rows_cap * 2 : 256; U.rows = realloc(U.rows, (size_t)U.rows_cap * sizeof *U.rows); }
        U.rows[U.nrows++] = n->kids[i];
        if (n->kids[i]->is_dir && n->kids[i]->expanded) tree_flatten(n->kids[i]);
    }
}
static void tree_rows(void) { U.nrows = 0; tree_flatten(U.tree); }
/* Picks up changes made by anything else in the container (the agent, git, a build). */
static int tree_refresh(Node *n) {
    int changed = 0;
    struct stat st;
    if (n->loaded && stat(n->path, &st) == 0 && st.st_mtime != n->mtime) { node_load(n); changed = 1; }
    for (int i = 0; i < n->nkids; i++) if (n->kids[i]->is_dir && n->kids[i]->expanded) changed |= tree_refresh(n->kids[i]);
    return changed;
}
static Node *tree_find(Node *n, const char *path) {
    if (!strcmp(n->path, path)) return n;
    for (int i = 0; i < n->nkids; i++) {
        size_t len = strlen(n->kids[i]->path);
        if (!strncmp(n->kids[i]->path, path, len) && (path[len] == 0 || path[len] == '/')) {
            if (n->kids[i]->is_dir && !n->kids[i]->loaded) node_load(n->kids[i]);
            return tree_find(n->kids[i], path);
        }
    }
    return NULL;
}
static void tree_reveal(const char *path) {
    Node *n = tree_find(U.tree, path);
    if (!n) return;
    for (Node *p = n->parent; p && p != U.tree; p = p->parent) p->expanded = 1;
    snprintf(U.sel_path, sizeof U.sel_path, "%s", path);
}
static Node *tree_selected(void) { return U.sel_path[0] ? tree_find(U.tree, U.sel_path) : NULL; }
/* The folder a new entry goes into: the selected folder, or the selected file's folder. */
static const char *tree_target_dir(void) {
    Node *n = tree_selected();
    if (!n) return U.root;
    return n->is_dir ? n->path : n->parent->path;
}

/* ---- session: open tabs survive a restart, unsaved text is never lost ------ */

static void session_save(void) {
    mkdir(STATE_DIR, 0700);
    FILE *f = fopen(STATE_DIR "/session.tmp", "w");
    if (!f) return;
    fprintf(f, "sidebar %d %d\nzoom %d\npanel %d %d\n", U.sidebar_w, U.host_files ? 1 : U.sidebar_on, U.zoom, U.panel_h, U.panel_on);
    fprintf(f, "float %d %d %d %d\n", U.float_x, U.float_y, U.float_w, U.float_min);
    for (int i = 0; i < U.ndocs; i++) fprintf(f, "open %d %d %s\n", U.docs[i]->caret.line, U.docs[i]->scroll_y, U.docs[i]->path);
    fprintf(f, "active %d\n", U.active);
    for (int i = 0; i < U.nrows; i++) if (U.rows[i]->is_dir && U.rows[i]->expanded) fprintf(f, "expanded %s\n", U.rows[i]->path);
    fclose(f);
    rename(STATE_DIR "/session.tmp", STATE_DIR "/session");
}

static void recovery_write(void) {
    mkdir(STATE_DIR, 0700); mkdir(STATE_DIR "/recovery", 0700);
    DIR *dir = opendir(STATE_DIR "/recovery");
    struct dirent *e;
    while (dir && (e = readdir(dir))) if (e->d_name[0] != '.') { char p[PATH_MAX]; snprintf(p, sizeof p, STATE_DIR "/recovery/%s", e->d_name); unlink(p); }
    if (dir) closedir(dir);
    for (int i = 0; i < U.ndocs; i++) {
        Doc *d = U.docs[i];
        if (!d->dirty) continue;
        char p[PATH_MAX];
        snprintf(p, sizeof p, STATE_DIR "/recovery/%d.path", i);
        FILE *f = fopen(p, "w"); if (!f) continue;
        fputs(d->path, f); fclose(f);
        snprintf(p, sizeof p, STATE_DIR "/recovery/%d.text", i);
        f = fopen(p, "w"); if (!f) continue;
        for (int l = 0; l < d->n; l++) { fwrite(d->ln[l].s, 1, (size_t)d->ln[l].len, f); if (l + 1 < d->n) fputc('\n', f); }
        fclose(f);
    }
}

/* ---- documents ------------------------------------------------------------- */

static int open_path(const char *path) {
    for (int i = 0; i < U.ndocs; i++) if (!strcmp(U.docs[i]->path, path)) { U.active = i; U.focus = FOCUS_EDITOR; U.redraw = 1; return 1; }
    if (U.ndocs == MAX_DOCS) { toast(TR("Troppi file aperti", "Too many open files")); return 0; }
    char err[256];
    Doc *d = doc_open(path, err, sizeof err);
    if (!d) { char msg[512]; snprintf(msg, sizeof msg, "%s: %s", strrchr(path, '/') ? strrchr(path, '/') + 1 : path, err); toast(msg); return 0; }
    d->lang = syntax_detect(d->name);
    U.docs[U.ndocs] = d; U.active = U.ndocs++;
    U.focus = FOCUS_EDITOR; U.redraw = 1;
    session_save();
    return 1;
}

/* The host has the files of the project in a column of its own (IN_TREE): the tree here is closed, and stays so. */
static void ui_host_files(int on) {
    U.host_files = on;
    if (on) { U.sidebar_on = 0; if (U.focus == FOCUS_TREE) U.focus = FOCUS_EDITOR; }
    U.shown_doc = NULL; U.redraw = 1;
}

/* A file of the project, named by the host by its place in it (IN_FILE): opened in a tab. Never a place outside the project. */
static void ui_open_rel(const char *rel, int len) {
    char path[PATH_MAX];
    if (len <= 0 || len >= PATH_MAX - (int)strlen(U.root) - 2 || rel[0] == '/') return;
    for (int i = 0; i < len; i++) {
        if (rel[i] == 0) return;
        if (rel[i] == '.' && i + 1 < len && rel[i + 1] == '.' && (i == 0 || rel[i - 1] == '/') && (i + 2 == len || rel[i + 2] == '/')) return;
    }
    snprintf(path, sizeof path, "%s/%.*s", U.root, len, rel);
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) { toast(TR("Il file non c'è più", "The file is no longer there")); return; }
    if (open_path(path)) U.shown_doc = NULL;
}

static void close_doc(int index) {
    doc_free(U.docs[index]);
    memmove(U.docs + index, U.docs + index + 1, (size_t)(U.ndocs - index - 1) * sizeof(Doc *));
    U.ndocs--;
    if (U.active >= U.ndocs) U.active = U.ndocs ? U.ndocs - 1 : 0;
    else if (U.active > index) U.active--;
    U.shown_doc = NULL;
    U.redraw = 1;
    session_save();
}

static void save_doc(Doc *d) {
    char err[256];
    if (d->readonly) { toast(TR("File di sola lettura", "Read-only file")); return; }
    if (!doc_save(d, err, sizeof err)) { char msg[512]; snprintf(msg, sizeof msg, "%s: %s", TR("Salvataggio non riuscito", "Save failed"), err); toast(msg); }
    else note_change();
    U.redraw = 1;
}

/* Indentation of the file as it is: tabs, or the smallest run of leading spaces. */
static char g_indent[9] = "    ";
static const char *indent_unit(Doc *d) {
    int tabs = 0, spaces = 0, smallest = 8;
    for (int i = 0; i < d->n && i < 400; i++) {
        Line *l = &d->ln[i];
        if (!l->len) continue;
        if (l->s[0] == '\t') tabs++;
        else if (l->s[0] == ' ') { int k = 0; while (k < l->len && l->s[k] == ' ') k++; if (k >= 2 && k < l->len) { spaces++; if (k < smallest) smallest = k; } }
    }
    if (tabs > spaces) return "\t";
    int n = spaces ? smallest : 4;
    if (n > 8) n = 8;
    memset(g_indent, ' ', (size_t)n); g_indent[n] = 0;
    return g_indent;
}

/* ---- editing commands ------------------------------------------------------ */

static void set_clip(const char *text, int len) {
    free(U.clip);
    U.clip = malloc((size_t)len + 1);
    memcpy(U.clip, text, (size_t)len); U.clip[len] = 0;
    U.clip_len = len; U.internal_newer = 1;
}

static void ed_copy(Doc *d, int cut) {
    Pos a = pos_min(d->caret, d->anchor), b = pos_max(d->caret, d->anchor);
    if (!pos_cmp(a, b)) {                                   /* no selection: the whole line */
        a = (Pos){ d->caret.line, 0 };
        b = d->caret.line + 1 < d->n ? (Pos){ d->caret.line + 1, 0 } : (Pos){ d->caret.line, d->ln[d->caret.line].len };
    }
    int len; char *text = doc_range(d, a, b, &len);
    set_clip(text, len); free(text);
    if (cut) { doc_replace(d, a, b, "", 0, 0); reveal_caret(d); }
}

static void ed_insert(Doc *d, const char *text, int len, int typing) {
    doc_replace(d, d->caret, d->anchor, text, len, typing);
    reveal_caret(d);
}

static int leading_ws(Line *l) { int k = 0; while (k < l->len && (l->s[k] == ' ' || l->s[k] == '\t')) k++; return k; }

static void ed_newline(Doc *d) {
    Line *l = &d->ln[d->caret.line];
    int ws = leading_ws(l);
    if (ws > d->caret.col) ws = d->caret.col;
    char buf[1100]; int n = 0;
    buf[n++] = '\n';
    if (ws > 1000) ws = 1000;
    memcpy(buf + n, l->s, (size_t)ws); n += ws;
    int before = d->caret.col;
    while (before > 0 && l->s[before - 1] == ' ') before--;
    char prev = before > 0 ? l->s[before - 1] : 0, next = d->caret.col < l->len ? l->s[d->caret.col] : 0;
    int opens = prev == '{' || prev == '[' || prev == '(' || (prev == ':' && !strcmp(LANGS[d->lang].name, "Python"));
    const char *unit = indent_unit(d);
    if (opens) { int u = (int)strlen(unit); memcpy(buf + n, unit, (size_t)u); n += u; }
    int between = opens && ((prev == '{' && next == '}') || (prev == '[' && next == ']') || (prev == '(' && next == ')'));
    if (between && !doc_has_selection(d)) {
        int caret_off = n;
        buf[n++] = '\n'; memcpy(buf + n, l->s, (size_t)ws); n += ws;
        Pos start = d->caret;
        doc_replace(d, d->caret, d->anchor, buf, n, 0);
        d->caret = d->anchor = text_end(start, buf, caret_off);
        reveal_caret(d);
        return;
    }
    ed_insert(d, buf, n, 0);
}

static void ed_type(Doc *d, const char *text, int len) {
    if (len == 1 && !doc_has_selection(d)) {
        Line *l = &d->ln[d->caret.line];
        char c = text[0], next = d->caret.col < l->len ? l->s[d->caret.col] : 0;
        const char *closers = ")]}\"'`";
        if (strchr(closers, c) && next == c) {            /* type over the closer we inserted */
            d->caret.col++; d->anchor = d->caret; reveal_caret(d); return;
        }
        const char *opens = "([{\"'`", *close = ")]}\"'`", *p = strchr(opens, c);
        int quote = c == '"' || c == '\'' || c == '`';
        int prev_word = d->caret.col > 0 && is_word_byte((unsigned char)l->s[d->caret.col - 1]);
        /* An odd number of this quote before the caret means this one closes a string. */
        int closing = 0;
        if (quote) for (int k = 0; k < d->caret.col; k++) if (l->s[k] == c && (k == 0 || l->s[k - 1] != '\\')) closing ^= 1;
        if (p && (next == 0 || isspace((unsigned char)next) || strchr(")]},;", next)) && !(quote && (prev_word || closing))) {
            char pair[2] = { c, close[p - opens] };
            doc_replace(d, d->caret, d->anchor, pair, 2, 1);
            d->caret.col--; d->anchor = d->caret; reveal_caret(d);
            return;
        }
    }
    ed_insert(d, text, len, 1);
}

static void ed_backspace(Doc *d, int word) {
    if (doc_has_selection(d)) { ed_insert(d, "", 0, 0); return; }
    Pos a = d->caret;
    if (word) a = doc_word_left(d, a);
    else if (a.col > 0) {
        Line *l = &d->ln[a.line];
        int ws = leading_ws(l), unit = (int)strlen(indent_unit(d));
        if (a.col <= ws && l->s[a.col - 1] == ' ' && unit > 1 && a.col % unit == 0 && a.col >= unit) a.col -= unit;   /* one indent level */
        else {
            char prev = l->s[a.col - 1], next = a.col < l->len ? l->s[a.col] : 0;
            const char *opens = "([{\"'`", *close = ")]}\"'`", *p = prev ? strchr(opens, prev) : NULL;
            a.col = utf8_prev_start(l->s, a.col);
            if (p && next == close[p - opens]) { Pos b = d->caret; b.col++; doc_replace(d, a, b, "", 0, 1); reveal_caret(d); return; }
        }
    } else if (a.line > 0) { a.line--; a.col = d->ln[a.line].len; }
    doc_replace(d, a, d->caret, "", 0, 1);
    reveal_caret(d);
}

static void ed_delete(Doc *d, int word) {
    if (doc_has_selection(d)) { ed_insert(d, "", 0, 0); return; }
    Pos b = d->caret;
    if (word) b = doc_word_right(d, b);
    else if (b.col < d->ln[b.line].len) { int i = b.col; utf8_next(d->ln[b.line].s, d->ln[b.line].len, &i); b.col = i; }
    else if (b.line + 1 < d->n) { b.line++; b.col = 0; }
    doc_replace(d, d->caret, b, "", 0, 1);
    reveal_caret(d);
}

/* Lines touched by the selection; a selection ending at column 0 does not include that line. */
static void sel_lines(Doc *d, int *first, int *last) {
    Pos a = pos_min(d->caret, d->anchor), b = pos_max(d->caret, d->anchor);
    *first = a.line; *last = b.line;
    if (b.line > a.line && b.col == 0) (*last)--;
}

static void ed_indent(Doc *d, int out) {
    int first, last; sel_lines(d, &first, &last);
    const char *unit = indent_unit(d); int ulen = (int)strlen(unit);
    if (!out && !doc_has_selection(d)) {
        if (unit[0] == '\t') { ed_insert(d, "\t", 1, 1); return; }
        int v = vis_col(&d->ln[d->caret.line], d->caret.col), n = ulen - v % ulen;
        ed_insert(d, "        ", n, 1); return;
    }
    Pos caret = d->caret, anchor = d->anchor;
    d->group++; unsigned group = d->group;
    for (int l = first; l <= last; l++) {
        Line *ln = &d->ln[l];
        if (!out) { if (!ln->len) continue; doc_replace(d, (Pos){ l, 0 }, (Pos){ l, 0 }, unit, ulen, 0); if (caret.line == l) caret.col += ulen; if (anchor.line == l) anchor.col += ulen; }
        else {
            int k = 0;
            if (ln->len && ln->s[0] == '\t') k = 1; else while (k < ulen && k < ln->len && ln->s[k] == ' ') k++;
            if (!k) continue;
            doc_replace(d, (Pos){ l, 0 }, (Pos){ l, k }, "", 0, 0);
            if (caret.line == l) caret.col = caret.col > k ? caret.col - k : 0;
            if (anchor.line == l) anchor.col = anchor.col > k ? anchor.col - k : 0;
        }
        d->undo[d->nundo - 1].group = group; d->group = group;
    }
    d->caret = doc_clamp(d, caret); d->anchor = doc_clamp(d, anchor);
    doc_break_undo(d); reveal_caret(d);
}

static void ed_toggle_comment(Doc *d) {
    const char *mark = LANGS[d->lang].line;
    if (!mark) return;
    int first, last; sel_lines(d, &first, &last);
    int mlen = (int)strlen(mark), all = 1, indent = 1 << 30;
    for (int l = first; l <= last; l++) {
        Line *ln = &d->ln[l]; int ws = leading_ws(ln);
        if (ws == ln->len) continue;
        if (ws < indent) indent = ws;
        if (!starts(ln->s, ln->len, ws, mark)) all = 0;
    }
    if (indent == 1 << 30) return;
    Pos caret = d->caret, anchor = d->anchor;
    d->group++; unsigned group = d->group;
    for (int l = first; l <= last; l++) {
        Line *ln = &d->ln[l]; int ws = leading_ws(ln);
        if (ws == ln->len) continue;
        int delta;
        if (all) {
            int n = mlen + (ws + mlen < ln->len && ln->s[ws + mlen] == ' ' ? 1 : 0);
            doc_replace(d, (Pos){ l, ws }, (Pos){ l, ws + n }, "", 0, 0); delta = -n;
        } else {
            char buf[16]; int n = snprintf(buf, sizeof buf, "%s ", mark);
            doc_replace(d, (Pos){ l, indent }, (Pos){ l, indent }, buf, n, 0); delta = n;
        }
        d->undo[d->nundo - 1].group = group; d->group = group;
        if (caret.line == l) caret.col += delta;
        if (anchor.line == l) anchor.col += delta;
    }
    d->caret = doc_clamp(d, caret); d->anchor = doc_clamp(d, anchor);
    doc_break_undo(d); reveal_caret(d);
}

static void ed_move_lines(Doc *d, int dir) {
    int first, last; sel_lines(d, &first, &last);
    if ((dir < 0 && first == 0) || (dir > 0 && last + 1 >= d->n)) return;
    Pos caret = d->caret, anchor = d->anchor;
    int len; char *block = doc_range(d, (Pos){ first, 0 }, (Pos){ last, d->ln[last].len }, &len);
    d->group++; unsigned group = d->group;
    if (dir < 0) {
        int olen; char *other = doc_range(d, (Pos){ first - 1, 0 }, (Pos){ first - 1, d->ln[first - 1].len }, &olen);
        char *text = malloc((size_t)len + olen + 2);
        memcpy(text, block, (size_t)len); text[len] = '\n'; memcpy(text + len + 1, other, (size_t)olen);
        doc_replace(d, (Pos){ first - 1, 0 }, (Pos){ last, d->ln[last].len }, text, len + olen + 1, 0);
        free(text); free(other);
    } else {
        int olen; char *other = doc_range(d, (Pos){ last + 1, 0 }, (Pos){ last + 1, d->ln[last + 1].len }, &olen);
        char *text = malloc((size_t)len + olen + 2);
        memcpy(text, other, (size_t)olen); text[olen] = '\n'; memcpy(text + olen + 1, block, (size_t)len);
        doc_replace(d, (Pos){ first, 0 }, (Pos){ last + 1, d->ln[last + 1].len }, text, len + olen + 1, 0);
        free(text); free(other);
    }
    d->undo[d->nundo - 1].group = group;
    free(block);
    caret.line += dir; anchor.line += dir;
    d->caret = doc_clamp(d, caret); d->anchor = doc_clamp(d, anchor);
    doc_break_undo(d); reveal_caret(d);
}

static void ed_duplicate(Doc *d) {
    int first, last; sel_lines(d, &first, &last);
    int len; char *block = doc_range(d, (Pos){ first, 0 }, (Pos){ last, d->ln[last].len }, &len);
    char *text = malloc((size_t)len + 2);
    text[0] = '\n'; memcpy(text + 1, block, (size_t)len);
    Pos caret = d->caret, anchor = d->anchor; int shift = last - first + 1;
    doc_replace(d, (Pos){ last, d->ln[last].len }, (Pos){ last, d->ln[last].len }, text, len + 1, 0);
    caret.line += shift; anchor.line += shift;
    d->caret = doc_clamp(d, caret); d->anchor = doc_clamp(d, anchor);
    free(text); free(block); reveal_caret(d);
}

static void ed_delete_lines(Doc *d) {
    int first, last; sel_lines(d, &first, &last);
    Pos a = { first, 0 }, b = last + 1 < d->n ? (Pos){ last + 1, 0 } : (Pos){ last, d->ln[last].len };
    if (last + 1 >= d->n && first > 0) a = (Pos){ first - 1, d->ln[first - 1].len };
    doc_replace(d, a, b, "", 0, 0);
    d->caret.col = 0; d->caret = d->anchor = doc_clamp(d, d->caret);
    reveal_caret(d);
}

/* ---- find ------------------------------------------------------------------ */

static int find_in_line(Line *l, const char *q, int qlen, int from, int fold) {
    for (int i = from; i + qlen <= l->len; i++)
        if (fold ? !strncasecmp(l->s + i, q, (size_t)qlen) : !memcmp(l->s + i, q, (size_t)qlen)) return i;
    return -1;
}
static int find_next(Doc *d, const char *q, int dir, int from_caret_end) {
    int qlen = (int)strlen(q);
    if (!qlen) return 0;
    int fold = !U.find_case;
    Pos start = dir > 0 ? (from_caret_end ? pos_max(d->caret, d->anchor) : pos_min(d->caret, d->anchor)) : pos_min(d->caret, d->anchor);
    for (int step = 0; step <= d->n; step++) {
        int l = ((start.line + dir * step) % d->n + d->n) % d->n;
        Line *ln = &d->ln[l];
        int found = -1;
        if (dir > 0) found = find_in_line(ln, q, qlen, step == 0 ? start.col : 0, fold);
        else {
            int limit = step == 0 ? start.col - 1 : ln->len;
            for (int i = 0; (i = find_in_line(ln, q, qlen, i, fold)) >= 0 && i + qlen <= limit + (step == 0 ? 0 : qlen); i++) { if (step == 0 && i >= start.col) break; found = i; }
        }
        if (found >= 0) { d->anchor = (Pos){ l, found }; d->caret = (Pos){ l, found + qlen }; d->want_x = -1; center_caret(d); return 1; }
    }
    return 0;
}
static int replace_all(Doc *d, const char *q, const char *with) {
    int qlen = (int)strlen(q), wlen = (int)strlen(with), count = 0, fold = !U.find_case;
    if (!qlen) return 0;
    d->group++; unsigned group = d->group;
    for (int l = 0; l < d->n; l++)
        for (int i = 0; (i = find_in_line(&d->ln[l], q, qlen, i, fold)) >= 0; i += wlen) {
            doc_replace(d, (Pos){ l, i }, (Pos){ l, i + qlen }, with, wlen, 0);
            d->undo[d->nundo - 1].group = group; d->group = group;
            count++;
        }
    doc_break_undo(d);
    return count;
}

/* ---- quick open ------------------------------------------------------------ */

static void quick_scan(const char *dir, int depth) {
    if (depth > 12 || U.nquick >= 20000) return;
    DIR *d = opendir(dir);
    struct dirent *e;
    while (d && (e = readdir(d))) {
        if (e->d_name[0] == '.' && (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..") || !strcmp(e->d_name, ".git"))) continue;
        if (!strcmp(e->d_name, "node_modules") || !strcmp(e->d_name, "target") || !strcmp(e->d_name, "__pycache__")) continue;
        char path[PATH_MAX]; struct stat st;
        if (snprintf(path, sizeof path, "%s/%s", dir, e->d_name) >= (int)sizeof path || lstat(path, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) quick_scan(path, depth + 1);
        else if (S_ISREG(st.st_mode) && U.nquick < 20000) {
            U.quick = realloc(U.quick, (size_t)(U.nquick + 1) * sizeof *U.quick);
            U.quick[U.nquick++] = strdup(path);
        }
    }
    if (d) closedir(d);
}
/* Subsequence match; consecutive and word-start hits score higher, shorter paths win ties. */
static int fuzzy(const char *path, const char *q) {
    const char *name = strrchr(path, '/'); name = name ? name + 1 : path;
    int score = 0, run = 0; const char *p = path + strlen(U.root);
    for (; *q; q++) {
        const char *hit = NULL;
        for (const char *c = p; *c; c++) if (tolower((unsigned char)*c) == tolower((unsigned char)*q)) { hit = c; break; }
        if (!hit) return -1;
        run = hit == p ? run + 1 : 0;
        score += 1 + run * 3 + (hit >= name ? 4 : 0) + ((hit == path || hit[-1] == '/' || hit[-1] == '_' || hit[-1] == '-' || hit[-1] == '.') ? 5 : 0);
        p = hit + 1;
    }
    return score * 100 - (int)strlen(path);
}
static const char *g_quick_query;
static int quick_cmp(const void *a, const void *b) { return fuzzy(U.quick[*(const int *)b], g_quick_query) - fuzzy(U.quick[*(const int *)a], g_quick_query); }
static void quick_filter(void) {
    U.quick_hit = realloc(U.quick_hit, (size_t)(U.nquick + 1) * sizeof(int));
    U.nquick_hit = 0;
    for (int i = 0; i < U.nquick; i++) if (fuzzy(U.quick[i], U.field.text) >= 0) U.quick_hit[U.nquick_hit++] = i;
    g_quick_query = U.field.text;
    if (U.field.len) qsort(U.quick_hit, (size_t)U.nquick_hit, sizeof(int), quick_cmp);
    U.quick_sel = 0;
}

/* ---- the command bar -------------------------------------------------------- */

static void field_set(Field *f, const char *text) { snprintf(f->text, sizeof f->text, "%s", text); f->len = (int)strlen(f->text); f->caret = f->len; f->fresh = f->len > 0; }
static void field_insert(Field *f, const char *text, int len) {
    if (f->fresh) { f->len = f->caret = 0; f->fresh = 0; }
    for (int i = 0; i < len; i++) if (text[i] == '\n' || text[i] == '\r') { len = i; break; }
    if (f->len + len >= (int)sizeof f->text) return;
    memmove(f->text + f->caret + len, f->text + f->caret, (size_t)(f->len - f->caret));
    memcpy(f->text + f->caret, text, (size_t)len);
    f->len += len; f->caret += len; f->text[f->len] = 0;
}
static int field_key(Field *f, int key, int mods) {
    int was_fresh = f->fresh; f->fresh = 0;
    switch (key) {
    case K_LEFT: f->caret = utf8_prev_start(f->text, f->caret); return 1;
    case K_RIGHT: if (f->caret < f->len) utf8_next(f->text, f->len, &f->caret); return 1;
    case K_HOME: f->caret = 0; return 1;
    case K_END: f->caret = f->len; return 1;
    case K_BACKSPACE:
        if (was_fresh || (mods & M_CTRL)) { f->len = f->caret = 0; f->text[0] = 0; return 2; }
        if (f->caret > 0) { int a = utf8_prev_start(f->text, f->caret); memmove(f->text + a, f->text + f->caret, (size_t)(f->len - f->caret)); f->len -= f->caret - a; f->caret = a; f->text[f->len] = 0; }
        return 2;
    case K_DELETE:
        if (f->caret < f->len) { int b = f->caret; utf8_next(f->text, f->len, &b); memmove(f->text + f->caret, f->text + b, (size_t)(f->len - b)); f->len -= b - f->caret; f->text[f->len] = 0; }
        return 2;
    case 'A': if (mods & M_CTRL) { f->fresh = f->len > 0; f->caret = f->len; return 1; } break;
    }
    f->fresh = was_fresh;
    return 0;
}

static void overlay_open(int mode) {
    Doc *d = cur();
    if ((mode == OV_FIND || mode == OV_REPLACE || mode == OV_GOTO) && !d) return;
    U.overlay = mode; U.field_active = 0; U.redraw = 1;
    field_set(&U.field, ""); if (mode != OV_REPLACE) field_set(&U.field2, "");
    if ((mode == OV_FIND || mode == OV_REPLACE) && d) {
        Pos a = pos_min(d->caret, d->anchor), b = pos_max(d->caret, d->anchor);
        if (a.line == b.line && b.col > a.col && b.col - a.col < 200) { char buf[256]; memcpy(buf, d->ln[a.line].s + a.col, (size_t)(b.col - a.col)); buf[b.col - a.col] = 0; field_set(&U.field, buf); }
        else if (U.host_clip == NULL && U.field.len == 0) field_set(&U.field, "");
    }
    if (mode == OV_QUICK) {
        for (int i = 0; i < U.nquick; i++) free(U.quick[i]);
        U.nquick = 0; quick_scan(U.root, 0); quick_filter();
    }
    if (mode == OV_RENAME) { Node *n = tree_selected(); if (!n) { U.overlay = OV_NONE; return; } field_set(&U.field, n->name); }
}
static void overlay_close(void) { U.overlay = OV_NONE; U.redraw = 1; }

static int valid_name(const char *name) { return name[0] && !strchr(name, '/') && strcmp(name, ".") && strcmp(name, "..") && strlen(name) < 200; }

static int remove_tree(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return -1;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path); struct dirent *e;
        while (d && (e = readdir(d))) {
            if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
            char child[PATH_MAX];
            if (snprintf(child, sizeof child, "%s/%s", path, e->d_name) < (int)sizeof child) remove_tree(child);
        }
        if (d) closedir(d);
        return rmdir(path);
    }
    return unlink(path);
}

/* Moves a file or folder; the open documents under it follow. 0 when done. */
static int move_path(const char *old, const char *path) {
    if (access(path, F_OK) == 0) { toast(TR("Esiste già", "Already exists")); return -1; }
    if (rename(old, path) != 0) { toast(strerror(errno)); return -1; }
    size_t olen = strlen(old);
    for (int i = 0; i < U.ndocs; i++) {
        Doc *o = U.docs[i];
        if (!strncmp(o->path, old, olen) && (o->path[olen] == 0 || o->path[olen] == '/')) {
            char moved[PATH_MAX]; snprintf(moved, sizeof moved, "%s%s", path, o->path + olen);
            snprintf(o->path, sizeof o->path, "%s", moved);
            const char *slash = strrchr(o->path, '/'); snprintf(o->name, sizeof o->name, "%s", slash ? slash + 1 : o->path);
            o->lang = syntax_detect(o->name); o->hl_valid = 0;
        }
    }
    char from[PATH_MAX], to[PATH_MAX];
    snprintf(from, sizeof from, "%s", old); char *s = strrchr(from, '/'); if (s) *s = 0;
    snprintf(to, sizeof to, "%s", path); s = strrchr(to, '/'); if (s) *s = 0;
    Node *a = tree_find(U.tree, from); if (a) node_load(a);
    Node *b = strcmp(from, to) ? tree_find(U.tree, to) : NULL; if (b) { node_load(b); b->expanded = 1; }
    tree_reveal(path); session_save(); U.redraw = 1;
    note_change();
    return 0;
}

static void overlay_accept(int mods) {
    Doc *d = cur();
    char path[PATH_MAX];
    switch (U.overlay) {
    case OV_FIND: if (d && !find_next(d, U.field.text, (mods & M_SHIFT) ? -1 : 1, 1)) toast(TR("Nessun risultato", "No results")); return;
    case OV_REPLACE:
        if (!d) return;
        if (mods & M_CTRL) { char msg[64]; snprintf(msg, sizeof msg, TR("%d sostituzioni", "%d replaced"), replace_all(d, U.field.text, U.field2.text)); toast(msg); return; }
        if (U.field_active == 1 && doc_has_selection(d)) {
            Pos a = pos_min(d->caret, d->anchor), b = pos_max(d->caret, d->anchor);
            int len; char *sel = doc_range(d, a, b, &len);
            int same = U.find_case ? !strcmp(sel, U.field.text) : !strcasecmp(sel, U.field.text);
            free(sel);
            if (same) doc_replace(d, a, b, U.field2.text, U.field2.len, 0);
        }
        if (!find_next(d, U.field.text, 1, 1)) toast(TR("Nessun risultato", "No results"));
        return;
    case OV_GOTO: if (d) { int line = atoi(U.field.text); if (line > 0) { d->caret = d->anchor = doc_clamp(d, (Pos){ line - 1, 0 }); center_caret(d); } } break;
    case OV_QUICK: if (U.nquick_hit) { char *p = U.quick[U.quick_hit[U.quick_sel]]; if (open_path(p)) tree_reveal(p); } break;
    case OV_NEW_FILE: case OV_NEW_DIR:
        if (!valid_name(U.field.text)) { toast(TR("Nome non valido", "Invalid name")); return; }
        snprintf(path, sizeof path, "%s/%s", tree_target_dir(), U.field.text);
        if (access(path, F_OK) == 0) { toast(TR("Esiste già", "Already exists")); return; }
        if (U.overlay == OV_NEW_DIR) { if (mkdir(path, 0755) != 0) { toast(strerror(errno)); return; } }
        else { int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0644); if (fd < 0) { toast(strerror(errno)); return; } close(fd); }
        { Node *dir = tree_find(U.tree, tree_target_dir()); if (dir) { node_load(dir); dir->expanded = 1; } }
        tree_reveal(path);
        note_change();
        if (U.overlay == OV_NEW_FILE) open_path(path);
        break;
    case OV_RENAME: {
        Node *n = tree_selected();
        if (!n || !valid_name(U.field.text)) { toast(TR("Nome non valido", "Invalid name")); return; }
        snprintf(path, sizeof path, "%s/%s", n->parent->path, U.field.text);
        char old[PATH_MAX]; snprintf(old, sizeof old, "%s", n->path);
        if (move_path(old, path) != 0) return;
        break; }
    case OV_DELETE: {
        Node *n = tree_selected();
        if (!n) break;
        char gone[PATH_MAX]; snprintf(gone, sizeof gone, "%s", n->path);
        Node *parent = n->parent;
        if (remove_tree(gone) != 0) { toast(strerror(errno)); break; }
        size_t glen = strlen(gone);
        for (int i = U.ndocs - 1; i >= 0; i--) if (!strncmp(U.docs[i]->path, gone, glen) && (U.docs[i]->path[glen] == 0 || U.docs[i]->path[glen] == '/')) close_doc(i);
        node_load(parent); U.sel_path[0] = 0;
        note_change();
        break; }
    case OV_CLOSE_DIRTY: if (U.pending_doc < U.ndocs) close_doc(U.pending_doc); break;
    }
    overlay_close();
}

/* ---- drawing ---------------------------------------------------------------- */

typedef struct { Doc *d; Line *l; int pos, vcol, x0, baseline, right; } LineCtx;

static void draw_span(void *ctx_, int from, int to, int kind) {
    LineCtx *c = ctx_;
    if (from > c->pos) draw_span(ctx_, c->pos, from, T_TEXT);
    Color color = U.syn[kind];
    for (int i = from; i < to;) {
        int cp = utf8_next(c->l->s, c->l->len, &i);
        int w = cp == '\t' ? TAB_CELLS - c->vcol % TAB_CELLS : 1;
        int x = c->x0 + c->vcol * U.cell_w;
        if (x > c->right) { c->pos = c->l->len; return; }
        if (cp != '\t' && cp != ' ' && x + U.cell_w > G.clip.x) glyph_draw(glyph_get(FACE_MONO, U.font_px, cp), x, c->baseline, color);
        c->vcol += w;
    }
    c->pos = to;
}

static void draw_scrollbar(Rect track, int content, int view, int scroll, int vertical) {
    if (content <= view) return;
    int len = vertical ? track.h : track.w;
    int thumb = (int)((long)len * view / content); if (thumb < S(28)) thumb = S(28);
    int at = (int)((long)(len - thumb) * scroll / (content - view));
    Rect r = vertical ? (Rect){ track.x + S(3), track.y + at, track.w - S(5), thumb } : (Rect){ track.x + at, track.y + S(3), thumb, track.h - S(5) };
    gfx_tint(r, U.muted, 90);
}

#include "term.c"
#include "run.c"

static void draw_editor(void) {
    Rect e = r_editor();
    gfx_fill(e, U.bg);
    Doc *d = cur();
    if (!d) {
        const char *hint = TR("Apri un file dall'albero  \xC2\xB7  Ctrl+P cerca file  \xC2\xB7  Ctrl+N nuovo file", "Open a file from the tree  \xC2\xB7  Ctrl+P find file  \xC2\xB7  Ctrl+N new file");
        int w = gfx_text_width(FACE_UI, U.ui_px, hint, -1);
        gfx_text(FACE_UI, U.ui_px, e.x + (e.w - w) / 2, e.y + e.h / 2, hint, -1, U.muted);
        return;
    }
    clamp_scroll(d);
    Rect t = r_text(d);
    int g = gutter_w(d), first = d->scroll_y / U.line_h, last = (d->scroll_y + t.h) / U.line_h + 1;
    if (last > d->n) last = d->n;
    /* Syntax state up to the first visible line; each line only depends on the one before. */
    if (d->hl_valid < 1) { d->ln[0].state = ST_NORMAL; d->hl_valid = 1; }
    for (int i = d->hl_valid; i < last; i++) {
        d->ln[i].state = (unsigned char)syntax_line(d->lang, d->ln[i - 1].state, d->ln[i - 1].s, d->ln[i - 1].len, NULL, NULL);
        d->hl_valid = i + 1;
    }
    int max_cells = doc_max_cells(d, first, last);
    int content_w = (max_cells + 8) * U.cell_w;
    if (d->scroll_x > content_w - t.w) d->scroll_x = content_w - t.w > 0 ? content_w - t.w : 0;

    Pos sa = pos_min(d->caret, d->anchor), sb = pos_max(d->caret, d->anchor);
    const char *q = (U.overlay == OV_FIND || U.overlay == OV_REPLACE) ? U.field.text : "";
    int qlen = (int)strlen(q);
    for (int i = first; i < last; i++) {
        Line *l = &d->ln[i];
        int y = t.y + i * U.line_h - d->scroll_y;
        if (i == d->caret.line && !doc_has_selection(d)) gfx_fill(rect_intersect((Rect){ e.x, y, e.w - bar_w(), U.line_h }, e), mix(U.bg, U.text, 10));
        gfx_clip(t);
        for (int k = 0; qlen && (k = find_in_line(l, q, qlen, k, !U.find_case)) >= 0; k += qlen)
            gfx_tint((Rect){ t.x + vis_col(l, k) * U.cell_w - d->scroll_x, y, (vis_col(l, k + qlen) - vis_col(l, k)) * U.cell_w, U.line_h }, U.syn[T_NUMBER], 70);
        if (pos_cmp(sa, sb) && i >= sa.line && i <= sb.line) {
            int c0 = i == sa.line ? vis_col(l, sa.col) : 0, c1 = i == sb.line ? vis_col(l, sb.col) : vis_col(l, l->len) + 1;
            gfx_tint((Rect){ t.x + c0 * U.cell_w - d->scroll_x, y, (c1 - c0) * U.cell_w, U.line_h }, U.primary, 80);
        }
        LineCtx ctx = { d, l, 0, 0, t.x - d->scroll_x, y + (U.line_h - U.font_px) / 2 + U.asc_mono, t.x + t.w };
        syntax_line(d->lang, l->state, l->s, l->len, draw_span, &ctx);
        if (ctx.pos < l->len) draw_span(&ctx, ctx.pos, l->len, T_TEXT);
        gfx_unclip();
        char num[16]; int nlen = snprintf(num, sizeof num, "%d", i + 1);
        gfx_clip(e);
        for (int k = 0; k < nlen; k++) glyph_draw(glyph_get(FACE_MONO, U.font_px, num[k]), e.x + g - (nlen - k + 2) * U.cell_w + U.cell_w / 2, ctx.baseline, i == d->caret.line ? U.text : mix(U.bg, U.muted, 170));
        gfx_unclip();
    }
    if (U.caret_on && U.focused && U.focus == FOCUS_EDITOR && U.overlay == OV_NONE && d->caret.line >= first && d->caret.line < last) {
        gfx_clip(t);
        gfx_fill((Rect){ t.x + vis_col(&d->ln[d->caret.line], d->caret.col) * U.cell_w - d->scroll_x, t.y + d->caret.line * U.line_h - d->scroll_y + S(2), S(2), U.line_h - S(4) }, U.primary);
        gfx_unclip();
    }
    draw_scrollbar((Rect){ e.x + e.w - bar_w(), e.y, bar_w(), e.h - bar_w() }, max_scroll_y(d) + t.h, t.h, d->scroll_y, 1);
    draw_scrollbar((Rect){ t.x, e.y + e.h - bar_w(), t.w, bar_w() }, content_w, t.w, d->scroll_x, 0);
}

static int tab_width(Doc *d) { return gfx_text_width(FACE_UI, U.ui_px, d->name, -1) + S(52); }

static void draw_tabs(void) {
    Rect r = r_tabs();
    if (!r.h) return;
    gfx_fill(r, U.surface);
    gfx_fill((Rect){ r.x, r.y + r.h - 1, r.w, 1 }, U.border);
    gfx_clip(r);
    int x = r.x;
    for (int i = 0; i < U.ndocs; i++) {
        Doc *d = U.docs[i]; int w = tab_width(d), on = i == U.active;
        if (on) { gfx_fill((Rect){ x, r.y, w, r.h }, U.bg); gfx_fill((Rect){ x, r.y, w, S(2) }, U.primary); }
        gfx_text(FACE_UI, U.ui_px, x + S(14), r.y + (r.h - U.ui_px) / 2 + U.asc_ui, d->name, -1, on ? U.text : U.muted);
        int cx = x + w - S(24), cy = r.y + r.h / 2, hot = rect_has((Rect){ cx - S(6), r.y, S(24), r.h }, U.mx, U.my);
        if (d->dirty && !hot) gfx_fill((Rect){ cx + S(2), cy - S(3), S(7), S(7) }, U.text);
        else if (on || hot) gfx_icon(ICON_CLOSE, (Rect){ cx - S(3), cy - S(9), S(18), S(18) }, S(14), hot ? U.text : U.muted);
        gfx_fill((Rect){ x + w - 1, r.y + S(8), 1, r.h - S(16) }, U.border);
        x += w;
    }
    gfx_unclip();
}

static void draw_tree(void) {
    Rect r = r_sidebar();
    if (!r.w) return;
    gfx_fill(r, U.surface);
    gfx_fill((Rect){ r.x + r.w - 1, r.y, 1, r.h }, U.border);
    int head = tabs_h();
    const char *title = U.title[0] ? U.title : strrchr(U.root, '/'); if (!U.title[0]) title = title && title[1] ? title + 1 : U.root;
    char upper[512]; int k = 0; for (; title[k] && k < 511; k++) upper[k] = (char)toupper((unsigned char)title[k]); upper[k] = 0;
    gfx_text_fit(FACE_UI, S(11), r.x + S(16), r.y + (head - S(11)) / 2 + font_ascent(FACE_UI, S(11)), upper, r.w - S(16) - S(30) * 3 - S(12), U.muted);
    const int icons[] = { ICON_NEW_FILE, ICON_NEW_FOLDER, ICON_REFRESH };
    for (int i = 0; i < 3; i++) {
        Rect b = { r.x + r.w - S(30) * (3 - i) - S(6), r.y + S(6), S(26), head - S(12) };
        int hot = rect_has(b, U.mx, U.my);
        if (hot) gfx_fill(b, U.input);
        gfx_icon(icons[i], b, S(16), hot ? U.text : U.muted);
    }
    Rect list = { r.x, r.y + tree_top(), r.w - 1, r.h - tree_top() };
    tree_rows();
    int max = U.nrows * row_h() - list.h; if (max < 0) max = 0;
    if (U.tree_scroll > max) U.tree_scroll = max;
    if (U.tree_scroll < 0) U.tree_scroll = 0;
    gfx_clip(list);
    Doc *d = cur();
    for (int i = U.tree_scroll / row_h(); i < U.nrows; i++) {
        int y = list.y + i * row_h() - U.tree_scroll;
        if (y > list.y + list.h) break;
        Node *n = U.rows[i];
        Rect row = { list.x, y, list.w, row_h() };
        int selected = !strcmp(n->path, U.sel_path), open = d && !strcmp(d->path, n->path);
        size_t dl = strlen(U.drop_dir);
        int in_drop = U.drag == DRAG_TREE_MOVE && U.drop_ok && strcmp(U.drop_dir, U.root) && !strncmp(n->path, U.drop_dir, dl) && (n->path[dl] == 0 || n->path[dl] == '/');
        if (in_drop) gfx_fill(row, mix(U.surface, U.primary, 45));
        else if (selected && U.drag != DRAG_TREE_MOVE) gfx_fill(row, U.focus == FOCUS_TREE ? mix(U.surface, U.primary, 60) : U.input);
        else if (U.drag != DRAG_TREE_MOVE && rect_has(row, U.mx, U.my)) gfx_fill(row, mix(U.surface, U.text, 12));
        int x = list.x + S(12) + n->depth * S(14), base = y + (row_h() - U.ui_px) / 2 + U.asc_ui;
        if (n->is_dir) gfx_icon(n->expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT, (Rect){ x - S(2), y, S(14), row_h() }, S(14), U.muted);
        gfx_text_fit(FACE_UI, U.ui_px, x + S(16), base, n->name, list.x + list.w - x - S(24), open ? U.primary : n->name[0] == '.' ? U.muted : U.text);
    }
    gfx_unclip();
    draw_scrollbar((Rect){ r.x + r.w - bar_w(), list.y, bar_w(), list.h }, U.nrows * row_h(), list.h, U.tree_scroll, 1);
    if (U.drag == DRAG_TREE_MOVE) {
        if (U.drop_ok && !strcmp(U.drop_dir, U.root)) gfx_frame((Rect){ list.x + S(1), list.y, list.w - S(2), list.h - S(1) }, U.primary);
        const char *name = strrchr(U.drag_path, '/'); name = name ? name + 1 : U.drag_path;
        int w = gfx_text_width(FACE_UI, U.ui_px, name, -1) + S(20);
        Rect g = { U.mx + S(14), U.my + S(10), w, S(24) };
        gfx_tint((Rect){ g.x + S(2), g.y + S(3), g.w, g.h }, RGB(0, 0, 0), 60);
        gfx_fill(g, U.surface); gfx_frame(g, U.drop_ok ? U.primary : U.border);
        gfx_text(FACE_UI, U.ui_px, g.x + S(10), g.y + (g.h - U.ui_px) / 2 + U.asc_ui, name, -1, U.drop_ok ? U.text : U.muted);
    }
}

/* Where a drag in the tree would land: the folder under the pointer, a file's folder, or the root below the rows.
 * Not the folder it is already in, and never the dragged folder itself or anything inside it. */
static void tree_drop_update(int x, int y) {
    Rect side = r_sidebar(), list = { side.x, side.y + tree_top(), side.w, side.h - tree_top() };
    U.drop_ok = 0; U.drop_dir[0] = 0;
    if (!rect_has(list, x, y)) { U.hover_path[0] = 0; return; }
    tree_rows();
    int row = (y - list.y + U.tree_scroll) / row_h();
    Node *n = row >= 0 && row < U.nrows ? U.rows[row] : NULL;
    snprintf(U.drop_dir, sizeof U.drop_dir, "%s", !n ? U.root : n->is_dir ? n->path : n->parent->path);
    if (!n || strcmp(U.hover_path, n->path)) { snprintf(U.hover_path, sizeof U.hover_path, "%s", n ? n->path : ""); U.hover_at = now_ms(); }
    size_t sl = strlen(U.drag_path);
    char from[PATH_MAX]; snprintf(from, sizeof from, "%s", U.drag_path); char *s = strrchr(from, '/'); if (s) *s = 0;
    int inside = !strncmp(U.drop_dir, U.drag_path, sl) && (U.drop_dir[sl] == 0 || U.drop_dir[sl] == '/');
    U.drop_ok = !inside && strcmp(U.drop_dir, from) != 0;
}

/* While a drag waits over a closed folder it opens; near the list's edges the list scrolls. */
static void tree_drag_tick(long now) {
    if (U.drag != DRAG_TREE_MOVE) return;
    Node *n = U.hover_path[0] ? tree_find(U.tree, U.hover_path) : NULL;
    if (n && n->is_dir && !n->expanded && now - U.hover_at > 650) { if (!n->loaded) node_load(n); n->expanded = 1; tree_drop_update(U.mx, U.my); U.redraw = 1; }
    Rect side = r_sidebar();
    int top = side.y + tree_top(), bottom = side.y + side.h;
    if (U.mx >= side.x && U.mx < side.x + side.w) {
        if (U.my >= top && U.my < top + S(20)) { U.tree_scroll -= row_h() / 2; tree_drop_update(U.mx, U.my); U.redraw = 1; }
        else if (U.my > bottom - S(20) && U.my <= bottom) { U.tree_scroll += row_h() / 2; tree_drop_update(U.mx, U.my); U.redraw = 1; }
    }
}

static void tree_drop(void) {
    if (!U.drop_ok) return;
    const char *name = strrchr(U.drag_path, '/'); name = name ? name + 1 : U.drag_path;
    char dest[PATH_MAX];
    if ((size_t)snprintf(dest, sizeof dest, "%s/%s", U.drop_dir, name) >= sizeof dest) return;
    char src[PATH_MAX]; snprintf(src, sizeof src, "%s", U.drag_path);
    if (access(dest, F_OK) == 0) {
        char msg[256]; snprintf(msg, sizeof msg, TR("\"%s\" esiste già in quella cartella", "\"%s\" already exists in that folder"), name);
        toast(msg); return;
    }
    move_path(src, dest);
}

/* The Terminal button, first thing in the status bar: the panel is always one click away. */
static const char *status_term_label(void) { return TR("Terminale", "Terminal"); }
static Rect r_status_term(void) {
    Rect r = r_status();
    return (Rect){ r.x + S(4), r.y + S(1), gfx_text_width(FACE_UI, S(12), status_term_label(), -1) + S(34), r.h - S(1) };
}

static void draw_status(void) {
    Rect r = r_status();
    gfx_fill(r, U.surface);
    gfx_fill((Rect){ r.x, r.y, r.w, 1 }, U.border);
    Doc *d = cur();
    int base = r.y + (r.h - S(12)) / 2 + font_ascent(FACE_UI, S(12));
    Rect tb = r_status_term();
    int hot = rect_has(tb, U.mx, U.my), on = panel_h() > 0;
    if (hot) gfx_fill(tb, U.input);
    Color ink = hot || on ? U.text : U.muted;
    gfx_icon(ICON_TERMINAL, (Rect){ tb.x + S(6), tb.y, S(14), tb.h }, S(14), on ? U.primary : ink);
    gfx_text(FACE_UI, S(12), tb.x + S(26), base, status_term_label(), -1, ink);
    r.x = tb.x + tb.w + S(4); r.w -= r.x;
    if (!d) return;
    char left[PATH_MAX + 32], right[160];
    const char *rel = !strncmp(d->path, U.root, strlen(U.root)) ? d->path + strlen(U.root) + 1 : d->path;
    snprintf(left, sizeof left, "%s%s%s", rel, d->dirty ? "  \xE2\x97\x8F" : "", d->readonly ? TR("  (sola lettura)", "  (read-only)") : "");
    int sel = 0;
    if (doc_has_selection(d)) { int len; char *t = doc_range(d, pos_min(d->caret, d->anchor), pos_max(d->caret, d->anchor), &len); sel = len; free(t); }
    char selbuf[48] = ""; if (sel) snprintf(selbuf, sizeof selbuf, TR("(%d selezionati)   ", "(%d selected)   "), sel);
    snprintf(right, sizeof right, "%s%s %d, %s %d     %s     UTF-8     %s", selbuf, TR("Riga", "Ln"), d->caret.line + 1, TR("Col", "Col"),
             vis_col(&d->ln[d->caret.line], d->caret.col) + 1, d->crlf ? "CRLF" : "LF", LANGS[d->lang].name);
    int rw = gfx_text_width(FACE_UI, S(12), right, -1);
    gfx_text_fit(FACE_UI, S(12), r.x + S(14), base, left, r.w - rw - S(40), U.muted);
    gfx_text(FACE_UI, S(12), r.x + r.w - rw - S(14), base, right, -1, U.muted);
}

static void draw_field(Field *f, Rect box, int active, const char *placeholder) {
    gfx_fill(box, U.input);
    gfx_frame(box, active ? U.primary : U.border);
    int base = box.y + (box.h - U.ui_px) / 2 + U.asc_ui, x = box.x + S(10);
    gfx_clip((Rect){ box.x + 1, box.y + 1, box.w - 2, box.h - 2 });
    if (!f->len) gfx_text(FACE_UI, U.ui_px, x, base, placeholder, -1, U.muted);
    if (f->fresh) gfx_tint((Rect){ x - S(2), box.y + S(5), gfx_text_width(FACE_UI, U.ui_px, f->text, f->len) + S(4), box.h - S(10) }, U.primary, 90);
    gfx_text(FACE_UI, U.ui_px, x, base, f->text, f->len, U.text);
    if (active && U.caret_on) gfx_fill((Rect){ x + gfx_text_width(FACE_UI, U.ui_px, f->text, f->caret), box.y + S(6), S(2), box.h - S(12) }, U.primary);
    gfx_unclip();
}

static int overlay_confirm(void) { return U.overlay == OV_DELETE || U.overlay == OV_CLOSE_DIRTY; }

/* Where the command bar sits: at the top, centred over the editor. */
static Rect r_overlay(void) {
    int w = S(560); if (w > G.w - S(40)) w = G.w - S(40);
    int fh = S(32), pad = S(10), rows = U.overlay == OV_REPLACE ? 2 : 1;
    int list_rows = U.overlay == OV_QUICK ? (U.nquick_hit < 12 ? U.nquick_hit : 12) : 0;
    int h = overlay_confirm() ? pad + fh + S(4) + S(30) + pad : pad + rows * (fh + S(6)) + list_rows * row_h() + S(26);
    return (Rect){ side_w() + (G.w - side_w() - w) / 2, S(8), w, h };
}

static const char *confirm_label(void) { return U.overlay == OV_DELETE ? TR("Elimina", "Delete") : TR("Chiudi senza salvare", "Close without saving"); }

/* A confirmation's buttons, bottom right: 0 cancels, 1 does it. */
static Rect r_confirm_button(int which) {
    Rect box = r_overlay();
    int bh = S(30), pad = S(10), gap = S(8);
    int wa = gfx_text_width(FACE_UI, U.ui_px, confirm_label(), -1) + S(28);
    int wc = gfx_text_width(FACE_UI, U.ui_px, TR("Annulla", "Cancel"), -1) + S(28);
    int y = box.y + box.h - pad - bh, xa = box.x + box.w - pad - wa;
    return which ? (Rect){ xa, y, wa, bh } : (Rect){ xa - gap - wc, y, wc, bh };
}

static void draw_button(Rect b, const char *label, int primary) {
    int hot = rect_has(b, U.mx, U.my);
    gfx_fill(b, primary ? (hot ? mix(U.primary, U.text, 40) : U.primary) : (hot ? mix(U.input, U.primary, 40) : U.input));
    if (!primary) gfx_frame(b, hot ? U.primary : U.border);
    int tw = gfx_text_width(FACE_UI, U.ui_px, label, -1);
    gfx_text(FACE_UI, U.ui_px, b.x + (b.w - tw) / 2, b.y + (b.h - U.ui_px) / 2 + U.asc_ui, label, -1, primary ? U.on_primary : U.text);
}

static void draw_overlay(void) {
    if (U.overlay == OV_NONE) return;
    Rect box = r_overlay();
    int w = box.w, h = box.h;
    int fh = S(32), pad = S(10), rows = U.overlay == OV_REPLACE ? 2 : 1;
    int list_rows = U.overlay == OV_QUICK ? (U.nquick_hit < 12 ? U.nquick_hit : 12) : 0;
    int confirm = overlay_confirm();
    gfx_tint((Rect){ box.x + S(3), box.y + S(4), box.w, box.h }, RGB(0, 0, 0), 70);
    gfx_fill(box, U.surface); gfx_frame(box, U.border);
    const char *hint = "";
    Node *n = tree_selected();
    char msg[512] = "";
    if (confirm) {
        if (U.overlay == OV_DELETE) snprintf(msg, sizeof msg, TR("Eliminare \"%s\"%s?", "Delete \"%s\"%s?"), n ? n->name : "", n && n->is_dir ? TR(" e tutto il suo contenuto", " and everything in it") : "");
        else snprintf(msg, sizeof msg, TR("\"%s\" ha modifiche non salvate. Chiudere senza salvare?", "\"%s\" has unsaved changes. Close without saving?"), U.pending_doc < U.ndocs ? U.docs[U.pending_doc]->name : "");
        gfx_text_fit(FACE_UI, U.ui_px, box.x + S(14), box.y + pad + (fh - U.ui_px) / 2 + U.asc_ui, msg, w - S(28), U.text);
        Rect cancel = r_confirm_button(0), accept = r_confirm_button(1);
        draw_button(cancel, TR("Annulla", "Cancel"), 0);
        draw_button(accept, confirm_label(), 1);
        gfx_text_fit(FACE_UI, S(11), box.x + S(14), cancel.y + (cancel.h - S(11)) / 2 + font_ascent(FACE_UI, S(11)),
                     TR("Invio conferma  \xC2\xB7  Esc annulla", "Enter confirms  \xC2\xB7  Esc cancels"), cancel.x - box.x - S(28), U.muted);
        return;
    } else {
        const char *ph = U.overlay == OV_FIND || U.overlay == OV_REPLACE ? TR("Cerca", "Find") : U.overlay == OV_GOTO ? TR("Numero di riga", "Line number")
            : U.overlay == OV_QUICK ? TR("Cerca file per nome", "Search files by name") : U.overlay == OV_NEW_DIR ? TR("Nome della cartella", "Folder name") : TR("Nome del file", "File name");
        draw_field(&U.field, (Rect){ box.x + pad, box.y + pad, w - 2 * pad, fh }, U.field_active == 0, ph);
        if (U.overlay == OV_REPLACE) draw_field(&U.field2, (Rect){ box.x + pad, box.y + pad + fh + S(6), w - 2 * pad, fh }, U.field_active == 1, TR("Sostituisci con", "Replace with"));
        hint = U.overlay == OV_FIND ? TR("Invio successivo  \xC2\xB7  Maiusc+Invio precedente  \xC2\xB7  Alt+C maiuscole/minuscole", "Enter next  \xC2\xB7  Shift+Enter previous  \xC2\xB7  Alt+C match case")
             : U.overlay == OV_REPLACE ? TR("Tab cambia campo  \xC2\xB7  Invio sostituisce  \xC2\xB7  Ctrl+Invio sostituisce tutto", "Tab switches field  \xC2\xB7  Enter replaces  \xC2\xB7  Ctrl+Enter replaces all")
             : TR("Invio conferma  \xC2\xB7  Esc annulla", "Enter confirms  \xC2\xB7  Esc cancels");
    }
    int ly = box.y + pad + rows * (fh + S(6));
    for (int i = 0; i < list_rows; i++) {
        const char *p = U.quick[U.quick_hit[i]];
        Rect row = { box.x + pad, ly + i * row_h(), w - 2 * pad, row_h() };
        if (i == U.quick_sel) gfx_fill(row, mix(U.surface, U.primary, 60));
        const char *name = strrchr(p, '/'); name = name ? name + 1 : p;
        int x = gfx_text(FACE_UI, U.ui_px, row.x + S(8), row.y + (row_h() - U.ui_px) / 2 + U.asc_ui, name, -1, U.text);
        gfx_text_fit(FACE_UI, S(11), x + S(10), row.y + (row_h() - S(11)) / 2 + font_ascent(FACE_UI, S(11)), p + strlen(U.root) + 1, row.x + row.w - x - S(18), U.muted);
    }
    gfx_text_fit(FACE_UI, S(11), box.x + S(14), box.y + h - S(10), hint, w - S(28), U.muted);
    if (U.overlay == OV_FIND || U.overlay == OV_REPLACE) {
        const char *cs = U.find_case ? "Aa" : "aa";
        gfx_text(FACE_UI, S(11), box.x + w - S(34), box.y + h - S(10), cs, -1, U.find_case ? U.primary : U.muted);
    }
}

/* ---- right-click menu ----------------------------------------------------------
 * The same few things the keyboard does, where the pointer is: the tree, the text,
 * a terminal. Copies stay in the editor's own clipboard, like Ctrl+C: nothing
 * leaves the container. Paste asks the host for its clipboard (OUT_PASTE). */

enum { ACT_NEW_FILE = 1, ACT_NEW_DIR, ACT_RENAME, ACT_DELETE, ACT_COPY_PATH, ACT_COPY_REL,
       ACT_CUT, ACT_COPY, ACT_PASTE, ACT_SELECT_ALL,
       ACT_TERM_COPY, ACT_TERM_PASTE, ACT_TERM_CLEAR, ACT_TERM_NEW, ACT_TERM_CLOSE };

static Pos pos_at(Doc *d, int x, int y);

static int menu_item_h(const MenuItem *it) { return it->act ? S(26) : S(9); }

static void menu_add(int act, const char *label, const char *keys, int off) {
    if (U.menu_n < MENU_MAX) U.menu_items[U.menu_n++] = (MenuItem){ act, label, keys, off };
}

static void menu_close(void) { if (U.menu) { U.menu = MENU_NONE; U.redraw = 1; } }

static void menu_open(int kind, int x, int y) {
    U.menu = kind; U.menu_n = 0; U.menu_hot = -1;
    if (kind == MENU_TREE) {
        int none = !tree_selected();
        menu_add(ACT_NEW_FILE, TR("Nuovo file", "New file"), "Ctrl+N", 0);
        menu_add(ACT_NEW_DIR, TR("Nuova cartella", "New folder"), "", 0);
        menu_add(0, "", "", 0);
        menu_add(ACT_RENAME, TR("Rinomina", "Rename"), "F2", none);
        menu_add(ACT_DELETE, TR("Elimina", "Delete"), TR("Canc", "Del"), none);
        menu_add(0, "", "", 0);
        menu_add(ACT_COPY_PATH, TR("Copia percorso", "Copy path"), "", none);
        menu_add(ACT_COPY_REL, TR("Copia percorso relativo", "Copy relative path"), "", none);
    } else if (kind == MENU_TEXT) {
        menu_add(ACT_CUT, TR("Taglia", "Cut"), "Ctrl+X", 0);
        menu_add(ACT_COPY, TR("Copia", "Copy"), "Ctrl+C", 0);
        menu_add(ACT_PASTE, TR("Incolla", "Paste"), "Ctrl+V", 0);
        menu_add(0, "", "", 0);
        menu_add(ACT_SELECT_ALL, TR("Seleziona tutto", "Select all"), "Ctrl+A", 0);
    } else {
        Term *t = cur_term();
        menu_add(ACT_TERM_COPY, TR("Copia", "Copy"), "Ctrl+Shift+C", !t || !t->sel_on);
        menu_add(ACT_TERM_PASTE, TR("Incolla", "Paste"), "Ctrl+V", !t);
        menu_add(0, "", "", 0);
        menu_add(ACT_TERM_CLEAR, TR("Pulisci", "Clear"), "", !t);
        menu_add(0, "", "", 0);
        menu_add(ACT_TERM_NEW, TR("Nuovo terminale", "New terminal"), "Ctrl+Shift+T", 0);
        menu_add(ACT_TERM_CLOSE, TR("Chiudi terminale", "Close terminal"), "Ctrl+Shift+W", !t);
    }
    int label_w = 0, keys_w = 0, h = S(8);
    for (int i = 0; i < U.menu_n; i++) {
        MenuItem *it = &U.menu_items[i];
        int lw = gfx_text_width(FACE_UI, U.ui_px, it->label, -1), kw = gfx_text_width(FACE_UI, U.ui_px, it->keys, -1);
        if (lw > label_w) label_w = lw;
        if (kw > keys_w) keys_w = kw;
        h += menu_item_h(it);
    }
    int w = S(28) + label_w + (keys_w ? S(36) + keys_w : 0) + S(20);
    if (w < S(200)) w = S(200);
    /* Where the pointer is, kept inside the editor: to the left or above it when there is no room. */
    if (x + w > G.w - S(4)) x = x - w >= S(4) ? x - w : G.w - S(4) - w;
    if (y + h > G.h - S(4)) y = y - h >= S(4) ? y - h : G.h - S(4) - h;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    U.menu_box = (Rect){ x, y, w, h };
    U.redraw = 1;
}

/* The line of the menu under (x, y), or -1: separators and switched-off lines never count. */
static int menu_item_at(int x, int y) {
    if (!rect_has(U.menu_box, x, y)) return -1;
    int top = U.menu_box.y + S(4);
    for (int i = 0; i < U.menu_n; i++) {
        int h = menu_item_h(&U.menu_items[i]);
        if (y >= top && y < top + h) return U.menu_items[i].act && !U.menu_items[i].off ? i : -1;
        top += h;
    }
    return -1;
}

static void draw_menu(void) {
    if (!U.menu) return;
    Rect box = U.menu_box;
    gfx_tint((Rect){ box.x + S(2), box.y + S(4), box.w, box.h }, RGB(0, 0, 0), 70);
    gfx_fill(box, U.surface); gfx_frame(box, U.border);
    int y = box.y + S(4);
    for (int i = 0; i < U.menu_n; i++) {
        MenuItem *it = &U.menu_items[i];
        int h = menu_item_h(it);
        if (!it->act) { gfx_fill((Rect){ box.x + S(10), y + h / 2, box.w - S(20), 1 }, U.border); y += h; continue; }
        Rect row = { box.x + S(4), y, box.w - S(8), h };
        if (i == U.menu_hot) gfx_fill(row, mix(U.surface, U.primary, 60));
        Color ink = it->off ? mix(U.surface, U.muted, 150) : U.text;
        int base = y + (h - U.ui_px) / 2 + U.asc_ui;
        gfx_text(FACE_UI, U.ui_px, box.x + S(24), base, it->label, -1, ink);
        if (it->keys[0]) {
            int kw = gfx_text_width(FACE_UI, U.ui_px, it->keys, -1);
            gfx_text(FACE_UI, U.ui_px, box.x + box.w - S(20) - kw, base, it->keys, -1, it->off ? ink : U.muted);
        }
        y += h;
    }
}

static void menu_run(int index) {
    if (index < 0 || index >= U.menu_n) return;
    MenuItem it = U.menu_items[index];
    menu_close();
    if (!it.act || it.off) return;
    Doc *d = cur();
    Term *t = cur_term();
    Node *n = tree_selected();
    switch (it.act) {
    case ACT_NEW_FILE: overlay_open(OV_NEW_FILE); break;
    case ACT_NEW_DIR: overlay_open(OV_NEW_DIR); break;
    case ACT_RENAME: if (n) overlay_open(OV_RENAME); break;
    case ACT_DELETE: if (n) overlay_open(OV_DELETE); break;
    case ACT_COPY_PATH: if (n) set_clip(n->path, (int)strlen(n->path)); break;
    case ACT_COPY_REL: if (n) { const char *rel = n->path + strlen(U.root); if (*rel == '/') rel++; set_clip(rel, (int)strlen(rel)); } break;
    case ACT_CUT: if (d) { ed_copy(d, 1); U.focus = FOCUS_EDITOR; } break;
    case ACT_COPY: if (d) ed_copy(d, 0); break;
    case ACT_PASTE: if (d) { U.focus = FOCUS_EDITOR; gfx_request_paste(); } break;
    case ACT_SELECT_ALL: if (d) { d->anchor = (Pos){ 0, 0 }; d->caret = (Pos){ d->n - 1, d->ln[d->n - 1].len }; U.focus = FOCUS_EDITOR; } break;
    case ACT_TERM_COPY: if (t) term_copy(t); break;
    case ACT_TERM_PASTE: if (t) { U.focus = FOCUS_TERM; gfx_request_paste(); } break;
    case ACT_TERM_CLEAR:
        /* The history goes; the shell redraws its prompt, and what was typed on it, at the top. */
        if (t) { term_sb_clear(t); vterm_keyboard_unichar(t->vt, 'l', VTERM_MOD_CTRL); t->view = 0; U.focus = FOCUS_TERM; }
        break;
    case ACT_TERM_NEW: term_open(); break;
    case ACT_TERM_CLOSE: if (t) term_close(U.active_term); break;
    }
    U.redraw = 1;
}

/* A right click: select what is under the pointer, as a left click would, then offer what can be done to it. */
static int menu_right_click(int x, int y) {
    Rect side = r_sidebar(), panel = r_panel();
    if (rect_has(side, x, y)) {
        if (y < tree_top()) return 1;
        U.focus = FOCUS_TREE;
        tree_rows();
        int row = (y - tree_top() + U.tree_scroll) / row_h();
        if (row >= 0 && row < U.nrows) snprintf(U.sel_path, sizeof U.sel_path, "%s", U.rows[row]->path);
        else U.sel_path[0] = 0;
        menu_open(MENU_TREE, x, y);
        return 1;
    }
    if (panel.h && rect_has(panel, x, y)) {
        Rect head = r_panel_head();
        if (rect_has(head, x, y)) {
            int tx = head.x, hit = -1;
            for (int i = 0; i < U.nterms && x < r_panel_action(0).x - S(4); i++) {
                int w = tab_w_term(U.terms[i]);
                if (x >= tx && x < tx + w) { hit = i; break; }
                tx += w;
            }
            if (hit < 0) return 1;
            U.active_term = hit; U.shown_doc = NULL;
        }
        U.focus = FOCUS_TERM;
        menu_open(MENU_TERM, x, y);
        return 1;
    }
    Doc *d = cur();
    if (d && rect_has(r_text(d), x, y)) {
        U.focus = FOCUS_EDITOR;
        /* Inside the selection it stays, so Cut and Copy act on it; elsewhere the caret moves there. */
        Pos p = pos_at(d, x, y), a = pos_min(d->caret, d->anchor), b = pos_max(d->caret, d->anchor);
        if (!doc_has_selection(d) || pos_cmp(p, a) < 0 || pos_cmp(p, b) > 0) { d->caret = d->anchor = p; d->want_x = -1; }
        menu_open(MENU_TEXT, x, y);
        return 1;
    }
    return 0;
}

static void draw_toast(void) {
    if (!U.toast[0]) return;
    if (now_ms() > U.toast_until) { U.toast[0] = 0; return; }
    int w = gfx_text_width(FACE_UI, U.ui_px, U.toast, -1) + S(32), h = S(36);
    if (w > G.w - S(40)) w = G.w - S(40);
    Rect box = { G.w - w - S(20), G.h - status_h() - h - S(16), w, h };
    gfx_fill(box, U.input); gfx_frame(box, U.primary);
    gfx_text_fit(FACE_UI, U.ui_px, box.x + S(16), box.y + (h - U.ui_px) / 2 + U.asc_ui, U.toast, w - S(32), U.text);
}

static char *files_text(void);

static void ui_draw(void) {
    Doc *d = cur();
    /* A frame that only scrolled the text: let the host move what it already has. */
    /* Not with the panel's window over the text: what is moved would be the window's pixels too. */
    if (d && d == U.shown_doc && d->scroll_y != U.shown_scroll_y && U.overlay == OV_NONE && !U.toast[0] && !panel_h()) {
        Rect t = r_text(d);
        if (!memcmp(&t, &U.shown_text, sizeof t)) gfx_scroll((Rect){ r_editor().x, t.y, r_editor().w - bar_w(), t.h }, U.shown_scroll_y - d->scroll_y);
    }
    gfx_unclip();
    draw_editor(); draw_panel(); draw_tabs(); draw_tree(); draw_status(); draw_overlay(); draw_menu(); draw_toast();
    U.shown_doc = d; if (d) { U.shown_scroll_y = d->scroll_y; U.shown_text = r_text(d); }
    gfx_sidebar(side_w(), tabs_h());
    gfx_files(files_text());
    gfx_present();
    U.redraw = 0;
}

/* ---- input ------------------------------------------------------------------ */

static Pos pos_at(Doc *d, int x, int y) {
    Rect t = r_text(d);
    int line = (y - t.y + d->scroll_y) / U.line_h;
    if (line < 0) line = 0;
    if (line >= d->n) line = d->n - 1;
    int cells = (x - t.x + d->scroll_x + U.cell_w / 2) / U.cell_w;
    Pos p = { line, col_from_vis(&d->ln[line], cells < 0 ? 0 : cells) };
    /* col_from_vis rounds inside a cell; the division above already did it for plain cells */
    int v = vis_col(&d->ln[line], p.col);
    if (v > cells && p.col > 0) p.col = utf8_prev_start(d->ln[line].s, p.col);
    return p;
}

static void request_close(int index) {
    if (index < 0 || index >= U.ndocs) return;
    if (U.docs[index]->dirty) { U.pending_doc = index; U.active = index; overlay_open(OV_CLOSE_DIRTY); }
    else close_doc(index);
}

static void tree_activate(Node *n) {
    snprintf(U.sel_path, sizeof U.sel_path, "%s", n->path);
    if (n->is_dir) { if (!n->loaded) node_load(n); n->expanded = !n->expanded; session_save(); }
    else open_path(n->path);
    U.redraw = 1;
}

static void move_caret(Doc *d, Pos p, int select) {
    d->caret = doc_clamp(d, p);
    if (!select) d->anchor = d->caret;
    doc_break_undo(d);
    reveal_caret(d);
}

static void ui_key_editor(Doc *d, int key, int mods) {
    int shift = mods & M_SHIFT, ctrl = mods & (M_CTRL | M_META), alt = mods & M_ALT;
    Pos c = d->caret;
    Line *l = &d->ln[c.line];
    int page = r_text(d).h / U.line_h - 1; if (page < 1) page = 1;
    int keep_x = 0;
    switch (key) {
    case K_LEFT:
        if (!shift && !ctrl && doc_has_selection(d)) { move_caret(d, pos_min(d->caret, d->anchor), 0); break; }
        if (ctrl) c = doc_word_left(d, c); else if (c.col > 0) c.col = utf8_prev_start(l->s, c.col); else if (c.line > 0) { c.line--; c.col = d->ln[c.line].len; }
        move_caret(d, c, shift); break;
    case K_RIGHT:
        if (!shift && !ctrl && doc_has_selection(d)) { move_caret(d, pos_max(d->caret, d->anchor), 0); break; }
        if (ctrl) c = doc_word_right(d, c); else if (c.col < l->len) utf8_next(l->s, l->len, &c.col); else if (c.line + 1 < d->n) { c.line++; c.col = 0; }
        move_caret(d, c, shift); break;
    case K_UP: case K_DOWN: case K_PGUP: case K_PGDN: {
        if (alt && (key == K_UP || key == K_DOWN)) { ed_move_lines(d, key == K_UP ? -1 : 1); break; }
        if (ctrl && (key == K_UP || key == K_DOWN)) { d->scroll_y += (key == K_UP ? -1 : 1) * U.line_h; clamp_scroll(d); break; }
        int want = d->want_x >= 0 ? d->want_x : vis_col(l, c.col);
        int delta = key == K_UP ? -1 : key == K_DOWN ? 1 : key == K_PGUP ? -page : page;
        c.line += delta;
        if (c.line < 0) { c.line = 0; want = 0; }
        if (c.line >= d->n) { c.line = d->n - 1; want = 1 << 28; }
        c.col = col_from_vis(&d->ln[c.line], want);
        move_caret(d, c, shift);
        d->want_x = want > (1 << 27) ? -1 : want; keep_x = 1;
        break; }
    case K_HOME: {
        int ws = leading_ws(l);
        if (ctrl) c = (Pos){ 0, 0 }; else c.col = c.col == ws ? 0 : ws;
        move_caret(d, c, shift); break; }
    case K_END: if (ctrl) c = (Pos){ d->n - 1, d->ln[d->n - 1].len }; else c.col = l->len; move_caret(d, c, shift); break;
    case K_BACKSPACE: ed_backspace(d, ctrl); break;
    case K_DELETE: if (shift) ed_copy(d, 1); else ed_delete(d, ctrl); break;
    case K_ENTER: if (ctrl) { move_caret(d, (Pos){ c.line, l->len }, 0); } ed_newline(d); break;
    case K_TAB: ed_indent(d, shift); break;
    case K_ESCAPE: d->anchor = d->caret; break;
    default: break;
    }
    if (!keep_x && key != 0) d->want_x = -1;
}

/* What the host's bar asks (IN_DO): what the keys do, wherever the focus is. 1 undo, 2 redo, 3 save on the file
   in view; 4 larger, 5 smaller, 6 the size it starts with. */
static void ui_do(int what) {
    Doc *d = cur();
    if (what >= 4 && what <= 6) {
        U.zoom = what == 6 ? 0 : U.zoom + (what == 4 ? 1 : -1);
        if (U.zoom < -6) U.zoom = -6;
        if (U.zoom > 16) U.zoom = 16;
        metrics_update(); U.shown_doc = NULL; session_save(); U.redraw = 1;
        return;
    }
    if (!d || what < 1 || what > 3) return;
    if (what == 1) doc_undo(d); else if (what == 2) doc_redo(d); else save_doc(d);
    if (what != 3) reveal_caret(d);
    U.redraw = 1;
}

/* The host's bar closes a file (IN_SHUT), named by its place in the project: as its own tab's cross would. */
static void ui_close_rel(const char *rel, int len) {
    size_t root = strlen(U.root);
    for (int i = 0; i < U.ndocs; i++) {
        const char *path = U.docs[i]->path;
        if (strncmp(path, U.root, root) || path[root] != '/') continue;
        if ((int)strlen(path + root + 1) == len && !memcmp(path + root + 1, rel, (size_t)len)) { request_close(i); U.redraw = 1; return; }
    }
}

/* What OUT_FILES tells: the zoom, then every open file with what is in view and what is unsaved. */
static char *files_text(void) {
    size_t cap = 32, len, root = strlen(U.root);
    for (int i = 0; i < U.ndocs; i++) cap += strlen(U.docs[i]->path) + 4;
    char *text = malloc(cap);
    if (!text) return NULL;
    len = (size_t)snprintf(text, cap, "%d", (14 + U.zoom) * 100 / 14);
    for (int i = 0; i < U.ndocs; i++) {
        const Doc *d = U.docs[i];
        const char *rel = !strncmp(d->path, U.root, root) && d->path[root] == '/' ? d->path + root + 1 : d->path;
        len += (size_t)snprintf(text + len, cap - len, "\n%c%c %s", i == U.active ? 'A' : '-', d->dirty ? 'D' : '-', rel);
    }
    return text;
}

static void ui_shortcut(int key, int mods) {
    Doc *d = cur();
    int shift = mods & M_SHIFT;
    switch (key) {
    case 'S': if (d) save_doc(d); break;
    case 'Z': if (d) { if (shift) doc_redo(d); else doc_undo(d); reveal_caret(d); } break;
    case 'Y': if (d) { doc_redo(d); reveal_caret(d); } break;
    case 'C': if (d) ed_copy(d, 0); break;
    case 'X': if (d) ed_copy(d, 1); break;
    case 'V': if (d && U.clip) ed_insert(d, U.clip, U.clip_len, 0); break;      /* host paste arrives as IN_PASTE */
    case 'A': if (d) { d->anchor = (Pos){ 0, 0 }; d->caret = (Pos){ d->n - 1, d->ln[d->n - 1].len }; } break;
    case 'L': if (d) { d->anchor = (Pos){ d->caret.line, 0 }; d->caret = d->caret.line + 1 < d->n ? (Pos){ d->caret.line + 1, 0 } : (Pos){ d->caret.line, d->ln[d->caret.line].len }; } break;
    case 'D': if (d) { if (shift) ed_duplicate(d); else if (!doc_has_selection(d)) doc_select_word(d, d->caret); else { char buf[256]; Pos a = pos_min(d->caret, d->anchor), b = pos_max(d->caret, d->anchor); if (a.line == b.line && b.col - a.col < 255) { memcpy(buf, d->ln[a.line].s + a.col, (size_t)(b.col - a.col)); buf[b.col - a.col] = 0; int keep = U.find_case; U.find_case = 1; find_next(d, buf, 1, 1); U.find_case = keep; } } } break;
    case 'K': if (d && shift) ed_delete_lines(d); break;
    case '/': if (d) ed_toggle_comment(d); break;
    case 'F': overlay_open(OV_FIND); break;
    case 'H': overlay_open(OV_REPLACE); break;
    case 'G': overlay_open(OV_GOTO); break;
    case 'P': overlay_open(OV_QUICK); break;
    case 'N': overlay_open(OV_NEW_FILE); break;
    case 'W': request_close(U.active); break;
    case 'B': if (!U.host_files) { U.sidebar_on = !U.sidebar_on; U.shown_doc = NULL; session_save(); } break;
    case K_TAB: case K_PGDN: case K_PGUP: if (U.ndocs) { U.active = (U.active + ((key == K_PGUP || shift) ? U.ndocs - 1 : 1)) % U.ndocs; U.shown_doc = NULL; } break;
    case '=': case '+': U.zoom++; metrics_update(); U.shown_doc = NULL; session_save(); break;
    case '-': U.zoom--; metrics_update(); U.shown_doc = NULL; session_save(); break;
    case '0': U.zoom = 0; metrics_update(); U.shown_doc = NULL; session_save(); break;
    default: if (d) ui_key_editor(d, key, mods); break;
    }
}

static void ui_key_tree(int key, int mods) {
    (void)mods;
    tree_rows();
    int at = -1;
    for (int i = 0; i < U.nrows; i++) if (!strcmp(U.rows[i]->path, U.sel_path)) { at = i; break; }
    Node *n = at >= 0 ? U.rows[at] : NULL;
    switch (key) {
    case K_UP: if (at > 0) at--; else if (at < 0 && U.nrows) at = 0; break;
    case K_DOWN: if (at + 1 < U.nrows) at++; break;
    case K_LEFT: if (n && n->is_dir && n->expanded) n->expanded = 0; else if (n && n->parent != U.tree) { snprintf(U.sel_path, sizeof U.sel_path, "%s", n->parent->path); return; } break;
    case K_RIGHT: if (n && n->is_dir && !n->expanded) tree_activate(n); break;
    case K_ENTER: if (n) tree_activate(n); return;
    case K_DELETE: if (n) overlay_open(OV_DELETE); return;
    case K_F1 + 1: if (n) overlay_open(OV_RENAME); return;                     /* F2 */
    case K_ESCAPE: U.focus = FOCUS_EDITOR; return;
    }
    if (at >= 0 && at < U.nrows) {
        snprintf(U.sel_path, sizeof U.sel_path, "%s", U.rows[at]->path);
        int y = at * row_h(), view = r_sidebar().h - tree_top();
        if (y < U.tree_scroll) U.tree_scroll = y;
        if (y + row_h() > U.tree_scroll + view) U.tree_scroll = y + row_h() - view;
    }
}

static void ui_key(int down, int key, int mods) {
    if (!down) return;
    U.redraw = 1; U.blink_at = now_ms(); U.caret_on = 1;
    int ctrl = mods & (M_CTRL | M_META);
    if (U.drag == DRAG_TREE_MOVE && key == K_ESCAPE) { U.drag = DRAG_NONE; U.drop_ok = 0; U.hover_path[0] = 0; return; }
    if (U.menu) {
        if (key == K_UP || key == K_DOWN) {
            for (int step = 1; step <= U.menu_n; step++) {
                int i = ((U.menu_hot < 0 ? (key == K_UP ? 0 : -1) : U.menu_hot) + (key == K_UP ? -step : step) + U.menu_n * 2) % U.menu_n;
                if (U.menu_items[i].act && !U.menu_items[i].off) { U.menu_hot = i; break; }
            }
        } else if (key == K_ENTER) menu_run(U.menu_hot);
        else menu_close();
        return;
    }
    if (U.overlay != OV_NONE) {
        Field *f = U.field_active ? &U.field2 : &U.field;
        int confirm = U.overlay == OV_DELETE || U.overlay == OV_CLOSE_DIRTY;
        if (key == K_ESCAPE) { overlay_close(); return; }
        if (key == K_ENTER) { overlay_accept(mods); return; }
        if (confirm) return;
        if (key == K_TAB && U.overlay == OV_REPLACE) { U.field_active ^= 1; return; }
        if (U.overlay == OV_QUICK && (key == K_UP || key == K_DOWN)) { int n = U.nquick_hit < 12 ? U.nquick_hit : 12; if (n) U.quick_sel = (U.quick_sel + (key == K_UP ? n - 1 : 1)) % n; return; }
        if ((mods & M_ALT) && key == 'C') { U.find_case ^= 1; return; }
        if (key == K_F1 + 2 && cur()) { find_next(cur(), U.field.text, (mods & M_SHIFT) ? -1 : 1, 1); return; }
        if (ctrl && key == 'V') return;                                          /* paste comes as IN_PASTE */
        if (field_key(f, key, mods) == 2) {                                      /* the text changed */
            if (U.overlay == OV_QUICK) quick_filter();
            if (U.overlay == OV_FIND && cur() && U.field.len) find_next(cur(), U.field.text, 1, 0);
        }
        return;
    }
    if (key == K_F1 + 2 && cur() && U.field.len) { find_next(cur(), U.field.text, (mods & M_SHIFT) ? -1 : 1, 1); return; }   /* F3 */
    if (ctrl && key == 'E' && (mods & M_SHIFT)) { if (!U.host_files) { U.focus = FOCUS_TREE; U.sidebar_on = 1; } return; }
    if (panel_key(key, mods)) return;
    if (ctrl) { ui_shortcut(key, mods); return; }
    if (U.focus == FOCUS_TREE) { ui_key_tree(key, mods); return; }
    if (cur()) ui_key_editor(cur(), key, mods);
}

static void ui_text(const char *text, int len, int pasted) {
    U.redraw = 1; U.blink_at = now_ms(); U.caret_on = 1;
    if (!pasted) menu_close();
    if (U.overlay != OV_NONE) {
        if (U.overlay == OV_DELETE || U.overlay == OV_CLOSE_DIRTY) return;
        field_insert(U.field_active ? &U.field2 : &U.field, text, len);
        if (U.overlay == OV_QUICK) quick_filter();
        if (U.overlay == OV_FIND && cur()) find_next(cur(), U.field.text, 1, 0);
        return;
    }
    if (U.focus == FOCUS_TERM && cur_term()) { term_write_text(cur_term(), text, len, pasted); return; }
    Doc *d = cur();
    if (!d || U.focus != FOCUS_EDITOR) return;
    if (pasted) ed_insert(d, text, len, 0); else ed_type(d, text, len);
}

/* What the host's clipboard holds when the user pastes. It only ever flows inwards. */
static void ui_paste(const char *text, int len) {
    int same = U.host_clip && (int)strlen(U.host_clip) == len && !memcmp(U.host_clip, text, (size_t)len);
    if (U.clip && U.internal_newer && (same || !len)) { ui_text(U.clip, U.clip_len, 1); return; }
    free(U.host_clip); U.host_clip = malloc((size_t)len + 1); memcpy(U.host_clip, text, (size_t)len); U.host_clip[len] = 0;
    U.internal_newer = 0;
    if (len) ui_text(text, len, 1);
}

static void ui_mouse_move(int x, int y) {
    int was_x = U.mx, was_y = U.my;
    U.mx = x; U.my = y;
    if (U.menu) {
        int hot = menu_item_at(x, y);
        if (hot != U.menu_hot) { U.menu_hot = hot; U.redraw = 1; }
        if (G.cursor != CUR_ARROW) { G.cursor = CUR_ARROW; U.redraw = 1; }
        return;
    }
    if (overlay_confirm() && (rect_has(r_overlay(), x, y) || rect_has(r_overlay(), was_x, was_y))) U.redraw = 1;
    Doc *d = cur();
    Rect side = r_sidebar(), tabs = r_tabs();
    int edge = U.sidebar_on && x >= side.w - S(4) && x <= side.w + S(3) && y < side.h;
    Rect panel = r_panel();
    int panel_edge = panel.h && !U.float_min && rect_has(r_panel_corner(), x, y);
    int cursor = CUR_ARROW;
    if (U.drag == DRAG_TREE_MOVE) cursor = U.drop_ok ? CUR_GRABBING : CUR_NO_DROP;
    else if (U.drag == DRAG_SIDEBAR || edge) cursor = CUR_EW;
    else if (U.drag == DRAG_PANEL_MOVE) cursor = CUR_GRABBING;
    else if (U.drag == DRAG_PANEL || panel_edge) cursor = CUR_NS;
    else if (panel.h && rect_has(r_grid(), x, y) && U.overlay == OV_NONE) cursor = CUR_IBEAM;
    else if (panel.h && rect_has(r_panel_head(), x, y)) cursor = CUR_POINTER;
    else if (rect_has(r_status_term(), x, y)) cursor = CUR_POINTER;
    else if (d && rect_has(r_text(d), x, y) && U.overlay == OV_NONE) cursor = CUR_IBEAM;
    else if (rect_has(tabs, x, y) || rect_has(side, x, y)) cursor = CUR_POINTER;
    if (cursor != G.cursor) { G.cursor = cursor; U.redraw = 1; }
    if (U.drag == DRAG_TREE_PENDING && (abs(x - U.drag_x) > S(5) || abs(y - U.drag_y) > S(5))) U.drag = DRAG_TREE_MOVE;
    if (U.drag == DRAG_TREE_MOVE) { tree_drop_update(x, y); U.redraw = 1; return; }
    if (U.drag == DRAG_PANEL) {            /* resized from its upper edge: taller as the edge goes up */
        int h = (panel.y + panel.h - y) * 100 / U.scale100;
        U.panel_h = h < 120 ? 120 : h;
        U.shown_doc = NULL; term_resize_all(); U.redraw = 1;
    }
    else if (U.drag == DRAG_TERM_SELECT && cur_term()) term_mouse_move(cur_term(), x, y);
    else if (panel.h && cur_term() && rect_has(r_grid(), x, y) && U.drag == DRAG_NONE) term_mouse_move(cur_term(), x, y);
    else if (U.drag == DRAG_SELECT && d) { d->caret = pos_at(d, x, y); d->want_x = -1; reveal_caret(d); U.redraw = 1; }
    else if (U.drag == DRAG_SIDEBAR) { int w = x * 100 / U.scale100; U.sidebar_w = w < 140 ? 140 : w > 640 ? 640 : w; U.shown_doc = NULL; U.redraw = 1; }
    else if (U.drag == DRAG_VSCROLL && d) { Rect e = r_editor(); int track = e.h - bar_w(); d->scroll_y = (int)((long)(y - e.y - U.drag_off) * (max_scroll_y(d) + r_text(d).h) / (track > 0 ? track : 1)); clamp_scroll(d); U.redraw = 1; }
    else if (U.drag == DRAG_HSCROLL && d) { Rect t = r_text(d); int content = (doc_max_cells(d, 0, d->n < 5000 ? d->n : 5000) + 8) * U.cell_w; d->scroll_x = (int)((long)(x - t.x - U.drag_off) * content / (t.w > 0 ? t.w : 1)); clamp_scroll(d); U.redraw = 1; }
    else if (rect_has(side, x, y) || rect_has(side, was_x, was_y) || rect_has(tabs, x, y) || rect_has(tabs, was_x, was_y)) U.redraw = 1;   /* hover */
    else if (panel.h && (rect_has(r_panel_head(), x, y) || rect_has(r_panel_head(), was_x, was_y))) U.redraw = 1;
    else if (rect_has(r_status_term(), x, y) || rect_has(r_status_term(), was_x, was_y)) U.redraw = 1;
}

static void ui_mouse_button(int button, int down, int x, int y, int mods, int clicks) {
    U.mx = x; U.my = y; U.redraw = 1;
    if (U.menu) {
        /* A line runs on release, as in any menu; a press outside only closes it. */
        if (!down && (button == 0 || button == 2) && rect_has(U.menu_box, x, y)) { menu_run(menu_item_at(x, y)); return; }
        if (down && !rect_has(U.menu_box, x, y)) menu_close();
        return;
    }
    if (button == 2) {
        if (down && U.overlay == OV_NONE && U.drag == DRAG_NONE) menu_right_click(x, y);
        return;
    }
    if (!down && U.drag == DRAG_TREE_PENDING) { Node *n = tree_find(U.tree, U.drag_path); U.drag = DRAG_NONE; if (n) tree_activate(n); return; }
    if (!down && U.drag == DRAG_TREE_MOVE) { tree_drop_update(x, y); tree_drop(); U.drag = DRAG_NONE; U.drop_ok = 0; U.hover_path[0] = 0; return; }
    if (!down) { if (U.drag == DRAG_SIDEBAR || U.drag == DRAG_PANEL || U.drag == DRAG_PANEL_MOVE) session_save(); if (cur_term() && U.focus == FOCUS_TERM && U.drag == DRAG_NONE) term_mouse_button(cur_term(), button, 0, x, y, mods, clicks); U.drag = DRAG_NONE; return; }
    if (U.overlay != OV_NONE) {
        if (overlay_confirm()) {
            if (rect_has(r_confirm_button(1), x, y)) overlay_accept(0);
            else if (rect_has(r_confirm_button(0), x, y) || !rect_has(r_overlay(), x, y)) overlay_close();
            return;
        }
        if (U.overlay == OV_QUICK) {
            int w = S(560); if (w > G.w - S(40)) w = G.w - S(40);
            int bx = side_w() + (G.w - side_w() - w) / 2, ly = S(8) + S(10) + S(38);
            int row = (y - ly) / row_h();
            if (x >= bx && x < bx + w && y >= ly && row < (U.nquick_hit < 12 ? U.nquick_hit : 12)) { U.quick_sel = row; overlay_accept(0); return; }
        }
        overlay_close();
        return;
    }
    Rect side = r_sidebar(), tabs = r_tabs(), e = r_editor();
    Doc *d = cur();
    if (U.sidebar_on && x >= side.w - S(4) && x <= side.w + S(3) && y < side.h && button == 0) { U.drag = DRAG_SIDEBAR; return; }
    if (panel_mouse_button(button, down, x, y, mods, clicks)) return;
    if (button == 0 && rect_has(r_status_term(), x, y)) { panel_button(); return; }
    if (rect_has(side, x, y)) {
        U.focus = FOCUS_TREE;
        if (y < tabs_h()) {
            for (int i = 0; i < 3; i++) if (rect_has((Rect){ side.w - S(30) * (3 - i) - S(6), S(6), S(26), tabs_h() - S(12) }, x, y)) {
                if (i == 0) overlay_open(OV_NEW_FILE); else if (i == 1) overlay_open(OV_NEW_DIR); else { node_load(U.tree); tree_refresh(U.tree); }
            }
            return;
        }
        if (y < tree_top()) return;
        tree_rows();
        int row = (y - tree_top() + U.tree_scroll) / row_h();
        if (row >= 0 && row < U.nrows) {
            snprintf(U.sel_path, sizeof U.sel_path, "%s", U.rows[row]->path);
            if (button == 0) { snprintf(U.drag_path, sizeof U.drag_path, "%s", U.rows[row]->path); U.drag_x = x; U.drag_y = y; U.drag = DRAG_TREE_PENDING; }
        }
        else U.sel_path[0] = 0;
        return;
    }
    if (rect_has(tabs, x, y)) {
        int tx = tabs.x;
        for (int i = 0; i < U.ndocs; i++) {
            int w = tab_width(U.docs[i]);
            if (x >= tx && x < tx + w) {
                if (button == 1 || x >= tx + w - S(30)) request_close(i);
                else { U.active = i; U.focus = FOCUS_EDITOR; U.shown_doc = NULL; session_save(); }
                return;
            }
            tx += w;
        }
        return;
    }
    if (!d || !rect_has(e, x, y) || button != 0) return;
    U.focus = FOCUS_EDITOR;
    Rect t = r_text(d);
    if (x >= e.x + e.w - bar_w()) {
        int content = max_scroll_y(d) + t.h, track = e.h - bar_w();
        int thumb = (int)((long)track * t.h / content); if (thumb < S(28)) thumb = S(28);
        int at = (int)((long)(track - thumb) * d->scroll_y / (content - t.h > 0 ? content - t.h : 1));
        U.drag = DRAG_VSCROLL; U.drag_off = (y - e.y >= at && y - e.y < at + thumb) ? y - e.y - at : thumb / 2;
        ui_mouse_move(x, y); return;
    }
    if (y >= e.y + e.h - bar_w()) { U.drag = DRAG_HSCROLL; U.drag_off = 0; ui_mouse_move(x, y); return; }
    Pos p = pos_at(d, x < t.x ? t.x : x, y);
    doc_break_undo(d);
    if (clicks >= 3 || x < t.x) { d->anchor = (Pos){ p.line, 0 }; d->caret = p.line + 1 < d->n ? (Pos){ p.line + 1, 0 } : (Pos){ p.line, d->ln[p.line].len }; }
    else if (clicks == 2) doc_select_word(d, p);
    else { d->caret = p; if (!(mods & M_SHIFT)) d->anchor = p; U.drag = DRAG_SELECT; }
    d->want_x = -1; U.blink_at = now_ms(); U.caret_on = 1;
}

static void ui_wheel(int x, int y, int dx, int dy, int mods) {
    U.redraw = 1;
    if (mods & (M_CTRL | M_META)) { U.zoom += dy < 0 ? 1 : -1; if (U.zoom < -6) U.zoom = -6; if (U.zoom > 16) U.zoom = 16; metrics_update(); U.shown_doc = NULL; return; }
    if (rect_has(r_sidebar(), x, y)) { U.tree_scroll += dy; return; }
    if (panel_h() && rect_has(r_panel(), x, y)) { if (cur_term() && rect_has(r_grid(), x, y)) term_wheel(cur_term(), dy, mods); return; }
    Doc *d = cur();
    if (!d) return;
    if (mods & M_SHIFT) { dx = dy; dy = 0; }
    d->scroll_y += dy; d->scroll_x += dx;
    clamp_scroll(d);
}

/* The file on disk changed under an open document (the agent, git, a build). */
static void watch_files(void) {
    for (int i = 0; i < U.ndocs; i++) {
        Doc *d = U.docs[i];
        struct stat st;
        if (stat(d->path, &st) != 0 || st.st_mtime == d->mtime) continue;
        d->mtime = st.st_mtime;
        if (d->dirty) { char msg[400]; snprintf(msg, sizeof msg, TR("%s \xC3\xA8 cambiato su disco: le tue modifiche non salvate restano qui", "%s changed on disk: your unsaved changes are kept here"), d->name); toast(msg); continue; }
        char err[64];
        Doc *fresh = doc_open(d->path, err, sizeof err);
        if (!fresh) continue;
        fresh->lang = d->lang; fresh->scroll_x = d->scroll_x; fresh->scroll_y = d->scroll_y;
        fresh->caret = fresh->anchor = doc_clamp(fresh, d->caret);
        doc_free(d); U.docs[i] = fresh; U.shown_doc = NULL; U.redraw = 1;
    }
    if (tree_refresh(U.tree)) U.redraw = 1;
}

static void session_load(void) {
    FILE *f = fopen(STATE_DIR "/session", "r");
    char line[PATH_MAX + 64];
    int active = 0, panel_wanted = 0;
    while (f && fgets(line, sizeof line, f)) {
        line[strcspn(line, "\n")] = 0;
        int a, b, off;
        if (sscanf(line, "sidebar %d %d", &a, &b) == 2) { U.sidebar_w = a < 140 ? 140 : a > 640 ? 640 : a; U.sidebar_on = b != 0 && !U.host_files; }
        else if (sscanf(line, "zoom %d", &a) == 1) U.zoom = a < -6 ? -6 : a > 16 ? 16 : a;
        else if (sscanf(line, "panel %d %d", &a, &b) == 2) { U.panel_h = a < 80 ? 80 : a > 2000 ? 2000 : a; panel_wanted = b != 0; }
        else if (!strncmp(line, "float ", 6)) {
            int fx, fy, fw, fm;
            if (sscanf(line + 6, "%d %d %d %d", &fx, &fy, &fw, &fm) == 4) { U.float_x = fx < 0 ? 0 : fx; U.float_y = fy < 0 ? 0 : fy; U.float_w = fw < 0 ? 0 : fw; U.float_min = fm != 0; }
        }
        else if (sscanf(line, "active %d", &a) == 1) active = a;
        else if (sscanf(line, "open %d %d %n", &a, &b, &off) == 2 && !strncmp(line + off, U.root, strlen(U.root))) {
            if (open_path(line + off)) { Doc *d = cur(); d->caret = d->anchor = doc_clamp(d, (Pos){ a, 0 }); d->scroll_y = b; }
        } else if (!strncmp(line, "expanded ", 9)) { Node *n = tree_find(U.tree, line + 9); if (n && n->is_dir) { if (!n->loaded) node_load(n); n->expanded = 1; } }
    }
    if (f) fclose(f);
    U.toast[0] = 0;
    if (active >= 0 && active < U.ndocs) U.active = active;
    if (panel_wanted && term_open()) U.focus = FOCUS_EDITOR;        /* the panel as it was left: a fresh shell in it */
    /* Text that was never saved when the editor last went away. */
    for (int i = 0; i < MAX_DOCS; i++) {
        char p[PATH_MAX], path[PATH_MAX];
        snprintf(p, sizeof p, STATE_DIR "/recovery/%d.path", i);
        FILE *pf = fopen(p, "r"); if (!pf) continue;
        path[0] = 0; if (!fgets(path, sizeof path, pf)) path[0] = 0; fclose(pf); unlink(p);
        snprintf(p, sizeof p, STATE_DIR "/recovery/%d.text", i);
        FILE *tf = fopen(p, "rb");
        if (tf && path[0] && open_path(path)) {
            fseek(tf, 0, SEEK_END); long size = ftell(tf); fseek(tf, 0, SEEK_SET);
            char *text = malloc((size_t)size + 1);
            if (text && fread(text, 1, (size_t)size, tf) == (size_t)size) {
                Doc *d = cur();
                doc_replace(d, (Pos){ 0, 0 }, (Pos){ d->n - 1, d->ln[d->n - 1].len }, text, (int)size, 0);
                d->caret = d->anchor = (Pos){ 0, 0 };
            }
            free(text);
        }
        if (tf) fclose(tf);
        unlink(p);
    }
}
