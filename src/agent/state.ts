import { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

/**
 * 图的 StateAnnotation 定义了三个主要内容：
 * 1. 节点之间传递的数据结构（要读取/写入的"通道"及其类型）
 * 2. 每个字段的默认值
 * 3. 状态的 reducer。Reducer 是确定如何将更新应用到状态的函数。
 * 详见 [Reducers](https://langchain-ai.github.io/langgraphjs/concepts/low_level/#reducers)
 */

// 这是代理的主要状态，您可以在其中存储任何信息
export const StateAnnotation = Annotation.Root({
  /**
   * Messages 跟踪代理的主要执行状态。
   *
   * 通常累积以下模式：
   *
   * 1. HumanMessage - 用户输入
   * 2. AIMessage with .tool_calls - 代理选择要使用的工具来收集信息
   * 3. ToolMessage(s) - 已执行工具的响应（或错误）
   *
   *     (... 根据需要重复步骤 2 和 3 ...)
   * 4. AIMessage without .tool_calls - 代理以非结构化格式响应用户。
   *
   * 5. HumanMessage - 用户响应对话的下一轮。
   *
   *     (... 根据需要重复步骤 2-5 ...)
   *
   * 合并两个消息列表或具有角色和内容的类消息对象，
   * 通过 ID 更新现有消息。
   *
   * 类消息对象会被 `messagesStateReducer` 自动转换为 LangChain 消息类。
   * 如果消息没有给定的 id，LangGraph 将自动分配一个。
   *
   * 默认情况下，这确保状态是"仅追加"的，除非新消息与现有消息具有相同的 ID。
   *
   * 返回：
   *     一个新的消息列表，其中来自 `right` 的消息被合并到 `left` 中。
   *     如果 `right` 中的消息与 `left` 中的消息具有相同的 ID，
   *     则来自 `right` 的消息将替换来自 `left` 的消息。
   */
  messages: Annotation<BaseMessage[], BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /**
   * 可以根据需要向状态添加其他属性。
   * 常见的例子包括检索的文档、提取的实体、API 连接等。
   *
   * 对于应该被节点返回值覆盖的简单字段，
   * 您不需要定义 reducer 或默认值。
   */
  // additionalField: Annotation<string>,
});
