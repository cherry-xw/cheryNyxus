import { z } from 'zod'
export const LearningTaskSchema = z.object({
  operationId: z.string(), scopeId: z.string(), target: z.string(), preset: z.string(), revision: z.number(),
  state: z.enum(['pending','running','completed','failed','cancelled']), phase: z.enum(['local','public']),
  version: z.number(), nextAt: z.number(), retries: z.number(), reason: z.string().optional(),
  inputs: z.array(z.string()).optional(), index: z.number().default(0), results: z.array(z.string()).default([]),
  localReceipt: z.string().optional(), publicReceipt: z.string().optional(),
  candidate: z.boolean().optional(),
  localSnapshot: z.object({revision:z.number(),entries:z.array(z.unknown())}).optional(),
  conflicts: z.number().int().nonnegative().default(0),
}).strict()
export const LearningStateSchema = z.object({ since: z.number().default(0), calls: z.array(z.number()).default([]),
  positions: z.record(z.string(), z.object({ ordinal: z.number(), run: z.number() }).strict()).default({}),
  tasks: z.array(LearningTaskSchema).default([]), reason: z.string().optional(), nextPollAt: z.number().default(0),
}).strict()
export type LearningState = z.infer<typeof LearningStateSchema>
export type LearningTask = z.infer<typeof LearningTaskSchema>
