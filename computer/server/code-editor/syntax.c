/*
 * syntax — one small tokenizer driven by a table per language. A line is
 * tokenized from the state its predecessor ended in (inside a block comment,
 * inside a multi-line string), so only the visible lines are ever coloured.
 */

enum { T_TEXT, T_COMMENT, T_STRING, T_NUMBER, T_KEYWORD, T_TYPE, T_FUNC, T_PUNCT, T_PREPROC, T_COUNT };
enum { ST_NORMAL, ST_BLOCK, ST_STR_A, ST_STR_B };   /* A: """ or `   B: ''' */

enum { LF_HASH_PREPROC = 1, LF_BACKTICK = 2, LF_TRIPLE = 4, LF_MARKUP = 8, LF_MARKDOWN = 16, LF_NO_SINGLE = 32 };

typedef struct {
    const char *name, *exts;            /* exts: space separated, with the dot */
    const char *line, *open, *close;    /* comments */
    const char *keywords, *types;
    int flags;
    char **kw; int nkw; char **ty; int nty;
} Lang;

static Lang LANGS[] = {
    { "Plain Text", "", NULL, NULL, NULL, "", "", 0 },
    { "C", ".c .h", "//", "/*", "*/",
      "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while",
      "char double float int long short signed unsigned void bool size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t NULL true false", LF_HASH_PREPROC },
    { "C++", ".cpp .cc .cxx .hpp .hh .hxx", "//", "/*", "*/",
      "alignas alignof auto break case catch class const constexpr const_cast continue decltype default delete do dynamic_cast else enum explicit export extern final for friend goto if inline mutable namespace new noexcept operator override private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this throw try typedef typeid typename union using virtual volatile while",
      "bool char double float int long short signed unsigned void wchar_t size_t nullptr true false std string vector map", LF_HASH_PREPROC },
    { "JavaScript", ".js .mjs .cjs .jsx", "//", "/*", "*/",
      "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield",
      "true false null undefined NaN Infinity Array Object String Number Boolean Promise Map Set Symbol JSON Math console window document", LF_BACKTICK },
    { "TypeScript", ".ts .tsx .mts .cts", "//", "/*", "*/",
      "abstract as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while yield",
      "true false null undefined any boolean never number object string symbol unknown bigint Array Promise Record Partial Map Set", LF_BACKTICK },
    { "JSON", ".json .jsonc .webmanifest", "//", "/*", "*/", "", "true false null", LF_NO_SINGLE },
    { "Python", ".py .pyw .pyi", "#", NULL, NULL,
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
      "True False None self cls int float str bool list dict set tuple bytes object print len range type", LF_TRIPLE },
    { "Rust", ".rs", "//", "/*", "*/",
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
      "bool char f32 f64 i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize str String Vec Option Result Some None Ok Err Box true false", LF_NO_SINGLE },
    { "Go", ".go", "//", "/*", "*/",
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
      "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false nil iota", LF_BACKTICK },
    { "Java", ".java .kt .kts .cs", "//", "/*", "*/",
      "abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var val fun namespace using override",
      "boolean byte char double float int long short void String Integer Object List Map true false null", 0 },
    { "Shell", ".sh .bash .zsh .ash .profile", "#", NULL, NULL,
      "if then else elif fi for while until do done case esac in function return break continue exit export local readonly set unset shift source alias echo cd test",
      "true false", 0 },
    { "CSS", ".css .scss .less", NULL, "/*", "*/", "important media import supports keyframes font-face from to and not only", "", 0 },
    { "HTML", ".html .htm .xml .svg .vue .svelte", NULL, "<!--", "-->", "", "", LF_MARKUP },
    { "Markdown", ".md .markdown .mdx", NULL, NULL, NULL, "", "", LF_MARKDOWN },
    { "TOML", ".toml .ini .cfg .conf .properties .env", "#", NULL, NULL, "", "true false", 0 },
    { "YAML", ".yml .yaml", "#", NULL, NULL, "", "true false null yes no on off", 0 },
    { "SQL", ".sql", "--", "/*", "*/",
      "select from where insert into values update set delete create table drop alter add column index view join inner left right outer on as and or not null is in like between order by group having limit offset union all distinct primary key foreign references default unique begin commit rollback SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD COLUMN INDEX VIEW JOIN INNER LEFT RIGHT OUTER ON AS AND OR NOT NULL IS IN LIKE BETWEEN ORDER BY GROUP HAVING LIMIT OFFSET UNION ALL DISTINCT PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE BEGIN COMMIT ROLLBACK",
      "int integer text real blob varchar char boolean date timestamp INT INTEGER TEXT REAL BLOB VARCHAR CHAR BOOLEAN DATE TIMESTAMP", 0 },
    { "Lua", ".lua", "--", "--[[", "]]",
      "and break do else elseif end for function goto if in local not or repeat return then until while", "true false nil self", 0 },
    { "Dockerfile", "Dockerfile Containerfile .dockerfile", "#", NULL, NULL,
      "FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS", "", 0 },
    { "Makefile", "Makefile makefile GNUmakefile .mk", "#", NULL, NULL, "ifeq ifneq ifdef ifndef else endif include define endef export", "", 0 },
};
#define LANG_COUNT ((int)(sizeof LANGS / sizeof LANGS[0]))

