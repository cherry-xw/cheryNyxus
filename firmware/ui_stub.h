/* ui_stub.h — 显示/输入桩（参考固件：串口日志模拟 OLED；替换为 SSD1306/LVGL 即可） */
#ifndef UI_STUB_H
#define UI_STUB_H

#include <stdint.h>
#include "model.h"

void ui_log(const char *fmt, ...);
uint64_t ui_now_ms(void);            /* esp_timer_get_time()/1000 封装 */
void ui_render_list(const lean_node *nodes, int n);        /* 气泡列表（最近页） */
void ui_render_status(void);                               /* 运行态行 + run.status */
void ui_render_tool(const char *sense_name);               /* 工具名级行（G3） */
void ui_render_approval(const approval_slot *a);           /* 审批页：arguments + 倒计时 */
void ui_flag_inbox_refresh(void);                          /* interaction.changed 防抖重拉 */

/* 输入桩：编码器/按键回调 → 审批决定（approval.decide）与消息发送（input.submit）。
 * 参考固件提供按键语义：SELECT=accept / BACK=reject / MENU=发送测试输入。 */
void ui_input_init(void (*on_decide)(const char *interaction_id, int revision, bool accept),
                   void (*on_send_text)(const char *text));

#endif
