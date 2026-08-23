/* json_lite.h — 零堆 JSON 字段扫描器（lite profile 专用）
 *
 * 设计依据：docs/mcu-lite-api.md §1.2（JSON 嵌套 ≤4 层）、§3.7（单帧 ≤maxFrameBytes）。
 * 原理：jsmn 风格 token 化（静态 token 数组，零 malloc）→ 编译期键名表 strcmp 分发
 * → 字符串值以 {ptr,len} 原位引用，仅驻留字段显式拷贝。
 */
#ifndef JSON_LITE_H
#define JSON_LITE_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define JL_MAX_TOKENS 160   /* T27 实测：limit=3 节点页 124 token；单事件 ≤43 token；预算 160 */

/* jsmn 兼容 token（紧凑版，8B/token 目标由 padding 决定） */
typedef struct {
    int parent;
    int start;    /* 相对 json 起点的字节偏移 */
    int end;
} jl_tok;

typedef struct {
    const char *json;   /* 帧缓冲（调用方所有，生命周期=帧处理期间） */
    jl_tok toks[JL_MAX_TOKENS];
    int count;
} jl_doc;

/* 值的零拷贝视图 */
typedef struct {
    const char *ptr;    /* 原位指针（字符串不含引号） */
    int len;
    bool found;
} jl_view;

/* 解析一帧 JSON。失败返回 false（超 token 上限/畸形）。 */
bool jl_parse(jl_doc *doc, const char *buf, size_t len);

/* 顶层与子对象按键取值。key 为编译期字面量。 */
jl_view jl_get(const jl_doc *doc, const char *key);                 /* 顶层 */
jl_view jl_get_in(const jl_doc *doc, const jl_view *obj, const char *key); /* obj 内 */

/* 数组遍历：返回第 idx 个元素的 view（对象或字符串），越界 found=false */
jl_view jl_array_at(const jl_doc *doc, const jl_view *arr, int idx);
int jl_array_len(const jl_doc *doc, const jl_view *arr);

/* 类型辅助 */
int jl_int(const jl_view *v, int def);       /* 数值字段（orderKey/revision/seq...） */
int64_t jl_i64(const jl_view *v, int64_t def);
bool jl_streq(const jl_view *v, const char *lit);  /* 无拷贝比较 */

/* 拷贝辅助（带界，用于需驻留的字段） */
void jl_copy(const jl_view *v, char *dst, size_t dstsz);

#endif /* JSON_LITE_H */