static int word_cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static char **split_words(const char *list, int *count) {
    char *copy = strdup(list ? list : "");
    int n = 0, cap = 16;
    char **words = malloc((size_t)cap * sizeof *words);
    for (char *w = strtok(copy, " "); w; w = strtok(NULL, " ")) {
        if (n == cap) { cap *= 2; words = realloc(words, (size_t)cap * sizeof *words); }
        words[n++] = w;
    }
    qsort(words, (size_t)n, sizeof *words, word_cmp);
    *count = n;
    return words;
}

static void syntax_init(void) {
    for (int i = 0; i < LANG_COUNT; i++) {
        LANGS[i].kw = split_words(LANGS[i].keywords, &LANGS[i].nkw);
        LANGS[i].ty = split_words(LANGS[i].types, &LANGS[i].nty);
    }
}

static int has_word(char **words, int n, const char *s, int len) {
    char buf[48];
    if (len <= 0 || len >= (int)sizeof buf || !n) return 0;
    memcpy(buf, s, (size_t)len); buf[len] = 0;
    char *key = buf;
    return bsearch(&key, words, (size_t)n, sizeof *words, word_cmp) != NULL;
}

static int syntax_detect(const char *name) {
    const char *dot = strrchr(name, '.');
    for (int i = 1; i < LANG_COUNT; i++) {
        const char *p = LANGS[i].exts;
        while (*p) {
            const char *e = strchr(p, ' ');
            int len = e ? (int)(e - p) : (int)strlen(p);
            if (p[0] == '.' ? (dot && (int)strlen(dot) == len && !strncasecmp(dot, p, (size_t)len))
                            : ((int)strlen(name) == len && !strncmp(name, p, (size_t)len))) return i;
            p += len; while (*p == ' ') p++;
        }
    }
    return 0;
}

static int starts(const char *s, int len, int i, const char *tok) {
    if (!tok) return 0;
    int n = (int)strlen(tok);
    return n && i + n <= len && !memcmp(s + i, tok, (size_t)n);
}

typedef void (*SpanFn)(void *ctx, int from, int to, int kind);

