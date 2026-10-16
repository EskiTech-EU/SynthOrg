/*
 * gfx — the editor's whole graphics stack.
 *
 * A CPU framebuffer, two TrueType faces rasterised once per glyph and cached,
 * and a presenter that sends the host only what changed since the last frame:
 * run-length encoded rectangles, plus a "copy" for scrolls. There is no window
 * system, no GL and no device: the only thing that leaves the container is
 * pixels, and the host does nothing with them but paint.
 *
 * Wire format (editor -> host), little endian:  u8 type, u32 length, payload
 *   OUT_RESIZE  u16 w, u16 h
 *   OUT_COPY    u16 sx, sy, w, h, dx, dy
 *   OUT_RECT    u16 x, y, w, h, then tokens until w*h pixels are produced:
 *                 n < 128  -> one RGB pixel follows, repeated n+1 times
 *                 n >= 128 -> n-127 RGB pixels follow
 *   OUT_FRAME   (empty) everything since the previous OUT_FRAME is one frame
 *   OUT_CURSOR  u8 shape
 *   OUT_PASTE   (empty) the user chose Paste from a menu: send the host's clipboard in
 *   OUT_SIDEBAR u16 w, u16 top: the file tree's width and where its title ends, when they
 *               change — the host draws its own strip between the title and the rows (IN_INSET)
 *   OUT_FILES   utf-8, when it changes: what the host shows in its own bar. A first line with the
 *               zoom as a percentage, then a line for each open file: a letter for the one in view
 *               ('A', else '-'), a letter for unsaved changes ('D', else '-'), a space, and its
 *               place in the project
 */

typedef uint32_t Color;                     /* bytes in memory: R, G, B, A */
#define RGB(r, g, b) (0xFF000000u | ((uint32_t)(b) << 16) | ((uint32_t)(g) << 8) | (uint32_t)(r))
#define C_R(c) ((c) & 0xFF)
#define C_G(c) (((c) >> 8) & 0xFF)
#define C_B(c) (((c) >> 16) & 0xFF)

typedef struct { int x, y, w, h; } Rect;

enum { OUT_RESIZE = 1, OUT_RECT = 2, OUT_COPY = 3, OUT_FRAME = 4, OUT_CURSOR = 5, OUT_PASTE = 6, OUT_SIDEBAR = 7, OUT_FILES = 8 };
enum { CUR_ARROW, CUR_IBEAM, CUR_POINTER, CUR_EW, CUR_NS, CUR_GRABBING, CUR_NO_DROP, CUR_NWSE };
enum { FACE_MONO, FACE_UI, FACE_COUNT };

#define TILE_W 64
#define TILE_H 16

typedef struct {
    uint32_t key;                           /* face << 30 | px << 21 | codepoint; 0 = empty */
    int w, h, xoff, yoff, advance;
    unsigned char *bitmap;
} Glyph;

typedef struct {
    stbtt_fontinfo info;
    unsigned char *data;
    int loaded;
} Face;

static struct {
    int w, h;
    Color *fb, *prev;
    Rect clip;
    Face face[FACE_COUNT];
    Glyph *glyphs; int glyph_cap, glyph_count;
    unsigned char *out; size_t out_len, out_cap;
    int cursor, cursor_sent;
    int want_paste;                         /* OUT_PASTE goes out with the next frame */
    int side_w, side_top, side_sent_w, side_sent_top;   /* OUT_SIDEBAR goes out when these differ */
    char *files, *files_sent;               /* OUT_FILES goes out when these differ, and once at the start */
    int resized;
} G;

/* ---- output buffer ------------------------------------------------------ */

static void out_reserve(size_t extra) {
    if (G.out_len + extra <= G.out_cap) return;
    size_t cap = G.out_cap ? G.out_cap : 1 << 16;
    while (cap < G.out_len + extra) cap *= 2;
    G.out = realloc(G.out, cap);
    if (!G.out) { perror("out of memory"); exit(1); }
    G.out_cap = cap;
}
static void out_u8(unsigned v) { out_reserve(1); G.out[G.out_len++] = (unsigned char)v; }
static void out_u16(unsigned v) { out_u8(v & 0xFF); out_u8((v >> 8) & 0xFF); }
static size_t out_begin(int type) { out_u8(type); out_reserve(4); G.out_len += 4; return G.out_len; }
static void out_end(size_t start) {
    uint32_t len = (uint32_t)(G.out_len - start);
    unsigned char *p = G.out + start - 4;
    p[0] = len & 0xFF; p[1] = (len >> 8) & 0xFF; p[2] = (len >> 16) & 0xFF; p[3] = (len >> 24) & 0xFF;
}
static void out_flush(void) {
    size_t done = 0;
    while (done < G.out_len) {
        ssize_t n = write(STDOUT_FILENO, G.out + done, G.out_len - done);
        if (n < 0) { if (errno == EINTR || errno == EAGAIN) continue; exit(0); }   /* host gone */
        done += (size_t)n;
    }
    G.out_len = 0;
}

