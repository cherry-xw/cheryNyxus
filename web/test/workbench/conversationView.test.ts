import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

/**
 * 对话模式（第三视图）输入框契约：
 *  - 输入框：精简模式同款（单行自适应 textarea + 发送钮），草稿与树 composer 共用 text 事实源，
 *    Enter 发送 / Shift+Enter 换行，发送走工作台 sendFromComposer
 *  - 待处理提问与审批不在滚动内容顶部内嵌（对话列表内直接作答，见 QuestionRenderer 和审批气泡）；
 *    打开对话模式时刷新一次 interactions store，确保列表内提问卡片可交互
 */
describe('workbench conversation view input', () => {
  it('keeps the conversation input wired to the shared composer draft and send pipeline', async () => {
    const [view, dialog, controller] = await Promise.all([
      readComponentSource(resolve('web/src/features/agent/workbench/ConversationView.vue'), 'utf8'),
      readComponentSource(resolve('web/src/features/agent/workbench/WorkbenchDialog.vue'), 'utf8'),
      readComponentSource(
        resolve('web/src/features/agent/workbench/useWorkbenchDialogController.ts'),
        'utf8',
      ),
    ])

    // 输入框：lite 同款交互（Enter 发送 / Shift+Enter 换行 / 自适应增高）
    expect(view).toContain('class="conversation-input-box"')
    expect(view).toContain('rows="1"')
    expect(view).toContain('@keydown="onInputKeydown"')
    expect(view).toContain("event.key !== 'Enter' || event.shiftKey || event.isComposing")
    expect(view).toContain("emit('send')")
    expect(view).toContain("emit('draftInput', value)")
    expect(view).toContain('@click="emit(\'send\')"')
    expect(view).toContain('!text.trim()')

    // 工作台接线：同一 text/发送管线，分支目标随行提示；
    // 媒体：对话模式直接管理附件（小缩略图 + 原图tag + 预览弹窗），经工作台 controller 上传/移除/切换
    expect(dialog).toContain(':text="text"')
    expect(dialog).toContain('@send="sendFromComposer"')
    expect(dialog).toContain('@draft-input="onConversationDraftInput"')
    expect(dialog).toContain('@drop-branch="clearBranchTarget"')
    expect(dialog).toContain(':branch-active="!!branchTarget"')
    expect(dialog).toContain(':media-attachments="mediaAttachments"')
    expect(dialog).toContain(':media-services-by-type="mediaServicesByType"')
    expect(dialog).toContain('@media-selected="(f: any) => onMediaSelected(f)"')
    expect(dialog).toContain('@remove-media="removeMedia"')
    expect(dialog).toContain('@toggle-media-variant="toggleMediaVariant"')
    expect(view).toContain('<MediaThumbStrip')
    expect(view).toContain('conversation-input-hint')
    expect(controller).toContain(
      'function onConversationDraftInput(value: string): void {\n    text.value = value\n  }',
    )
    expect(controller).toContain(
      'function clearBranchTarget(): void {\n    branchTarget.value = undefined\n  }',
    )
  })

  it('keeps tree attention controls out of conversation mode and refreshes in-list interactions', async () => {
    const [view, dialog, approvalRenderer] = await Promise.all([
      readComponentSource(resolve('web/src/features/agent/workbench/ConversationView.vue'), 'utf8'),
      readComponentSource(resolve('web/src/features/agent/workbench/WorkbenchDialog.vue'), 'utf8'),
      readComponentSource(
        resolve('web/src/features/agent/renderers/core/ApprovalInteractionRenderer.vue'),
        'utf8',
      ),
    ])

    // 对话模式不再内嵌待处理区（无 #list-header / ConversationPendingSection）
    expect(view).not.toContain('list-header')
    expect(view).not.toContain('ConversationPendingSection')
    expect(view).not.toContain('pendingCount')

    // 打开对话模式时刷新一次 interactions store（列表内提问可交互的前提）
    expect(view).toContain('interactions.refresh()')

    // 树模式待处理提示已上移标题栏（WorkbenchAttentionIndicator，不可点击图标 + hover tip）：
    // 视图门控移入组件内部（useWorkbenchAttentionCount 基于单一事实源 viewModeByWindow），
    // 对话/精简模式计数归零不渲染，不会在对话 tab 显示树的提示。
    expect(dialog).toContain('<WorkbenchAttentionIndicator')
    expect(dialog).not.toContain('workbench-attention-warning')

    // 普通工具消息命中 pending approval 时由独立气泡处理。
    expect(approvalRenderer).toContain('interactions.decide(item, action)')
    expect(approvalRenderer).toContain('aria-label="待处理审批"')
  })
})