/* Tokenizes one line; returns the state the next line starts in. `emit` may be NULL. */
static int syntax_line(int lang, int state, const char *s, int len, SpanFn emit, void *ctx) {
    Lang *L = &LANGS[lang];
    #define EMIT(a, b, k) do { if (emit && (b) > (a)) emit(ctx, (a), (b), (k)); } while (0)
    if (lang == 0) { EMIT(0, len, T_TEXT); return ST_NORMAL; }

    if (L->flags & LF_MARKDOWN) {
        int fence = len >= 3 && (!memcmp(s, "```", 3) || !memcmp(s, "~~~", 3));
        if (state == ST_BLOCK) { EMIT(0, len, T_STRING); return fence ? ST_NORMAL : ST_BLOCK; }
        if (fence) { EMIT(0, len, T_STRING); return ST_BLOCK; }
        if (len && s[0] == '#') { EMIT(0, len, T_KEYWORD); return ST_NORMAL; }
        if (len && s[0] == '>') { EMIT(0, len, T_COMMENT); return ST_NORMAL; }
        int i = 0, from = 0;
        while (i < len) {
            if (s[i] == '`') {
                int j = i + 1; while (j < len && s[j] != '`') j++;
                EMIT(from, i, T_TEXT); EMIT(i, j < len ? j + 1 : len, T_STRING);
                i = from = j < len ? j + 1 : len;
            } else if (s[i] == '[' ) {
                int j = i + 1; while (j < len && s[j] != ')' ) j++;
                EMIT(from, i, T_TEXT); EMIT(i, j < len ? j + 1 : len, T_FUNC);
                i = from = j < len ? j + 1 : len;
            } else i++;
        }
        EMIT(from, len, T_TEXT);
        return ST_NORMAL;
    }

    int i = 0;
    while (i < len) {
        if (state == ST_BLOCK) {
            int j = i;
            while (j < len && !starts(s, len, j, L->close)) j++;
            if (j < len) { j += (int)strlen(L->close); state = ST_NORMAL; }
            EMIT(i, j, T_COMMENT); i = j; continue;
        }
        if (state == ST_STR_A || state == ST_STR_B) {
            const char *end = (L->flags & LF_TRIPLE) ? (state == ST_STR_A ? "\"\"\"" : "'''") : "`";
            int j = i;
            while (j < len && !starts(s, len, j, end)) j += (s[j] == '\\' && j + 1 < len) ? 2 : 1;
            if (j < len) { j += (int)strlen(end); state = ST_NORMAL; }
            if (j > len) j = len;
            EMIT(i, j, T_STRING); i = j; continue;
        }
        unsigned char c = (unsigned char)s[i];
        if (L->flags & LF_MARKUP) {
            if (starts(s, len, i, L->open)) { state = ST_BLOCK; continue; }
            if (c == '<') {
                int j = i + 1, from = i;
                while (j < len && s[j] != '>') {
                    if (s[j] == '"' || s[j] == '\'') {
                        char q = s[j]; int k = j + 1;
                        while (k < len && s[k] != q) k++;
                        EMIT(from, j, T_KEYWORD); EMIT(j, k < len ? k + 1 : len, T_STRING);
                        j = from = k < len ? k + 1 : len;
                    } else j++;
                }
                if (j < len) j++;
                EMIT(from, j, T_KEYWORD); i = j; continue;
            }
            int j = i; while (j < len && s[j] != '<') j++;
            EMIT(i, j, T_TEXT); i = j; continue;
        }
        if (starts(s, len, i, L->open)) { state = ST_BLOCK; continue; }
        if (starts(s, len, i, L->line)) { EMIT(i, len, T_COMMENT); break; }
        if ((L->flags & LF_HASH_PREPROC) && c == '#') {
            int k = 0; while (k < i && isspace((unsigned char)s[k])) k++;
            if (k == i) { EMIT(i, len, T_PREPROC); break; }
        }
        if ((L->flags & LF_TRIPLE) && (starts(s, len, i, "\"\"\"") || starts(s, len, i, "'''"))) {
            state = s[i] == '"' ? ST_STR_A : ST_STR_B;
            EMIT(i, i + 3, T_STRING); i += 3; continue;
        }
        if ((L->flags & LF_BACKTICK) && c == '`') { state = ST_STR_A; EMIT(i, i + 1, T_STRING); i++; continue; }
        if (c == '"' || (c == '\'' && !(L->flags & LF_NO_SINGLE))) {
            int j = i + 1;
            while (j < len && s[j] != (char)c) j += (s[j] == '\\' && j + 1 < len) ? 2 : 1;
            if (j < len) j++;
            if (j > len) j = len;
            EMIT(i, j, T_STRING); i = j; continue;
        }
        if (isdigit(c) || (c == '.' && i + 1 < len && isdigit((unsigned char)s[i + 1]))) {
            int j = i + 1;
            while (j < len && (isalnum((unsigned char)s[j]) || s[j] == '.' || s[j] == '_')) j++;
            EMIT(i, j, T_NUMBER); i = j; continue;
        }
        if (isalpha(c) || c == '_' || c == '$' || c >= 0x80) {
            int j = i + 1;
            while (j < len && (isalnum((unsigned char)s[j]) || s[j] == '_' || s[j] == '$' || (unsigned char)s[j] >= 0x80)) j++;
            int kind = T_TEXT;
            if (has_word(L->kw, L->nkw, s + i, j - i)) kind = T_KEYWORD;
            else if (has_word(L->ty, L->nty, s + i, j - i)) kind = T_TYPE;
            else {
                int k = j; while (k < len && s[k] == ' ') k++;
                if (k < len && s[k] == '(') kind = T_FUNC;
                else if (isupper(c) && j - i > 1) kind = T_TYPE;
            }
            EMIT(i, j, kind); i = j; continue;
        }
        if (isspace(c)) { int j = i + 1; while (j < len && isspace((unsigned char)s[j])) j++; EMIT(i, j, T_TEXT); i = j; continue; }
        EMIT(i, i + 1, T_PUNCT); i++;
    }
    #undef EMIT
    return state;
}
