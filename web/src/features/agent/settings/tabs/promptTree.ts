/**
 * 把 listPrompts 返回的相对路径列表（如 "prompts/prefebMain/leader.md"）建成 el-cascader options 树。
 * 供 RolesTab / PresetsTab 的 systemPrompt 级联选择器复用。
 *
 * 约定：
 * - 顶层 "prompts" 段剥掉（所有路径都以它开头），级联从组文件夹（如 prefebMain）开始 → 文件。
 * - 叶节点 value = 全路径（= systemPrompt 存储值，如 "prompts/prefebMain/leader.md"）。
 *   配合 el-cascader :props="{ emitPath:false }"，v-model 直接绑 systemPrompt 字符串。
 * - 中间目录节点 value = 目录相对路径；cascader 默认仅叶可选，目录不可选（= 不能把目录赋给角色）。
 */
export interface PromptCascaderNode {
  value: string;
  label: string;
  children?: PromptCascaderNode[];
}

export function buildPromptTree(paths: string[]): PromptCascaderNode[] {
  const root: PromptCascaderNode = { value: "", label: "", children: [] };

  for (const p of paths) {
    const segs = p.split("/");
    // 路径必以 prompts/ 开头；剥掉后从组文件夹层级建树（防御：非 prompts 开头则保留全部段）
    const stripped = segs[0] === "prompts" ? segs.slice(1) : segs;
    if (!stripped.length) continue;
    const prefix = segs[0] === "prompts" ? "prompts/" : "";

    let cur = root;
    let acc = "";
    stripped.forEach((seg, i) => {
      acc = i === 0 ? `${prefix}${seg}` : `${acc}/${seg}`;
      const isLeaf = i === stripped.length - 1;
      if (!cur.children) cur.children = [];
      let node = cur.children.find((c) => c.label === seg);
      if (!node) {
        node = { value: acc, label: seg };
        cur.children.push(node);
      }
      if (!isLeaf) {
        if (!node.children) node.children = [];
        cur = node;
      }
    });
  }

  return root.children ?? [];
}
