/*
 * doc — a text document: lines of UTF-8, one caret with a selection anchor,
 * and an undo history. Every change goes through doc_replace(), so undo, the
 * dirty flag and syntax invalidation cannot drift apart.
 *
 * Positions are (line, byte column); columns always sit on a code point start.
 */

#define MAX_FILE_BYTES (64L * 1024 * 1024)

typedef struct { char *s; int len, cap; unsigned char state; } Line;
typedef struct { int line, col; } Pos;

typedef struct {
    Pos at;                 /* where the change starts */
    char *removed; int removed_len;
    char *inserted; int inserted_len;
    Pos caret_before, anchor_before;
    unsigned group;
} Edit;

typedef struct Doc {
    char path[PATH_MAX];
    char name[256];
    Line *ln; int n, cap;
    Pos caret, anchor;
    int want_x;             /* visual column kept while moving up and down; -1 = unset */
    int scroll_x, scroll_y; /* pixels */
    int crlf, dirty, lang, readonly;
    time_t mtime;
    int hl_valid;           /* lines below this index have a valid starting syntax state */
    Edit *undo; int nundo, undo_cap;
    Edit *redo; int nredo, redo_cap;
    unsigned group; int group_open; long group_ms;
    unsigned saved_group_mark; int saved_nundo;
} Doc;

static int pos_cmp(Pos a, Pos b) { return a.line != b.line ? (a.line < b.line ? -1 : 1) : (a.col < b.col ? -1 : a.col > b.col); }
static Pos pos_min(Pos a, Pos b) { return pos_cmp(a, b) <= 0 ? a : b; }
static Pos pos_max(Pos a, Pos b) { return pos_cmp(a, b) <= 0 ? b : a; }
static int doc_has_selection(Doc *d) { return pos_cmp(d->caret, d->anchor) != 0; }

static void line_reserve(Line *l, int need) {
    if (need <= l->cap) return;
    int cap = l->cap ? l->cap : 32;
    while (cap < need) cap *= 2;
    l->s = realloc(l->s, (size_t)cap);
    if (!l->s) { perror("out of memory"); exit(1); }
    l->cap = cap;
}

static void doc_insert_lines(Doc *d, int at, int count) {
    if (d->n + count > d->cap) {
        int cap = d->cap ? d->cap : 256;
        while (cap < d->n + count) cap *= 2;
        d->ln = realloc(d->ln, (size_t)cap * sizeof(Line));
        if (!d->ln) { perror("out of memory"); exit(1); }
        d->cap = cap;
    }
    memmove(d->ln + at + count, d->ln + at, (size_t)(d->n - at) * sizeof(Line));
    memset(d->ln + at, 0, (size_t)count * sizeof(Line));
    d->n += count;
}

static Pos doc_clamp(Doc *d, Pos p) {
    if (p.line < 0) p.line = 0;
    if (p.line >= d->n) p.line = d->n - 1;
    if (p.col < 0) p.col = 0;
    if (p.col > d->ln[p.line].len) p.col = d->ln[p.line].len;
    while (p.col > 0 && p.col < d->ln[p.line].len && ((unsigned char)d->ln[p.line].s[p.col] & 0xC0) == 0x80) p.col--;
    return p;
}

/* Text between two positions, lines joined by '\n'. Caller frees. */
static char *doc_range(Doc *d, Pos a, Pos b, int *out_len) {
    size_t len = 0;
    for (int l = a.line; l <= b.line; l++) {
        int from = l == a.line ? a.col : 0, to = l == b.line ? b.col : d->ln[l].len;
        len += (size_t)(to - from) + (l < b.line ? 1 : 0);
    }
    char *buf = malloc(len + 1), *p = buf;
    if (!buf) { perror("out of memory"); exit(1); }
    for (int l = a.line; l <= b.line; l++) {
        int from = l == a.line ? a.col : 0, to = l == b.line ? b.col : d->ln[l].len;
        memcpy(p, d->ln[l].s + from, (size_t)(to - from)); p += to - from;
        if (l < b.line) *p++ = '\n';
    }
    *p = 0;
    *out_len = (int)len;
    return buf;
}