/* ---- framebuffer -------------------------------------------------------- */

static Rect rect_intersect(Rect a, Rect b) {
    int x0 = a.x > b.x ? a.x : b.x, y0 = a.y > b.y ? a.y : b.y;
    int x1 = (a.x + a.w < b.x + b.w) ? a.x + a.w : b.x + b.w;
    int y1 = (a.y + a.h < b.y + b.h) ? a.y + a.h : b.y + b.h;
    Rect r = { x0, y0, x1 - x0, y1 - y0 };
    if (r.w < 0) r.w = 0;
    if (r.h < 0) r.h = 0;
    return r;
}
static int rect_has(Rect r, int x, int y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }

static void gfx_resize(int w, int h) {
    if (w < 64) w = 64;
    if (h < 64) h = 64;
    if (w > 8192) w = 8192;
    if (h > 8192) h = 8192;
    if (w == G.w && h == G.h) return;
    free(G.fb); free(G.prev);
    G.w = w; G.h = h;
    G.fb = calloc((size_t)w * h, sizeof(Color));
    G.prev = calloc((size_t)w * h, sizeof(Color));
    if (!G.fb || !G.prev) { perror("out of memory"); exit(1); }
    G.clip = (Rect){ 0, 0, w, h };
    G.resized = 1;
}

static void gfx_clip(Rect r) { G.clip = rect_intersect(r, (Rect){ 0, 0, G.w, G.h }); }
static void gfx_unclip(void) { G.clip = (Rect){ 0, 0, G.w, G.h }; }

static void gfx_fill(Rect r, Color c) {
    r = rect_intersect(r, G.clip);
    for (int y = r.y; y < r.y + r.h; y++) {
        Color *row = G.fb + (size_t)y * G.w + r.x;
        for (int x = 0; x < r.w; x++) row[x] = c;
    }
}

static Color blend(Color dst, Color src, unsigned a) {
    unsigned ia = 255 - a;
    unsigned r = (C_R(src) * a + C_R(dst) * ia + 127) / 255;
    unsigned g = (C_G(src) * a + C_G(dst) * ia + 127) / 255;
    unsigned b = (C_B(src) * a + C_B(dst) * ia + 127) / 255;
    return RGB(r, g, b);
}

/* A translucent fill: selections and highlights sit on top of whatever is there. */
static void gfx_tint(Rect r, Color c, unsigned alpha) {
    r = rect_intersect(r, G.clip);
    for (int y = r.y; y < r.y + r.h; y++) {
        Color *row = G.fb + (size_t)y * G.w + r.x;
        for (int x = 0; x < r.w; x++) row[x] = blend(row[x], c, alpha);
    }
}

static void gfx_frame(Rect r, Color c) {
    gfx_fill((Rect){ r.x, r.y, r.w, 1 }, c);
    gfx_fill((Rect){ r.x, r.y + r.h - 1, r.w, 1 }, c);
    gfx_fill((Rect){ r.x, r.y, 1, r.h }, c);
    gfx_fill((Rect){ r.x + r.w - 1, r.y, 1, r.h }, c);
}

/* A stroked polyline, antialiased: every pixel takes its distance to the nearest
 * segment, so joints are blended once and stay as light as the strokes. */
