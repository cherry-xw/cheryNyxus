/**
 * LangGraph.js 入门模板
 * 将此代码改造成您自己的！
 */
import { StateGraph } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";
import { StateAnnotation } from "./state.js";

/**
 * 定义一个节点，这些节点执行图的工作并应包含大部分逻辑。
 * 必须返回 StateAnnotation 中设置的属性的子集。
 * @param state 图的当前状态。
 * @param config 传入状态图的额外参数。
 * @returns 图状态的某些属性子集，用于更新接下来执行的边和节点的状态。
 */
const callModel = async (
  state: typeof StateAnnotation.State,
  _config: RunnableConfig,
): Promise<typeof StateAnnotation.Update> => {
  /**
   * 执行一些工作...（例如调用 LLM）
   * 例如，使用 LangChain 您可以这样做：
   *
   * ```bash
   * $ npm i @langchain/anthropic
   * ```
   *
   * ```ts
   * import { ChatAnthropic } from "@langchain/anthropic";
   * const model = new ChatAnthropic({
   *   model: "claude-3-5-sonnet-20240620",
   *   apiKey: process.env.ANTHROPIC_API_KEY,
   * });
   * const res = await model.invoke(state.messages);
   * ```
   *
   * 或者，直接使用 SDK：
   *
   * ```bash
   * $ npm i openai
   * ```
   *
   * ```ts
   * import OpenAI from "openai";
   * const openai = new OpenAI({
   *   apiKey: process.env.OPENAI_API_KEY,
   * });
   *
   * const chatCompletion = await openai.chat.completions.create({
   *   messages: [{
   *     role: state.messages[0]._getType(),
   *     content: state.messages[0].content,
   *   }],
   *   model: "gpt-4o-mini",
   * });
   * ```
   */
  console.log("Current state:", state);
  return {
    messages: [
      {
        role: "assistant",
        content: `Hi there! How are you?`,
      },
    ],
  };
};

/**
 * 路由函数：决定是继续研究还是结束构建器。
 * 此函数决定收集的信息是否令人满意，或者是否需要更多研究。
 *
 * @param state - 研究构建器的当前状态
 * @returns 返回 "callModel" 继续研究或 END 结束构建器
 */
export const route = (
  state: typeof StateAnnotation.State,
): "__end__" | "callModel" => {
  if (state.messages.length > 0) {
    return "__end__";
  }
  // 循环回去
  return "callModel";
};

// 最后，创建图本身。
const builder = new StateGraph(StateAnnotation)
  // 添加节点来执行工作。
  // 以这种方式将节点链接在一起
  // 会更新 StateGraph 实例的类型
  // 因此在添加边时具有静态类型检查。
  .addNode("callModel", callModel)
  // 常规边表示"在节点 A 完成后始终转换到节点 B"
  // "__start__" 和 "__end__" 节点是"虚拟"节点，始终存在
  // 代表构建器的开始和结束。
  .addEdge("__start__", "callModel")
  // 条件边根据条件可选地路由到不同的节点（或结束）
  .addConditionalEdges("callModel", route);

export const graph = builder.compile();

graph.name = "cheryClaw";