/* Raw change, no history. Returns the position after the inserted text. */
static Pos doc_splice(Doc *d, Pos a, Pos b, const char *text, int len) {
    /* Delete a..b: keep the head of line a and the tail of line b. */
    Line *la = &d->ln[a.line];
    int tail_len = d->ln[b.line].len - b.col;
    char *tail = malloc((size_t)tail_len + 1);
    if (!tail) { perror("out of memory"); exit(1); }
    memcpy(tail, d->ln[b.line].s + b.col, (size_t)tail_len);
    for (int l = a.line + 1; l <= b.line; l++) free(d->ln[l].s);
    if (b.line > a.line) {
        memmove(d->ln + a.line + 1, d->ln + b.line + 1, (size_t)(d->n - b.line - 1) * sizeof(Line));
        d->n -= b.line - a.line;
    }
    la = &d->ln[a.line];
    la->len = a.col;
    /* Insert the text, line by line. */
    Pos end = a;
    int start = 0;
    for (int i = 0; i <= len; i++) {
        if (i < len && text[i] != '\n') continue;
        int seg = i - start;
        if (seg > 0 && i < len && text[start + seg - 1] == '\r') seg--;      /* pasted CRLF */
        Line *cur = &d->ln[end.line];
        line_reserve(cur, cur->len + seg + 1);
        memcpy(cur->s + cur->len, text + start, (size_t)seg);
        cur->len += seg;
        end.col = cur->len;
        if (i < len) { doc_insert_lines(d, end.line + 1, 1); end.line++; end.col = 0; }
        start = i + 1;
    }
    Line *last = &d->ln[end.line];
    line_reserve(last, last->len + tail_len + 1);
    memcpy(last->s + last->len, tail, (size_t)tail_len);
    last->len += tail_len;
    free(tail);
    if (d->hl_valid > a.line + 1) d->hl_valid = a.line + 1;
    return end;
}

static void edits_free(Edit *e, int n) { for (int i = 0; i < n; i++) { free(e[i].removed); free(e[i].inserted); } }

static Edit *edit_push(Edit **list, int *n, int *cap) {
    if (*n == *cap) {
        *cap = *cap ? *cap * 2 : 64;
        *list = realloc(*list, (size_t)*cap * sizeof(Edit));
        if (!*list) { perror("out of memory"); exit(1); }
    }
    Edit *e = &(*list)[(*n)++];
    memset(e, 0, sizeof *e);
    return e;
}

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

/* Ends the current undo group: the next change starts a new step. */
static void doc_break_undo(Doc *d) { d->group_open = 0; }

/*
 * The one way to change a document. `typing` lets consecutive keystrokes share
 * an undo step as long as they follow each other closely.
 */
static Pos doc_replace(Doc *d, Pos a, Pos b, const char *text, int len, int typing) {
    if (d->readonly) return d->caret;
    a = doc_clamp(d, a); b = doc_clamp(d, b);
    if (pos_cmp(a, b) > 0) { Pos t = a; a = b; b = t; }
    if (!len && !pos_cmp(a, b)) return a;
    long t = now_ms();
    if (!typing || !d->group_open || t - d->group_ms > 1200) { d->group++; d->group_open = typing; }
    d->group_ms = t;
    Edit *e = edit_push(&d->undo, &d->nundo, &d->undo_cap);
    e->at = a;
    e->removed = doc_range(d, a, b, &e->removed_len);
    e->inserted = malloc((size_t)len + 1);
    if (!e->inserted) { perror("out of memory"); exit(1); }
    memcpy(e->inserted, text, (size_t)len); e->inserted[len] = 0;
    e->inserted_len = len;
    e->caret_before = d->caret; e->anchor_before = d->anchor;
    e->group = d->group;
    edits_free(d->redo, d->nredo); d->nredo = 0;
    Pos end = doc_splice(d, a, b, text, len);
    d->caret = d->anchor = end;
    d->want_x = -1;
    d->dirty = 1;
    return end;
}

