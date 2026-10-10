/* ui_stub.h — 显示/输入桩（参考固件：串口日志模拟 OLED；替换为 SSD1306/LVGL 即可） */
#ifndef UI_STUB_H
#define UI_STUB_H

#include <stdint.h>
#include "model.h"
#include "detail_pager.h"

void ui_log(const char *fmt, ...);
uint64_t ui_now_ms(void);            /* esp_timer_get_time()/1000 封装 */
void ui_render_list(const lean_node *nodes, int n);        /* 气泡列表（最近页） */
void ui_render_status(void);                               /* 运行态行 + run.status */
void ui_render_tool(const char *sense_name);               /* 工具名级行（G3） */
void ui_render_approval(const approval_slot *a);           /* 审批页：arguments + 倒计时 */
void ui_render_execution(uint64_t local_ms);                /* 问题+总计时+并行步骤 */
void ui_render_detail(const DetailPager *pager);            /* 当前详情页（不累计） */
void ui_tick(uint64_t local_ms);                            /* 本地 1Hz 计时刷新 */
void ui_flag_inbox_refresh(void);                          /* interaction.changed 防抖重拉 */
uint8_t ui_inbox_dirty(void);
void ui_inbox_clear_dirty(void);

typedef enum {
    UI_PAGE_OPEN,
    UI_PAGE_NEXT,
    UI_PAGE_PREVIOUS,
} ui_page_action_t;

typedef enum {
    UI_KEY_DETAIL_CONTENT,
    UI_KEY_DETAIL_THINKING,
    UI_KEY_DETAIL_TOOL,
    UI_KEY_PAGE_NEXT,
    UI_KEY_PAGE_PREVIOUS,
} ui_key_t;

/* 输入桩：保留审批/发送回调，并增加三类详情与前后页按键。 */
void ui_input_init(void (*on_decide)(const char *interaction_id, int revision, bool accept),
                   void (*on_send_text)(const char *text),
                   void (*on_detail)(detail_section_t section, ui_page_action_t action));

/* GPIO/编码器驱动只需把物理键映射到此入口；host 测试也可直接调用。 */
void ui_input_dispatch(ui_key_t key);

#endif
