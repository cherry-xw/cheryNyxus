import type { IconInput } from 'morphicons/vue'
import {
  Activity,
  Archive,
  Bot,
  BrainCircuit,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleStop,
  CircleX,
  Clock,
  Cpu,
  GitFork,
  Layers3,
  MessageSquareText,
  RefreshCcw,
  Route,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
} from 'lucide'
import type { HeaderSlotStatus } from './headerState'
import type { HeaderTemplateNode } from './headerTemplate'
import type { ResultNodeStatusTone, ResultNodeVisualKind } from './resultTreePresentation'

export type WorkflowCapability =
  | 'input'
  | 'context'
  | 'model'
  | 'tool'
  | 'control'
  | 'collaboration'
  | 'compact'
  | 'message'
  | 'branch'
  | 'return'
  | 'group'
  | 'system'

export interface WorkflowVisualIdentity {
  capability: WorkflowCapability
  icon: IconInput
  accent: string
  soft: string
  shape: 'rail' | 'circuit' | 'terminal' | 'tool' | 'gate' | 'branch' | 'archive'
}

const VISUALS: Record<WorkflowCapability, WorkflowVisualIdentity> = {
  input: { capability: 'input', icon: UserRound, accent: '#2eb8d0', soft: '#d8f4f8', shape: 'rail' },
  context: { capability: 'context', icon: BrainCircuit, accent: '#7b78e8', soft: '#e9e8ff', shape: 'circuit' },
  model: { capability: 'model', icon: Sparkles, accent: '#4f7ee8', soft: '#e1eaff', shape: 'terminal' },
  tool: { capability: 'tool', icon: Wrench, accent: '#c48a22', soft: '#fff0cf', shape: 'tool' },
  control: { capability: 'control', icon: Route, accent: '#c05a9d', soft: '#fae1f1', shape: 'gate' },
  collaboration: { capability: 'collaboration', icon: Bot, accent: '#b352c8', soft: '#f4def9', shape: 'branch' },
  compact: { capability: 'compact', icon: Archive, accent: '#138e9e', soft: '#d8f2f3', shape: 'archive' },
  message: { capability: 'message', icon: MessageSquareText, accent: '#2f91c5', soft: '#dceffa', shape: 'rail' },
  branch: { capability: 'branch', icon: GitFork, accent: '#a85ac6', soft: '#f1e0f7', shape: 'branch' },
  return: { capability: 'return', icon: RefreshCcw, accent: '#27966a', soft: '#daf2e7', shape: 'gate' },
  group: { capability: 'group', icon: Layers3, accent: '#397ea5', soft: '#dcecf5', shape: 'archive' },
  system: { capability: 'system', icon: Cpu, accent: '#7564c7', soft: '#e8e3fa', shape: 'circuit' },
}

export function headerVisual(template: HeaderTemplateNode): WorkflowVisualIdentity {
  const capability: WorkflowCapability =
    template.group === 'intake'
      ? 'input'
      : template.group === 'request'
        ? 'context'
        : template.group === 'model'
          ? 'model'
          : template.group === 'tools'
            ? 'tool'
            : template.group === 'control'
              ? 'control'
              : template.group === 'collaboration'
                ? 'collaboration'
                : 'compact'
  return VISUALS[capability]
}

export function resultVisual(kind: ResultNodeVisualKind): WorkflowVisualIdentity {
  return VISUALS[kind]
}

export function statusIcon(status: HeaderSlotStatus | ResultNodeStatusTone): IconInput {
  if (status === 'running') return Activity
  if (status === 'waiting') return Clock
  if (status === 'succeeded' || status === 'success') return CircleCheck
  if (status === 'failed' || status === 'rejected' || status === 'danger') return CircleX
  if (status === 'cancelled') return CircleStop
  if (status === 'interrupted') return CirclePause
  if (status === 'unrecorded') return ShieldCheck
  return CircleDashed
}

export function visualStyle(visual: WorkflowVisualIdentity): Record<string, string> {
  return {
    '--workflow-capability': visual.accent,
    '--workflow-capability-soft': visual.soft,
  }
}
