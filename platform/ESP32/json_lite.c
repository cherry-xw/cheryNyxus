/* json_lite.c — 零堆 JSON 扫描器实现（jsmn 派生，静态 token 数组）
 *
 * 只实现 lite 契约需要的子集：对象/数组/字符串/数值原位 token 化。
 * 嵌套深度由 JL_MAX_TOKENS 与 lite §1.2（≤4 层）天然约束。
 */
#include <string.h>
#include <stdlib.h>
#include "json_lite.h"

/* ---- 最小 jsmn：只做 token 边界标记，不建树指针 ---- */
typedef enum { JL_UNDEF = 0, JL_OBJECT, JL_ARRAY, JL_STRING, JL_PRIM } jl_type;

typedef struct {
    jl_type type;
    int start, end, size, parent;
} jl_raw;

static int jl_new_tok(jl_raw *t, int *count, jl_type type, int start, int end) {
    if (*count >= JL_MAX_TOKENS) return -1;   /* 超上限：调用方丢弃整帧（§3.7 防御） */
    t[*count].type = type;
    t[*count].start = start;
    t[*count].end = end;
    t[*count].size = 0;
    t[*count].parent = -1;
    return (*count)++;
}

/* 解析（jsmn_parse 的裁剪版：无偏移参数，字符串不含引号边界） */
static int jl_tokenize(jl_raw *t, int *count, const char *js, size_t len) {
    int pos = 0, r;
    /* 对象/数组元素的 parent 栈由 jsmn 算法维护 */
    while (pos < (int)len) {
        char c = js[pos];
        switch (c) {
        case '{': case '[': {
            int sz = 0;
            r = jl_new_tok(t, count, (c == '{' ? JL_OBJECT : JL_ARRAY), pos, -1);
            if (r < 0) return -1;
            if (*count > 1) { t[*count - 2].size++; /* 粗略计数由遍历阶段修正 */ }
            (void)sz;
            pos++;
            break;
        }
        case '}': case ']': {
            /* 回填 end */
            for (int i = *count - 1; i >= 0; i--) {
                if (t[i].end == -1 && (t[i].type == JL_OBJECT || t[i].type == JL_ARRAY)) {
                    t[i].end = pos + 1;
                    break;
                }
            }
            pos++;
            break;
        }
        case '"': {
            int start = ++pos;
            while (pos < (int)len && js[pos] != '"') {
                if (js[pos] == '\\') pos++;  /* 跳过转义 */
                pos++;
            }
            r = jl_new_tok(t, count, JL_STRING, start, pos);
            if (r < 0) return -1;
            if (*count > 1) t[*count - 2].size++;
            pos++;
            break;
        }
        case ' ': case '\t': case '\r': case '\n': case ',': case ':':
            pos++;
            break;
        default: {  /* primitive: number/true/false/null */
            int start = pos;
            while (pos < (int)len && js[pos] != ',' && js[pos] != '}' && js[pos] != ']' &&
                   js[pos] != ' ' && js[pos] != '\n' && js[pos] != '\r' && js[pos] != '\t')
                pos++;
            r = jl_new_tok(t, count, JL_PRIM, start, pos);
            if (r < 0) return -1;
            if (*count > 1) t[*count - 2].size++;
            break;
        }
        }
    }
    return 0;
}

/* ---- 公开 API ---- */
bool jl_parse(jl_doc *doc, const char *buf, size_t len) {
    static jl_raw raw[JL_MAX_TOKENS];   /* 单帧串行处理（WS 回调单线程），静态复用零分配 */
    int count = 0;
    if (jl_tokenize(raw, &count, buf, len) != 0) return false;
    if (count == 0 || raw[0].type != JL_OBJECT) return false;  /* lite 帧恒为顶层对象 */
    doc->json = buf;
    doc->count = count;
    for (int i = 0; i < count; i++) {
        doc->toks[i].parent = raw[i].parent;
        doc->toks[i].start = raw[i].start;
        doc->toks[i].end = raw[i].end;
    }
    return true;
}

/* token i 的父级（结束边界 enclosing 的最近容器）——用 start/end 包含关系判定 */
static int tok_parent(const jl_doc *d, int i) {
    for (int j = i - 1; j >= 0; j--) {
        if (d->toks[j].start < d->toks[i].start && d->toks[j].end > d->toks[i].end)
            return j;
    }
    return -1;
}

