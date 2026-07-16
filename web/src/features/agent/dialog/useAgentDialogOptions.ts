import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { UploadFile } from "element-plus";
import { useAgentsStore } from "@/stores";
import {
  agentApi,
  fetchServerConfig,
  type BrainInfo,
  type ConfigDto,
  type RuntimeSelection,
  type SenseToolInfo,
  type SenseGroupOption,
} from "@/services/agentApi";
import type { PetInstance } from "@/features/pets/types";
import {
  COMPACT_COMMAND,
  composeCommandPrompt,
  estimateCommandTokens,
  toSkillCommands,
  type MessageCommand,
} from "@/features/agent/commands";

/**
 * AgentDialog 状态 + 逻辑 composable。
 * 15 个 ref + loadOptions + handleSend + media 函数 + watch(chatId)。
 */

// /api/config 未暴露 senseGroups 或拉取失败时的兜底
const SENSE_GROUPS_FALLBACK = [{ name: "default", default: true }] as const;

export type MediaKind = "image" | "video" | "audio";

export interface MediaAttachment {
  assetId: string;
  filename: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  previewUrl: string;
}

export function useAgentDialogOptions() {
  const agents = useAgentsStore();

  const chatId = computed<string | null>(() => agents.activeDialogChatId);
  const pet = computed<PetInstance | undefined>(() =>
    chatId.value ? agents.pets.find((p) => p.chatId === chatId.value) : undefined,
  );
  const presetName = computed<string | undefined>(() => pet.value?.preset);

  const brains = ref<BrainInfo[]>([]);
  const senseGroups = ref<readonly SenseGroupOption[]>(SENSE_GROUPS_FALLBACK);
  const config = ref<ConfigDto | null>(null);
  const senseTools = ref<SenseToolInfo[]>([]);
  const roleSelections = ref<Record<string, RuntimeSelection>>({});
  const primaryRole = ref("主角色");
  const text = ref("");
  const skillCommands = ref<MessageCommand[]>([]);
  const editorRef = ref<HTMLElement | null>(null);
  const uploading = ref(false);
  const mediaHint = ref("");
  const uploadQueue = ref<import("element-plus").UploadUserFile[]>([]);
  const mediaAttachments = ref<MediaAttachment[]>([]);
  const sending = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);

  async function loadOptions(): Promise<void> {
    if (loaded.value || !chatId.value) return;
    loading.value = true;
    error.value = null;
    try {
      const data = await agentApi.listBrains();
      brains.value = data.brains;
      let serverCfg: Awaited<ReturnType<typeof fetchServerConfig>> | null = null;
      try {
        serverCfg = await fetchServerConfig();
      } catch (e) {
        console.warn("[AgentDialog] /api/config 拉取失败，senseGroups 回退默认:", e);
      }
      if (serverCfg?.senseGroups && serverCfg.senseGroups.length > 0) {
        senseGroups.value = serverCfg.senseGroups;
      } else {
        senseGroups.value = SENSE_GROUPS_FALLBACK;
        console.warn("[AgentDialog] /api/config 未暴露 senseGroups，回退默认", serverCfg);
      }
      const loadedConfig = await agentApi.getConfig();
      config.value = loadedConfig;
      try {
        senseTools.value = await agentApi.listSenseTools();
      } catch (e) {
        senseTools.value = [];
        console.warn("[AgentDialog] sense.tools 拉取失败，能力详情仅显示原始名称:", e);
      }
      try {
        skillCommands.value = toSkillCommands(await agentApi.listSkills());
      } catch (e) {
        skillCommands.value = [];
        console.warn("[AgentDialog] skills.list 拉取失败，命令菜单仅保留内置命令:", e);
      }
      const preset = presetName.value ? loadedConfig.presets?.[presetName.value] : undefined;
      const roleNames = preset?.roles?.length ? preset.roles : Object.keys(loadedConfig.roles ?? {});
      primaryRole.value = preset?.leader ?? "主角色";
      const fallback: RuntimeSelection = {
        brain: brains.value.find((b) => b.default)?.name ?? brains.value[0]?.name ?? "",
        senseGroup: senseGroups.value.find((g) => g.default)?.name ?? senseGroups.value[0]?.name ?? "",
        mcpServers: [],
      };
      const selections: Record<string, RuntimeSelection> = {};
      for (const role of roleNames) {
        const configured = loadedConfig.roles?.[role];
        selections[role] = configured
          ? { brain: configured.brain, senseGroup: configured.senseGroup, mcpServers: configured.mcpServers ?? [] }
          : { ...fallback };
      }
      const cur = agents.getRuntime(chatId.value);
      selections[primaryRole.value] = cur ? { ...cur, mcpServers: [...(cur.mcpServers ?? [])] } : selections[primaryRole.value] ?? fallback;
      roleSelections.value = selections;
      for (const [k, v] of Object.entries(selections)) {
        if (!v.brain) console.warn(`[AgentDialog] 角色 ${k} brain 为空:`, v);
      }
      loaded.value = true;
    } catch (e) {
      error.value = (e as Error).message;
      console.error("[AgentDialog] loadOptions failed:", e);
    } finally {
      loading.value = false;
    }
  }

  watch(
    chatId,
    (v) => {
      if (v) {
        resetEditor();
        resetMedia();
        error.value = null;
        loaded.value = false;
        void loadOptions();
      }
    },
    { immediate: true },
  );

  const primarySelection = computed(() => roleSelections.value[primaryRole.value]);

  const allCommands = computed<MessageCommand[]>(() => [COMPACT_COMMAND, ...skillCommands.value]);
  /** 输入末尾的 /token；null 表示当前不应展示指令菜单。 */
  const slashQuery = computed<string | null>(() => {
    const match = text.value.match(/(?:^|\s)\/([^\s]*)$/);
    return match ? match[1]!.toLowerCase() : null;
  });
  const commandOptions = computed(() => {
    if (slashQuery.value === null) return [];
    const selected = new Set(
      [...text.value.matchAll(/\[\[command:(\/[^\]\s]+)\]\]/g)].map((match) => match[1]!),
    );
    return allCommands.value.filter((command) =>
      !selected.has(command.name) && command.name.slice(1).toLowerCase().includes(slashQuery.value!),
    );
  });
  const showCommandMenu = computed(() => slashQuery.value !== null && commandOptions.value.length > 0);

  /** 当前高亮的命令项下标；菜单呼出/过滤变化时默认指向第一项。 */
  const activeCommandIndex = ref(0);
  const commandMenuRef = ref<HTMLElement | null>(null);
  let instructionPopover: HTMLElement | null = null;

  // 过滤结果变化（含菜单首次呼出）→ 回到第一项，符合命令面板直觉。
  watch(commandOptions, () => {
    activeCommandIndex.value = 0;
  });
  // 键盘切换后将高亮项滚动进视口；flush:post 等 DOM 更新后再查节点。
  watch(activeCommandIndex, () => {
    commandMenuRef.value
      ?.querySelector<HTMLElement>(".command-option.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, { flush: "post" });

  function selectCommand(command: MessageCommand): void {
    const editor = editorRef.value;
    if (!editor) return;
    removeTrailingSlashQuery(editor);
    insertInstructionToken(editor, command);
    syncEditorText();
  }

  function close(): void {
    resetMedia();
    agents.activeDialogChatId = null;
  }

  // 全局 ESC 关闭弹窗（仅在 dialog 打开且为栈顶 overlay 时生效；topOverlay 守卫避免与 HistoryDrawer 等同开时双重关闭）。
  function onGlobalKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && chatId.value && agents.topOverlay === "agentDialog") {
      e.preventDefault();
      close();
    }
  }
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("scroll", hideInstructionPopover, true);
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onGlobalKeydown);
    window.removeEventListener("scroll", hideInstructionPopover, true);
    hideInstructionPopover();
  });

  async function handleSend(): Promise<void> {
    if (!chatId.value || !text.value.trim() || sending.value) return;
    sending.value = true;
    error.value = null;
    try {
      if (!primarySelection.value) throw new Error("主角色编制未加载完成");
      const safeRoles: Record<string, RuntimeSelection> = {};
      for (const [k, v] of Object.entries(roleSelections.value)) {
        if (!v.brain) {
          console.warn(`[AgentDialog] 发送时跳过空 brain 角色: ${k}`, v);
          continue;
        }
        safeRoles[k] = v;
      }
      if (!primarySelection.value.brain) {
        throw new Error(`主角色 brain 为空（${primaryRole.value}），roleSelections=${JSON.stringify(roleSelections.value)}`);
      }
      await agents.setSessionRuntime(chatId.value, { primary: primarySelection.value, roles: safeRoles });
      const attachments = mediaAttachments.value.map((m) => ({
        assetId: m.assetId,
        kind: m.kind,
        mimeType: m.mimeType,
      }));
      await agents.sendMessage(
        chatId.value,
        composeCommandPrompt(text.value),
        attachments,
      );
      resetEditor();
      close();
    } catch (e) {
      error.value = (e as Error).message;
      console.error("[AgentDialog] sendMessage failed:", e);
    } finally {
      sending.value = false;
    }
  }

  function onEditorKeydown(e: KeyboardEvent): void {
    if (showCommandMenu.value) {
      const opts = commandOptions.value;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (opts.length) activeCommandIndex.value = (activeCommandIndex.value + 1) % opts.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (opts.length) activeCommandIndex.value = (activeCommandIndex.value - 1 + opts.length) % opts.length;
        return;
      }
      // 纯 Enter 选中高亮项；isComposing 放行中文输入法的候选词确认，shift/alt 仍走换行。
      if (e.key === "Enter" && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const cmd = opts[activeCommandIndex.value];
        if (cmd) selectCommand(cmd);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function onEditorInput(): void {
    syncEditorText();
  }

  function onEditorPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const pasted = e.clipboardData?.getData("text/plain");
    if (pasted) {
      document.execCommand("insertText", false, pasted);
      syncEditorText();
    }
  }

  function resetEditor(): void {
    text.value = "";
    if (editorRef.value) editorRef.value.replaceChildren();
  }

  function syncEditorText(): void {
    text.value = editorRef.value ? serializeEditor(editorRef.value) : "";
  }

  function serializeEditor(editor: HTMLElement): string {
    const serializeNode = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const element = node as HTMLElement;
      if (element.dataset.commandName) return `[[command:${element.dataset.commandName}]]`;
      if (element.tagName === "BR") return "\n";
      const content = [...element.childNodes].map(serializeNode).join("");
      return element.tagName === "DIV" || element.tagName === "P" ? `${content}\n` : content;
    };
    return [...editor.childNodes].map(serializeNode).join("").replace(/\n{3,}/g, "\n\n");
  }

  function removeTrailingSlashQuery(editor: HTMLElement): void {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return (node.parentElement?.closest("[data-command-name]") ?? null)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let lastTextNode: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) lastTextNode = node as Text;
    if (!lastTextNode) return;
    const slashStart = lastTextNode.data.search(/(^|\s)\/[^\s]*$/);
    if (slashStart < 0) return;
    const match = lastTextNode.data.slice(slashStart);
    const start = slashStart + match.lastIndexOf("/");
    const range = document.createRange();
    range.setStart(lastTextNode, start);
    range.setEnd(lastTextNode, lastTextNode.data.length);
    range.deleteContents();
  }

  function insertInstructionToken(editor: HTMLElement, command: MessageCommand): void {
    const token = document.createElement("span");
    token.className = "instruction-token";
    token.dataset.commandName = command.name;
    token.contentEditable = "false";
    token.setAttribute("role", "note");
    token.setAttribute("aria-label", `指令 ${command.name}：${command.description}`);

    const name = document.createElement("span");
    name.className = "instruction-token-name";
    name.textContent = command.label;
    token.append(name);
    token.addEventListener("pointerenter", () => showInstructionPopover(token, command));
    token.addEventListener("pointerleave", hideInstructionPopover);

    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange();
    if (!editor.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.collapse(true);
    range.insertNode(token);
    const spacer = document.createTextNode(" ");
    range.setStartAfter(token);
    range.insertNode(spacer);
    range.setStartAfter(spacer);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.focus();
  }

  function showInstructionPopover(anchor: HTMLElement, command: MessageCommand): void {
    hideInstructionPopover();
    const popover = document.createElement("div");
    popover.className = "instruction-token-floating-popover";
    popover.setAttribute("role", "tooltip");

    const title = document.createElement("div");
    title.className = "instruction-token-floating-title";
    title.textContent = command.label;
    const description = document.createElement("div");
    description.className = "instruction-token-floating-description";
    description.textContent = command.description;
    const meta = document.createElement("div");
    meta.className = "instruction-token-floating-meta";
    const metaLabel = document.createElement("span");
    metaLabel.textContent = "Token 消耗量";
    const metaValue = document.createElement("strong");
    metaValue.textContent = `≈ ${estimateCommandTokens(command)} tokens`;
    meta.append(metaLabel, metaValue);
    popover.append(title, description, meta);
    popover.style.visibility = "hidden";
    document.body.append(popover);

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const horizontalPadding = 8;
    const top = anchorRect.top - popoverRect.height - 8 >= horizontalPadding
      ? anchorRect.top - popoverRect.height - 8
      : Math.min(window.innerHeight - popoverRect.height - horizontalPadding, anchorRect.bottom + 8);
    const left = Math.min(
      Math.max(horizontalPadding, anchorRect.left),
      window.innerWidth - popoverRect.width - horizontalPadding,
    );
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.visibility = "visible";
    instructionPopover = popover;
  }

  function hideInstructionPopover(): void {
    instructionPopover?.remove();
    instructionPopover = null;
  }

  // === media functions ===
  function mediaKind(file: File): MediaKind | undefined {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    return undefined;
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function resetMedia(): void {
    for (const attachment of mediaAttachments.value) URL.revokeObjectURL(attachment.previewUrl);
    mediaAttachments.value = [];
    uploadQueue.value = [];
    mediaHint.value = "";
  }

  function removeMedia(attachment: MediaAttachment): void {
    URL.revokeObjectURL(attachment.previewUrl);
    mediaAttachments.value = mediaAttachments.value.filter((item) => item !== attachment);
    mediaHint.value = mediaAttachments.value.length ? `已附加 ${mediaAttachments.value.length} 个媒体文件` : "";
  }

  async function onMediaSelected(uploadFile: UploadFile): Promise<void> {
    const file = uploadFile.raw;
    uploadQueue.value = [];
    if (!file || !primarySelection.value) return;
    const category = mediaKind(file);
    if (!category) return;
    // 检查媒体服务 OR brain 原生能力，任一满足即可上传
    const hasMediaService = config.value?.media
      ? Object.values(config.value.media).some(svc => svc.type === category && svc.enabled && svc.url)
      : false;
    const hasBrainCapability = brainConfig(primarySelection.value.brain)?.capabilities?.input?.[category] === true;
    if (!hasMediaService && !hasBrainCapability) {
      const typeLabel = category === "image" ? "图片" : category === "video" ? "视频" : "音频";
      mediaHint.value = `未配置${typeLabel}服务，且小组无支持模型`;
      return;
    }
    uploading.value = true;
    mediaHint.value = "上传媒体中…";
    try {
      const asset = await agentApi.uploadMedia(file);
      mediaAttachments.value.push({
        assetId: asset.id,
        filename: asset.filename,
        kind: asset.kind,
        mimeType: asset.mimeType,
        size: asset.size,
        previewUrl: URL.createObjectURL(file),
      });
      mediaHint.value = `${file.name} 已附加`;
    } catch (err) {
      mediaHint.value = (err as Error).message;
    } finally {
      uploading.value = false;
    }
  }

  // === role config helpers ===
  function brainInfo(name: string): BrainInfo | undefined {
    return brains.value.find((brain) => brain.name === name);
  }

  function brainConfig(name: string) {
    return config.value?.llm.brain[name];
  }

  function supportsTools(brainName: string): boolean {
    return brainConfig(brainName)?.capabilities?.toolCall !== false;
  }

  function selectBrain(selection: RuntimeSelection, brain: string): void {
    selection.brain = brain;
    if (!supportsTools(brain)) {
      selection.senseGroup = "";
      selection.mcpServers = [];
    } else if (!selection.senseGroup) {
      selection.senseGroup = senseGroups.value.find((g) => g.default)?.name ?? senseGroups.value[0]?.name ?? "";
    }
  }

  function senseEntries(group: string): string[] {
    return config.value?.sense_groups?.[group] ?? [];
  }

  function senseName(entry: string): string {
    return entry.split(":")[0] ?? entry;
  }

  function senseTool(entry: string): SenseToolInfo | undefined {
    return senseTools.value.find((tool) => tool.name === senseName(entry));
  }

  const orderedRoleSelections = computed(() => {
    const entries = Object.entries(roleSelections.value);
    return entries.sort(([left], [right]) => {
      if (left === primaryRole.value) return -1;
      if (right === primaryRole.value) return 1;
      return 0;
    });
  });

  /** 各媒体类型对应的已启用服务名（AgentDialog 媒体菜单显示用）。 */
  const mediaServicesByType = computed<Record<MediaKind, string | null>>(() => {
    const result: Record<string, string | null> = { image: null, video: null, audio: null };
    if (!config.value?.media) return result as Record<MediaKind, string | null>;
    for (const [name, svc] of Object.entries(config.value.media)) {
      if (svc.enabled && svc.url && !result[svc.type]) {
        result[svc.type] = name;
      }
    }
    return result as Record<MediaKind, string | null>;
  });

  return {
    chatId, pet, presetName,
    brains, senseGroups, config, senseTools,
    roleSelections, primaryRole, text, editorRef, commandOptions, showCommandMenu,
    activeCommandIndex, commandMenuRef,
    uploading, mediaHint, uploadQueue, mediaAttachments,
    sending, loading, error, loaded,
    primarySelection, orderedRoleSelections, mediaServicesByType,
    close, handleSend, onEditorKeydown, onEditorInput, onEditorPaste, selectCommand,
    mediaKind, formatFileSize, resetMedia, removeMedia, onMediaSelected,
    brainInfo, brainConfig, supportsTools, selectBrain,
    senseEntries, senseName, senseTool,
  };
}
