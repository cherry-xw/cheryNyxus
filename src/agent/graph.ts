/**
 * LangGraph.js 入门模板
 * 将此代码改造成您自己的！
 */
import { StateGraph } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "./state.ts";
// import { ollama } from "../llm/ollama.ts";

const callModel = async (
  state: typeof AgentState.State,
  _config: RunnableConfig,
): Promise<typeof AgentState.Update> => {
  console.log("Current state:", state);
  // console.log("current config", config);
  // try {
  //   const res = await ollama.invoke(state.messages)
  //   console.log(res);
  //   return {
  //     messages: [
  //       {
  //         role: "assistant",
  //         content: res.content,
  //       },
  //     ],
  //   };
  // } catch (error) {
  //   console.error(error);
  // }

  return {
    messages: [{ role: "assistant", content: "Hello!" }],
    userQuery: "bbb",
    totalTokens: 1,
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
  state: typeof AgentState.State,
): "__end__" | "callModel" => {
  console.log("route", state);

  if (state.messages.length > 0) {
    return "__end__";
  }
  // 循环回去
  return "callModel";
};

// 最后，创建图本身。
const builder = new StateGraph(AgentState)
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
