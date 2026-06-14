/**
 * DOM 工具：极简 hyperscript + 事件 + 文本转义
 *
 * 所有用户/LLM 内容渲染走 textContent / createTextNode（自动 HTML 转义，防 XSS）。
 * 仅内部受控字符串（已知不含用户输入）才用 html prop。
 */

export function el(sel, root = document) {
  return root.querySelector(sel);
}

export function elAll(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * h(tag, props, ...children) — 创建元素
 *
 * props 特殊键：
 *   - class / className: string | string[]
 *   - on: { click: fn, ... }
 *   - dataset: { key: val }
 *   - attrs: { attr: val }（val===true → 无值属性；false → 跳过）
 *   - html: string（直接 innerHTML，仅受控内容）
 *   - 其余：若为 DOM 属性（value/checked/textContent 等）直接赋值，否则 setAttribute
 *
 * children: string | number | Node | array（自动扁平化，null/false 跳过）
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val == null || val === false) continue;
      if (key === "class" || key === "className") {
        const cls = Array.isArray(val) ? val.filter(Boolean).join(" ") : val;
        if (cls) node.className = cls;
      } else if (key === "on") {
        for (const [evt, cb] of Object.entries(val)) node.addEventListener(evt, cb);
      } else if (key === "dataset") {
        for (const [k, v] of Object.entries(val)) node.dataset[k] = v;
      } else if (key === "attrs") {
        for (const [k, v] of Object.entries(val)) {
          if (v === true) node.setAttribute(k, "");
          else if (v !== false) node.setAttribute(k, String(v));
        }
      } else if (key === "html") {
        node.innerHTML = val;
      } else if (key in node && typeof node[key] !== "function") {
        node[key] = val;
      } else {
        node.setAttribute(key, String(val));
      }
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child
    );
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 流式追加文本增量（自动转义） */
export function appendText(node, delta) {
  if (delta) node.appendChild(document.createTextNode(delta));
}

export function setText(node, text) {
  node.textContent = text ?? "";
}

export function on(target, evt, cb, opts) {
  target.addEventListener(evt, cb, opts);
  return () => target.removeEventListener(evt, cb, opts);
}