/* 在父容器 parent 内按 key 找值。key 为字符串 token 紧随其后的 token。 */
static jl_view lookup(const jl_doc *d, int parent, const char *key) {
    jl_view v = {0};
    size_t klen = strlen(key);
    for (int i = 0; i < d->count; i++) {
        if (tok_parent(d, i) != parent) continue;
        /* 当前 token 是 key 吗？形态：字符串 token，且下一个 token 是它的值 */
        if (d->toks[i].end - d->toks[i].start == (int)klen &&
            strncmp(d->json + d->toks[i].start, key, klen) == 0) {
            /* 值 = 序列中下一个 parent 相同或被包含的 token */
            for (int j = i + 1; j < d->count; j++) {
                int pj = tok_parent(d, j);
                if (pj == parent || pj == i) {
                    v.ptr = d->json + d->toks[j].start;
                    v.len = d->toks[j].end - d->toks[j].start;
                    v.found = true;
                    return v;
                }
                if (d->toks[j].start > d->toks[i].end && pj != parent) break;
            }
            return v;
        }
    }
    return v;
}

jl_view jl_get(const jl_doc *d, const char *key) { return lookup(d, 0, key); }

jl_view jl_get_in(const jl_doc *d, const jl_view *obj, const char *key) {
    if (!obj->found) return (jl_view){0};
    /* obj 起点定位 token 索引 */
    int off = (int)(obj->ptr - d->json);
    int ti = -1;
    for (int i = 0; i < d->count; i++)
        if (d->toks[i].start == off) { ti = i; break; }
    if (ti < 0) return (jl_view){0};
    return lookup(d, ti, key);
}

int jl_array_len(const jl_doc *d, const jl_view *arr) {
    if (!arr->found) return 0;
    int off = (int)(arr->ptr - d->json);
    int ti = -1;
    for (int i = 0; i < d->count; i++)
        if (d->toks[i].start == off) { ti = i; break; }
    if (ti < 0) return 0;
    int n = 0;
    for (int i = ti + 1; i < d->count; i++)
        if (tok_parent(d, i) == ti) n++;
    return n;
}

jl_view jl_array_at(const jl_doc *d, const jl_view *arr, int idx) {
    if (!arr->found) return (jl_view){0};
    int off = (int)(arr->ptr - d->json);
    int ti = -1;
    for (int i = 0; i < d->count; i++)
        if (d->toks[i].start == off) { ti = i; break; }
    if (ti < 0) return (jl_view){0};
    int n = 0;
    for (int i = ti + 1; i < d->count; i++)
        if (tok_parent(d, i) == ti) {
            if (n == idx) {
                jl_view v = { d->json + d->toks[i].start, d->toks[i].end - d->toks[i].start, true };
                return v;
            }
            n++;
        }
    return (jl_view){0};
}

int jl_int(const jl_view *v, int def) {
    if (!v || !v->found) return def;
    char tmp[24];
    jl_copy(v, tmp, sizeof tmp);
    return (int)strtol(tmp, NULL, 10);
}

int64_t jl_i64(const jl_view *v, int64_t def) {
    if (!v || !v->found) return def;
    char tmp[24];
    jl_copy(v, tmp, sizeof tmp);
    return (int64_t)strtoll(tmp, NULL, 10);
}

bool jl_streq(const jl_view *v, const char *lit) {
    if (!v || !v->found) return false;
    size_t n = strlen(lit);
    return v->len == (int)n && strncmp(v->ptr, lit, n) == 0;
}

