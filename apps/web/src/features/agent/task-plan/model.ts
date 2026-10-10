import type { TimelineNode } from '@/application/backend/public'

export type TaskPlan = NonNullable<TimelineNode['todoPlan']>
export type TaskPlanItem = TaskPlan['items'][number]

export function currentTaskPlanItem(plan: TaskPlan): TaskPlanItem | undefined {
  return (
    plan.items.find((item) => item.itemId === plan.currentItemId) ??
    plan.items.find((item) => item.status === 'in_progress')
  )
}

export function taskPlanProgress(plan: TaskPlan): string | undefined {
  const current = currentTaskPlanItem(plan)
  return current ? `${current.index + 1}/${plan.items.length}` : undefined
}

export function taskPlanItemLabel(item: TaskPlanItem, plan: TaskPlan): string {
  const runtime = item.activeForm?.trim()
  const detail = [runtime, item.content].filter(
    (value, index, values) => !!value && values.indexOf(value) === index,
  )
  const prefix = item.itemId === plan.currentItemId
    ? `${item.index + 1}/${plan.items.length}`
    : `${item.index + 1}`
  return `${prefix} ${detail.join(' · ')}`
}