/* Position reached after inserting `len` bytes of `text` at `a`. */
static Pos text_end(Pos a, const char *text, int len) {
    Pos p = a;
    for (int i = 0; i < len; i++) {
        if (text[i] == '\n') { p.line++; p.col = 0; }
        else if (!(text[i] == '\r' && i + 1 < len && text[i + 1] == '\n')) p.col++;
    }
    return p;
}

static int doc_undo(Doc *d) {
    if (!d->nundo) return 0;
    unsigned group = d->undo[d->nundo - 1].group;
    while (d->nundo && d->undo[d->nundo - 1].group == group) {
        Edit e = d->undo[--d->nundo];
        doc_splice(d, e.at, text_end(e.at, e.inserted, e.inserted_len), e.removed, e.removed_len);
        d->caret = doc_clamp(d, e.caret_before); d->anchor = doc_clamp(d, e.anchor_before);
        *edit_push(&d->redo, &d->nredo, &d->redo_cap) = e;
    }
    d->group_open = 0; d->want_x = -1;
    d->dirty = d->nundo != d->saved_nundo;
    return 1;
}

static int doc_redo(Doc *d) {
    if (!d->nredo) return 0;
    unsigned group = d->redo[d->nredo - 1].group;
    while (d->nredo && d->redo[d->nredo - 1].group == group) {
        Edit e = d->redo[--d->nredo];
        Pos end = doc_splice(d, e.at, text_end(e.at, e.removed, e.removed_len), e.inserted, e.inserted_len);
        d->caret = d->anchor = end;
        *edit_push(&d->undo, &d->nundo, &d->undo_cap) = e;
    }
    d->group_open = 0; d->want_x = -1;
    d->dirty = d->nundo != d->saved_nundo;
    return 1;
}

static void doc_free(Doc *d) {
    for (int i = 0; i < d->n; i++) free(d->ln[i].s);
    free(d->ln);
    edits_free(d->undo, d->nundo); free(d->undo);
    edits_free(d->redo, d->nredo); free(d->redo);
    free(d);
}

static void doc_set_text(Doc *d, const char *data, size_t size) {
    for (int i = 0; i < d->n; i++) free(d->ln[i].s);
    d->n = 0;
    doc_insert_lines(d, 0, 1);
    d->crlf = 0;
    size_t start = 0;
    int line = 0;
    for (size_t i = 0; i <= size; i++) {
        if (i < size && data[i] != '\n') continue;
        size_t seg = i - start;
        if (seg > 0 && data[start + seg - 1] == '\r') { seg--; d->crlf = 1; }
        line_reserve(&d->ln[line], (int)seg + 1);
        memcpy(d->ln[line].s, data + start, seg);
        d->ln[line].len = (int)seg;
        if (i < size) { doc_insert_lines(d, d->n, 1); line++; }
        start = i + 1;
    }
    d->hl_valid = 0;
}

