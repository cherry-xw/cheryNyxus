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
        text.value = "";
        resetMedia();
        error.value = null;
        loaded.value = false;
        void loadOptions();
      }
    },
    { immediate: true },
  );

  const primarySelection = computed(() => roleSelections.value[primaryRole.value]);

  function close(): void {
    resetMedia();
    agents.activeDialogChatId = null;
  }

  // 全局 ESC 关闭弹窗（仅在 dialog 打开时生效）。
  function onGlobalKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && chatId.value) {
      e.preventDefault();
      close();
    }
  }
  window.addEventListener("keydown", onGlobalKeydown);
  onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown));

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
      await agents.sendMessage(chatId.value, text.value.trim(), attachments);
      text.value = "";
      close();
    } catch (e) {
      error.value = (e as Error).message;
      console.error("[AgentDialog] sendMessage failed:", e);
    } finally {
      sending.value = false;
    }
  }

  function onTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
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
    roleSelections, primaryRole, text,
    uploading, mediaHint, uploadQueue, mediaAttachments,
    sending, loading, error, loaded,
    primarySelection, orderedRoleSelections, mediaServicesByType,
    close, handleSend, onTextareaKeydown,
    mediaKind, formatFileSize, resetMedia, removeMedia, onMediaSelected,
    brainInfo, brainConfig, supportsTools, selectBrain,
    senseEntries, senseName, senseTool,
  };
}