void jl_copy(const jl_view *v, char *dst, size_t dstsz) {
    if (!v || !v->found || !dst || dstsz == 0) { if (dst && dstsz) dst[0] = 0; return; }
    size_t n = (size_t)v->len < dstsz - 1 ? (size_t)v->len : dstsz - 1;
    memcpy(dst, v->ptr, n);
    dst[n] = 0;
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool read_hex4(const char *p, const char *end, uint32_t *value) {
    if (!p || p + 4 > end || !value) return false;
    uint32_t out = 0;
    for (int i = 0; i < 4; i++) {
        int h = hex_value(p[i]);
        if (h < 0) return false;
        out = (out << 4) | (uint32_t)h;
    }
    *value = out;
    return true;
}

static size_t encode_utf8(uint32_t cp, char out[4]) {
    if (cp <= 0x7f) { out[0] = (char)cp; return 1; }
    if (cp <= 0x7ff) {
        out[0] = (char)(0xc0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3f));
        return 2;
    }
    if (cp <= 0xffff) {
        out[0] = (char)(0xe0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[2] = (char)(0x80 | (cp & 0x3f));
        return 3;
    }
    if (cp <= 0x10ffff) {
        out[0] = (char)(0xf0 | (cp >> 18));
        out[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
        out[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[3] = (char)(0x80 | (cp & 0x3f));
        return 4;
    }
    out[0] = (char)0xef; out[1] = (char)0xbf; out[2] = (char)0xbd;
    return 3;
}

static uint32_t decode_direct_utf8(const unsigned char *p, const unsigned char *end, size_t *used) {
    if (!p || p >= end) { *used = 0; return 0xfffd; }
    if (p[0] < 0x80) { *used = 1; return p[0]; }
    if ((p[0] & 0xe0) == 0xc0 && p + 1 < end && (p[1] & 0xc0) == 0x80) {
        *used = 2; return ((uint32_t)(p[0] & 0x1f) << 6) | (uint32_t)(p[1] & 0x3f);
    }
    if ((p[0] & 0xf0) == 0xe0 && p + 2 < end &&
        (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80) {
        *used = 3;
        return ((uint32_t)(p[0] & 0x0f) << 12) |
               ((uint32_t)(p[1] & 0x3f) << 6) | (uint32_t)(p[2] & 0x3f);
    }
    if ((p[0] & 0xf8) == 0xf0 && p + 3 < end &&
        (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80 && (p[3] & 0xc0) == 0x80) {
        *used = 4;
        return ((uint32_t)(p[0] & 0x07) << 18) |
               ((uint32_t)(p[1] & 0x3f) << 12) |
               ((uint32_t)(p[2] & 0x3f) << 6) | (uint32_t)(p[3] & 0x3f);
    }
    *used = 1;
    return 0xfffd;
}

static uint32_t next_unescaped_codepoint(const char **cursor, const char *end) {
    const char *p = *cursor;
    if (*p != '\\') {
        size_t used = 0;
        uint32_t cp = decode_direct_utf8((const unsigned char *)p, (const unsigned char *)end, &used);
        *cursor = p + (used ? used : 1);
        return cp;
    }
    p++;
    if (p >= end) { *cursor = p; return 0xfffd; }
    char esc = *p++;
    switch (esc) {
    case '"': *cursor = p; return '"';
    case '\\': *cursor = p; return '\\';
    case '/': *cursor = p; return '/';
    case 'b': *cursor = p; return '\b';
    case 'f': *cursor = p; return '\f';
    case 'n': *cursor = p; return '\n';
    case 'r': *cursor = p; return '\r';
    case 't': *cursor = p; return '\t';
    case 'u': {
        uint32_t first = 0;
        if (!read_hex4(p, end, &first)) { *cursor = p; return 0xfffd; }
        p += 4;
        if (first >= 0xd800 && first <= 0xdbff && p + 6 <= end && p[0] == '\\' && p[1] == 'u') {
            uint32_t second = 0;
            if (read_hex4(p + 2, end, &second) && second >= 0xdc00 && second <= 0xdfff) {
                p += 6;
                first = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
            }
        }
        *cursor = p;
        return first;
    }
    default: *cursor = p; return (unsigned char)esc;
    }
}

size_t jl_copy_unescaped(const jl_view *v, char *dst, size_t dstsz) {
    if (!dst || dstsz == 0) return 0;
    dst[0] = 0;
    if (!v || !v->found) return 0;
    const char *cursor = v->ptr;
    const char *end = v->ptr + v->len;
    size_t written = 0;
    while (cursor < end) {
        uint32_t cp = next_unescaped_codepoint(&cursor, end);
        char encoded[4];
        size_t n = encode_utf8(cp, encoded);
        if (written + n >= dstsz) break;
        memcpy(dst + written, encoded, n);
        written += n;
    }
    dst[written] = 0;
    return written;
}

uint32_t jl_utf16_units_unescaped(const jl_view *v) {
    if (!v || !v->found) return 0;
    const char *cursor = v->ptr;
    const char *end = v->ptr + v->len;
    uint32_t units = 0;
    while (cursor < end) {
        uint32_t cp = next_unescaped_codepoint(&cursor, end);
        units += cp > 0xffff ? 2U : 1U;
    }
    return units;
}