/* Loads a file. Returns NULL with a reason in `err` for what an editor must not open as text. */
static Doc *doc_open(const char *path, char *err, size_t err_size) {
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) { snprintf(err, err_size, "%s", strerror(errno ? errno : EINVAL)); return NULL; }
    if (st.st_size > MAX_FILE_BYTES) { snprintf(err, err_size, "file too large (%ld MB)", (long)(st.st_size >> 20)); return NULL; }
    FILE *f = fopen(path, "rb");
    if (!f) { snprintf(err, err_size, "%s", strerror(errno)); return NULL; }
    char *data = malloc((size_t)st.st_size + 1);
    if (!data) { fclose(f); snprintf(err, err_size, "out of memory"); return NULL; }
    size_t size = fread(data, 1, (size_t)st.st_size, f);
    fclose(f);
    size_t probe = size < 8192 ? size : 8192;
    if (memchr(data, 0, probe)) { free(data); snprintf(err, err_size, "binary file"); return NULL; }
    Doc *d = calloc(1, sizeof(Doc));
    if (!d) { free(data); snprintf(err, err_size, "out of memory"); return NULL; }
    snprintf(d->path, sizeof d->path, "%s", path);
    const char *slash = strrchr(path, '/');
    snprintf(d->name, sizeof d->name, "%s", slash ? slash + 1 : path);
    size_t skip = size >= 3 && !memcmp(data, "\xEF\xBB\xBF", 3) ? 3 : 0;      /* UTF-8 BOM */
    doc_set_text(d, data + skip, size - skip);
    free(data);
    d->mtime = st.st_mtime;
    d->want_x = -1;
    d->readonly = access(path, W_OK) != 0;
    return d;
}

/* Writes next to the file and renames over it: a crash never leaves half a file. */
static int doc_save(Doc *d, char *err, size_t err_size) {
    char tmp[PATH_MAX + 16];
    snprintf(tmp, sizeof tmp, "%s.synthorg-tmp", d->path);
    struct stat st;
    mode_t mode = stat(d->path, &st) == 0 ? st.st_mode & 0777 : 0644;
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0) { snprintf(err, err_size, "%s", strerror(errno)); return 0; }
    FILE *f = fdopen(fd, "wb");
    int ok = f != NULL;
    for (int i = 0; ok && i < d->n; i++) {
        if (d->ln[i].len && fwrite(d->ln[i].s, 1, (size_t)d->ln[i].len, f) != (size_t)d->ln[i].len) ok = 0;
        if (ok && i + 1 < d->n && fputs(d->crlf ? "\r\n" : "\n", f) == EOF) ok = 0;
    }
    if (f && fflush(f) != 0) ok = 0;
    if (f && fsync(fd) != 0) ok = 0;
    if (f) fclose(f); else close(fd);
    if (!ok || rename(tmp, d->path) != 0) { snprintf(err, err_size, "%s", strerror(errno)); unlink(tmp); return 0; }
    if (stat(d->path, &st) == 0) d->mtime = st.st_mtime;
    d->dirty = 0;
    d->saved_nundo = d->nundo;
    doc_break_undo(d);
    return 1;
}

/* ---- words --------------------------------------------------------------- */

static int is_word_byte(unsigned char c) { return c >= 0x80 || isalnum(c) || c == '_'; }

static Pos doc_word_left(Doc *d, Pos p) {
    if (p.col == 0) { if (p.line > 0) { p.line--; p.col = d->ln[p.line].len; } return p; }
    const char *s = d->ln[p.line].s;
    while (p.col > 0 && !is_word_byte((unsigned char)s[p.col - 1])) p.col--;
    while (p.col > 0 && is_word_byte((unsigned char)s[p.col - 1])) p.col--;
    return p;
}
static Pos doc_word_right(Doc *d, Pos p) {
    Line *l = &d->ln[p.line];
    if (p.col >= l->len) { if (p.line + 1 < d->n) { p.line++; p.col = 0; } return p; }
    while (p.col < l->len && is_word_byte((unsigned char)l->s[p.col])) p.col++;
    while (p.col < l->len && !is_word_byte((unsigned char)l->s[p.col])) p.col++;
    return p;
}
static void doc_select_word(Doc *d, Pos p) {
    Line *l = &d->ln[p.line];
    int a = p.col, b = p.col;
    if (a < l->len && is_word_byte((unsigned char)l->s[a])) {
        while (a > 0 && is_word_byte((unsigned char)l->s[a - 1])) a--;
        while (b < l->len && is_word_byte((unsigned char)l->s[b])) b++;
    } else if (b < l->len) {
        int i = b; utf8_next(l->s, l->len, &i); b = i;
    }
    d->anchor = (Pos){ p.line, a }; d->caret = (Pos){ p.line, b };
}
