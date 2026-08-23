/* device_config.h — MCU lite 客户端的编译期资源预算。
 *
 * 所有选项都可以通过编译器 -D 覆盖。它们是设备镜像的一部分，不在运行时扩大，
 * 因而接收缓冲、详情页和执行步骤始终保持静态、有界。
 */
#ifndef DEVICE_CONFIG_H
#define DEVICE_CONFIG_H

/* 服务端单帧预算；lite profile 允许 512..65536，C3 默认 2048。 */
#ifndef MCU_MAX_FRAME_BYTES
#define MCU_MAX_FRAME_BYTES 2048
#endif

/* timeline.get 每页节点数；服务端仍会按 maxFrameBytes 进一步收缩。 */
#ifndef MCU_TIMELINE_PAGE_SIZE
#define MCU_TIMELINE_PAGE_SIZE 3
#endif

/* node.get 的字符 limit。256 个 UTF-8 字符在默认帧预算中留有信封余量。 */
#ifndef MCU_DETAIL_PAGE_CHARS
#define MCU_DETAIL_PAGE_CHARS 256
#endif

/* 当前详情页驻留缓冲。只保存当前页，不累积全文。 */
#ifndef MCU_DETAIL_PAGE_BUFFER_BYTES
#define MCU_DETAIL_PAGE_BUFFER_BYTES (MCU_MAX_FRAME_BYTES - 384)
#endif

/* 固件编译期 ExecutionStep 数组容量；默认/推荐值与 lite profile 缺省值一致。 */
#ifndef MCU_EXECUTION_STEP_CAPACITY
#define MCU_EXECUTION_STEP_CAPACITY 16
#endif

/* 顶部问题卡只驻留截断后的 UTF-8 前缀。 */
#ifndef MCU_QUESTION_BYTES
#define MCU_QUESTION_BYTES 160
#endif

/* MCU 默认不订阅逐字正文。 */
#define MCU_TURN_DELTA 0

#if MCU_MAX_FRAME_BYTES < 512 || MCU_MAX_FRAME_BYTES > 65536
#error "MCU_MAX_FRAME_BYTES must be in [512, 65536]"
#endif
#if MCU_TIMELINE_PAGE_SIZE < 1 || MCU_TIMELINE_PAGE_SIZE > 100
#error "MCU_TIMELINE_PAGE_SIZE must be in [1, 100]"
#endif
#if MCU_DETAIL_PAGE_CHARS < 1 || MCU_DETAIL_PAGE_CHARS > 32000
#error "MCU_DETAIL_PAGE_CHARS must be in [1, 32000]"
#endif
#if MCU_DETAIL_PAGE_BUFFER_BYTES < 128 || MCU_DETAIL_PAGE_BUFFER_BYTES > MCU_MAX_FRAME_BYTES
#error "MCU_DETAIL_PAGE_BUFFER_BYTES must be in [128, MCU_MAX_FRAME_BYTES]"
#endif
#if MCU_EXECUTION_STEP_CAPACITY < 1 || MCU_EXECUTION_STEP_CAPACITY > 500
#error "MCU_EXECUTION_STEP_CAPACITY must be in [1, 500]"
#endif
#if MCU_QUESTION_BYTES < 32
#error "MCU_QUESTION_BYTES must be at least 32"
#endif

#endif /* DEVICE_CONFIG_H */
