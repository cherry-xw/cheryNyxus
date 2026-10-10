import { z } from 'zod'
import type { RpcRouter } from '../message/router.js'
import { webSearchRuntime } from '@/agent/sense/webSearch.js'
import {
  readSearchSettings,
  saveSearchSettings,
  searchSettingsSchema,
} from '@/agent/sense/web/searchService.js'
export function registerSearchSettingsHandlers(router: RpcRouter) {
  const control = (ctx: { credentialKind?: string }) =>
    !ctx.credentialKind || ctx.credentialKind === 'control'
  router.registerExtension({
    method: 'search.test',
    request: z.object({ query: z.string().min(1).max(600) }).strict(),
    response: z.unknown(),
    authorize: control,
    handler: async (_ctx, args) => webSearchRuntime.search({ query: args.query, limit: 3 }),
  })
  router.registerExtension({
    method: 'search.settings.get',
    request: z.object({}).strict(),
    response: z.unknown(),
    authorize: control,
    handler: async () => readSearchSettings(),
  })
  router.registerExtension({
    method: 'search.settings.save',
    request: z
      .object({ settings: searchSettingsSchema, expectedRevision: z.string().min(1) })
      .strict(),
    response: z.unknown(),
    authorize: control,
    handler: async (_ctx, args) => saveSearchSettings(args.settings, args.expectedRevision),
  })
}
