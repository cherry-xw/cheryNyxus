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