static void gfx_path(const float *pts, int n, float width, Color c) {
    if (n < 2) return;
    float r = width / 2, x0 = pts[0], y0 = pts[1], x1 = x0, y1 = y0;
    for (int i = 1; i < n; i++) {
        float x = pts[2 * i], y = pts[2 * i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    Rect box = rect_intersect((Rect){ (int)(x0 - r - 1), (int)(y0 - r - 1), (int)(x1 - x0 + 2 * r + 3), (int)(y1 - y0 + 2 * r + 3) }, G.clip);
    for (int y = box.y; y < box.y + box.h; y++) {
        Color *row = G.fb + (size_t)y * G.w;
        for (int x = box.x; x < box.x + box.w; x++) {
            float px = x + 0.5f, py = y + 0.5f, best = 1e9f;
            for (int i = 0; i + 1 < n; i++) {
                float ax = pts[2 * i], ay = pts[2 * i + 1], dx = pts[2 * i + 2] - ax, dy = pts[2 * i + 3] - ay;
                float len = dx * dx + dy * dy, t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
                if (t < 0) t = 0; else if (t > 1) t = 1;
                float ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
                if (d < best) best = d;
            }
            float cover = r + 0.5f - sqrtf(best);
            if (cover <= 0) continue;
            row[x] = cover >= 1 ? c : blend(row[x], c, (unsigned)(cover * 255));
        }
    }
}

/* The few icons the editor draws, as strokes on a 16-unit grid centred in b (codicon shapes). */
enum { ICON_ADD, ICON_CLOSE, ICON_CHEVRON_DOWN, ICON_TERMINAL, ICON_NEW_FILE, ICON_NEW_FOLDER, ICON_REFRESH, ICON_CHEVRON_RIGHT };

static void gfx_icon(int icon, Rect b, int size, Color c) {
    float u = size / 16.0f, ox = b.x + (b.w - size) / 2.0f, oy = b.y + (b.h - size) / 2.0f, w = u < 1 ? 1 : u * 1.15f;
#define P(...) do { const float raw[] = { __VA_ARGS__ }; float p[sizeof raw / sizeof *raw]; \
        for (unsigned k = 0; k < sizeof raw / sizeof *raw; k += 2) { p[k] = ox + raw[k] * u; p[k + 1] = oy + raw[k + 1] * u; } \
        gfx_path(p, (int)(sizeof raw / sizeof *raw / 2), w, c); } while (0)
    switch (icon) {
    case ICON_ADD: P(8, 2.5f, 8, 13.5f); P(2.5f, 8, 13.5f, 8); break;
    case ICON_CLOSE: P(4, 4, 12, 12); P(12, 4, 4, 12); break;
    case ICON_CHEVRON_DOWN: P(3.5f, 6, 8, 10.5f, 12.5f, 6); break;
    case ICON_CHEVRON_RIGHT: P(6, 3.5f, 10.5f, 8, 6, 12.5f); break;
    case ICON_TERMINAL:
        P(2, 3, 14, 3, 14, 13, 2, 13, 2, 3);
        P(4.5f, 6, 6.8f, 8, 4.5f, 10); P(8, 10.5f, 11.5f, 10.5f); break;
    case ICON_NEW_FILE:
        P(8, 14, 2.5f, 14, 2.5f, 2, 8.5f, 2, 12, 5.5f, 12, 8.5f); P(8.5f, 2, 8.5f, 5.5f, 12, 5.5f); P(12, 9.5f, 12, 14.5f); P(9.5f, 12, 14.5f, 12); break;
    case ICON_NEW_FOLDER:
        P(8.5f, 13, 1.5f, 13, 1.5f, 3, 6, 3, 7.5f, 4.5f, 14.5f, 4.5f, 14.5f, 8.5f); P(12, 9.5f, 12, 14.5f); P(9.5f, 12, 14.5f, 12); break;
    case ICON_REFRESH: {                                  /* clockwise from the right round to the top, the arrow pointing on */
        float p[2 * 17]; int k = 0;
        for (int i = 0; i <= 16; i++) { float a = 0.35f + i * (4.36f / 16); p[k++] = ox + (8 + 5.5f * cosf(a)) * u; p[k++] = oy + (8 + 5.5f * sinf(a)) * u; }
        gfx_path(p, 17, w, c);
        P(5.8f, -0.2f, 8.4f, 2.5f, 5.8f, 5.2f); break; }
    }
#undef P
}

/* ---- fonts -------------------------------------------------------------- */

static int face_load(int face, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *data = malloc((size_t)size);
    if (!data || fread(data, 1, (size_t)size, f) != (size_t)size) { fclose(f); free(data); return 0; }
    fclose(f);
    if (!stbtt_InitFont(&G.face[face].info, data, stbtt_GetFontOffsetForIndex(data, 0))) { free(data); return 0; }
    G.face[face].data = data;
    G.face[face].loaded = 1;
    return 1;
}

static Glyph *glyph_slot(uint32_t key) {
    if (G.glyph_count * 2 >= G.glyph_cap) {
        int old_cap = G.glyph_cap;
        Glyph *old = G.glyphs;
        G.glyph_cap = old_cap ? old_cap * 2 : 1024;
        G.glyphs = calloc((size_t)G.glyph_cap, sizeof(Glyph));
        if (!G.glyphs) { perror("out of memory"); exit(1); }
        for (int i = 0; i < old_cap; i++) {
            if (!old[i].key) continue;
            uint32_t h = (old[i].key * 2654435761u) & (uint32_t)(G.glyph_cap - 1);
            while (G.glyphs[h].key) h = (h + 1) & (uint32_t)(G.glyph_cap - 1);
            G.glyphs[h] = old[i];
        }
        free(old);
    }
    uint32_t h = (key * 2654435761u) & (uint32_t)(G.glyph_cap - 1);
    while (G.glyphs[h].key && G.glyphs[h].key != key) h = (h + 1) & (uint32_t)(G.glyph_cap - 1);
    return &G.glyphs[h];
}

static Glyph *glyph_get(int face, int px, int cp) {
    if (cp < 0 || cp > 0x1FFFFF) cp = 0xFFFD;
    if (px > 255) px = 255;
    uint32_t key = ((uint32_t)(face + 1) << 30) | ((uint32_t)px << 21) | (uint32_t)cp;
    Glyph *g = glyph_slot(key);
    if (g->key) return g;
    Face *f = &G.face[face];
    float scale = stbtt_ScaleForPixelHeight(&f->info, (float)px);
    int index = stbtt_FindGlyphIndex(&f->info, cp);
    if (!index && cp != ' ') index = stbtt_FindGlyphIndex(&f->info, 0xFFFD);
    if (!index && cp != ' ') index = stbtt_FindGlyphIndex(&f->info, '?');
    int adv, lsb;
    stbtt_GetGlyphHMetrics(&f->info, index, &adv, &lsb);
    g->key = key;
    g->advance = (int)(adv * scale + 0.5f);
    g->bitmap = stbtt_GetGlyphBitmap(&f->info, scale, scale, index, &g->w, &g->h, &g->xoff, &g->yoff);
    G.glyph_count++;
    return g;
}

static int font_ascent(int face, int px) {
    int a, d, l;
    stbtt_GetFontVMetrics(&G.face[face].info, &a, &d, &l);
    return (int)(a * stbtt_ScaleForPixelHeight(&G.face[face].info, (float)px) + 0.5f);
}

static void glyph_draw(Glyph *g, int x, int baseline, Color c) {
    if (!g->bitmap) return;
    int gx = x + g->xoff, gy = baseline + g->yoff;
    Rect r = rect_intersect((Rect){ gx, gy, g->w, g->h }, G.clip);
    for (int y = r.y; y < r.y + r.h; y++) {
        Color *row = G.fb + (size_t)y * G.w;
        const unsigned char *src = g->bitmap + (size_t)(y - gy) * g->w;
        for (int x2 = r.x; x2 < r.x + r.w; x2++) {
            unsigned a = src[x2 - gx];
            if (a == 255) row[x2] = c;
            else if (a) row[x2] = blend(row[x2], c, a);
        }
    }
}

/* Decodes one UTF-8 sequence; malformed input yields U+FFFD and advances one byte. */
static int utf8_next(const char *s, int len, int *i) {
    unsigned char c = (unsigned char)s[*i];
    int n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
    if (!n || *i + n > len) { (*i)++; return 0xFFFD; }
    int cp = n == 1 ? c : c & (0xFF >> (n + 1));
    for (int k = 1; k < n; k++) {
        unsigned char cc = (unsigned char)s[*i + k];
        if ((cc & 0xC0) != 0x80) { (*i)++; return 0xFFFD; }
        cp = (cp << 6) | (cc & 0x3F);
    }
    *i += n;
    return cp;
}
static int utf8_prev_start(const char *s, int i) {
    if (i <= 0) return 0;
    i--;
    while (i > 0 && ((unsigned char)s[i] & 0xC0) == 0x80) i--;
    return i;
}

/* Proportional text (the interface). Returns the x after the last glyph. */
static int gfx_text(int face, int px, int x, int baseline, const char *s, int len, Color c) {
    if (len < 0) len = (int)strlen(s);
    for (int i = 0; i < len;) {
        Glyph *g = glyph_get(face, px, utf8_next(s, len, &i));
        if (x + g->advance > G.clip.x && x < G.clip.x + G.clip.w) glyph_draw(g, x, baseline, c);
        x += g->advance;
    }
    return x;
}
static int gfx_text_width(int face, int px, const char *s, int len) {
    if (len < 0) len = (int)strlen(s);
    int w = 0;
    for (int i = 0; i < len;) w += glyph_get(face, px, utf8_next(s, len, &i))->advance;
    return w;
}
/* Text cut with an ellipsis when it does not fit in max_w. */
static void gfx_text_fit(int face, int px, int x, int baseline, const char *s, int max_w, Color c) {
    int len = (int)strlen(s);
    if (gfx_text_width(face, px, s, len) <= max_w) { gfx_text(face, px, x, baseline, s, len, c); return; }
    int ell = gfx_text_width(face, px, "\xE2\x80\xA6", 3), w = 0, i = 0;
    while (i < len) {
        int j = i;
        int adv = glyph_get(face, px, utf8_next(s, len, &j))->advance;
        if (w + adv + ell > max_w) break;
        w += adv; i = j;
    }
    x = gfx_text(face, px, x, baseline, s, i, c);
    gfx_text(face, px, x, baseline, "\xE2\x80\xA6", 3, c);
}

/* ---- presenting: only what changed -------------------------------------- */

static void encode_rect(Rect r) {
    size_t start = out_begin(OUT_RECT);
    out_u16((unsigned)r.x); out_u16((unsigned)r.y); out_u16((unsigned)r.w); out_u16((unsigned)r.h);
    size_t total = (size_t)r.w * r.h, i = 0;
    /* The rectangle as one contiguous run of pixels, so runs can cross row ends. */
    static Color *lin; static size_t lin_cap;
    if (total > lin_cap) { lin = realloc(lin, total * sizeof(Color)); lin_cap = total; if (!lin) { perror("out of memory"); exit(1); } }
    for (int y = 0; y < r.h; y++) memcpy(lin + (size_t)y * r.w, G.fb + (size_t)(r.y + y) * G.w + r.x, (size_t)r.w * sizeof(Color));
    #define PIX(k) (lin[k] & 0x00FFFFFFu)
    while (i < total) {
        uint32_t p = PIX(i);
        size_t run = 1;
        while (i + run < total && run < 128 && PIX(i + run) == p) run++;
        if (run >= 2) {
            out_reserve(4);
            G.out[G.out_len++] = (unsigned char)(run - 1);
            G.out[G.out_len++] = p & 0xFF; G.out[G.out_len++] = (p >> 8) & 0xFF; G.out[G.out_len++] = (p >> 16) & 0xFF;
            i += run;
            continue;
        }
        size_t lit = 1;
        while (i + lit < total && lit < 128) {
            if (i + lit + 1 < total && PIX(i + lit) == PIX(i + lit + 1)) break;   /* a run starts here */
            lit++;
        }
        out_reserve(1 + lit * 3);
        G.out[G.out_len++] = (unsigned char)(127 + lit);
        for (size_t k = 0; k < lit; k++) {
            uint32_t q = PIX(i + k);
            G.out[G.out_len++] = q & 0xFF; G.out[G.out_len++] = (q >> 8) & 0xFF; G.out[G.out_len++] = (q >> 16) & 0xFF;
        }
        i += lit;
    }
    #undef PIX
    out_end(start);
    for (int y = r.y; y < r.y + r.h; y++)
        memcpy(G.prev + (size_t)y * G.w + r.x, G.fb + (size_t)y * G.w + r.x, (size_t)r.w * sizeof(Color));
}

/*
 * Tells the host to move pixels it already has (a scroll). The same move is
 * applied to our copy of what the host shows, so the diff that follows only
 * finds the strip that scrolled into view.
 */
static void gfx_scroll(Rect area, int dy) {
    area = rect_intersect(area, (Rect){ 0, 0, G.w, G.h });
    int ady = dy < 0 ? -dy : dy;
    if (!dy || ady >= area.h || area.w <= 0 || G.resized) return;
    int sy = dy < 0 ? area.y + ady : area.y, ty = dy < 0 ? area.y : area.y + ady, h = area.h - ady;
    size_t start = out_begin(OUT_COPY);
    out_u16((unsigned)area.x); out_u16((unsigned)sy); out_u16((unsigned)area.w); out_u16((unsigned)h);
    out_u16((unsigned)area.x); out_u16((unsigned)ty);
    out_end(start);
    if (dy < 0) for (int y = 0; y < h; y++)
        memmove(G.prev + (size_t)(ty + y) * G.w + area.x, G.prev + (size_t)(sy + y) * G.w + area.x, (size_t)area.w * sizeof(Color));
    else for (int y = h - 1; y >= 0; y--)
        memmove(G.prev + (size_t)(ty + y) * G.w + area.x, G.prev + (size_t)(sy + y) * G.w + area.x, (size_t)area.w * sizeof(Color));
}

static void gfx_present(void) {
    if (G.resized) {
        size_t start = out_begin(OUT_RESIZE);
        out_u16((unsigned)G.w); out_u16((unsigned)G.h);
        out_end(start);
        /* The host's canvas starts empty: make every pixel differ once. */
        for (size_t i = 0; i < (size_t)G.w * G.h; i++) G.prev[i] = ~G.fb[i];
        G.resized = 0;
    }
    int cols = (G.w + TILE_W - 1) / TILE_W;
    /* Open rectangles from the previous tile row, merged downwards when the span repeats. */
    Rect open[256]; int nopen = 0;
    for (int ty = 0; ty < G.h; ty += TILE_H) {
        int th = ty + TILE_H > G.h ? G.h - ty : TILE_H;
        Rect now[256]; int nnow = 0;
        for (int cx = 0; cx < cols;) {
            int dirty = 0;
            int x0 = cx * TILE_W, tw = x0 + TILE_W > G.w ? G.w - x0 : TILE_W;
            for (int y = ty; y < ty + th && !dirty; y++)
                dirty = memcmp(G.fb + (size_t)y * G.w + x0, G.prev + (size_t)y * G.w + x0, (size_t)tw * sizeof(Color)) != 0;
            if (!dirty) { cx++; continue; }
            int start = cx;
            for (cx++; cx < cols; cx++) {
                int x1 = cx * TILE_W, w1 = x1 + TILE_W > G.w ? G.w - x1 : TILE_W, d = 0;
                for (int y = ty; y < ty + th && !d; y++)
                    d = memcmp(G.fb + (size_t)y * G.w + x1, G.prev + (size_t)y * G.w + x1, (size_t)w1 * sizeof(Color)) != 0;
                if (!d) break;
            }
            int xs = start * TILE_W, xe = cx * TILE_W > G.w ? G.w : cx * TILE_W;
            if (nnow < 256) now[nnow++] = (Rect){ xs, ty, xe - xs, th };
        }
        /* Extend matching open rectangles, flush the ones that ended. */
        for (int i = 0; i < nopen; i++) {
            int extended = 0;
            for (int k = 0; k < nnow; k++) {
                if (now[k].w && now[k].x == open[i].x && now[k].w == open[i].w) {
                    open[i].h += now[k].h; now[k] = open[i]; extended = 1; break;
                }
            }
            if (!extended) encode_rect(open[i]);
        }
        nopen = nnow;
        memcpy(open, now, sizeof(Rect) * (size_t)nnow);
    }
    for (int i = 0; i < nopen; i++) encode_rect(open[i]);
    if (G.cursor != G.cursor_sent) {
        size_t start = out_begin(OUT_CURSOR);
        out_u8((unsigned)G.cursor);
        out_end(start);
        G.cursor_sent = G.cursor;
    }
    if (G.want_paste) { out_end(out_begin(OUT_PASTE)); G.want_paste = 0; }
    if (G.side_w != G.side_sent_w || G.side_top != G.side_sent_top) {
        size_t start = out_begin(OUT_SIDEBAR);
        out_u16((unsigned)G.side_w); out_u16((unsigned)G.side_top);
        out_end(start);
        G.side_sent_w = G.side_w; G.side_sent_top = G.side_top;
    }
    if (G.files && (!G.files_sent || strcmp(G.files, G.files_sent))) {
        size_t start = out_begin(OUT_FILES), n = strlen(G.files);
        out_reserve(n); memcpy(G.out + G.out_len, G.files, n); G.out_len += n;
        out_end(start);
        free(G.files_sent); G.files_sent = G.files; G.files = NULL;
    }
    out_end(out_begin(OUT_FRAME));
    out_flush();
}

/* Where the file tree is, for the strip the host draws over it. */
static void gfx_sidebar(int w, int top) { G.side_w = w; G.side_top = top; }

/* The open files and the zoom, as OUT_FILES tells them, for the host's bar: `text` is taken over. */
static void gfx_files(char *text) { free(G.files); G.files = text; }

/* Paste from a menu: only the host can read its clipboard, and it answers with IN_PASTE. */
static void gfx_request_paste(void) { G.want_paste = 1; }
