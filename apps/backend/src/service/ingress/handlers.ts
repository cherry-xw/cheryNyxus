import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { IngressRequestSchemas, type IngressStatus } from '@chery/protocol'
import type { RpcRouter, HandlerContext } from '../message/router.js'
import type { IngressHost } from './host.js'
import { IngressStore, ingressError, validateResourcePath } from './store.js'

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}
/** Control-only entrypoints; package sources are provisioned by the operator. */
export function registerIngressHandlers(
  router: RpcRouter,
  host: IngressHost,
  store: IngressStore,
  sourceRoot?: string,
): void {
  const receipts = new Map<string, { params: unknown; work: Promise<unknown> }>()
  let serial: Promise<unknown> = Promise.resolve()
  const control = (ctx: HandlerContext) => {
    if (ctx.credentialKind !== 'control' && ctx.credentialKind !== 'machine') throw ingressError('CAPABILITY_DENIED')
  }
  const once = async <T>(
    method: string,
    params: { requestId: string },
    action: () => Promise<T>,
  ): Promise<T> => {
    const key = `${method}:${params.requestId}`
    const previous = receipts.get(key)
    if (previous) {
      if (!isDeepStrictEqual(previous.params, params)) throw ingressError('REQUEST_ID_CONFLICT')
      return previous.work as Promise<T>
    }
    const work = serial.then(action)
    serial = work.catch(() => {})
    receipts.set(key, { params: structuredClone(params), work })
    void work.catch(() => receipts.delete(key))
    return work
  }
  const configView = (id: string) => {
    const status = host.status().find((item) => item.id === id)
    const snapshot = store.readConfig(id) ?? host.extensions[id]
    if (!status || !snapshot) throw ingressError('UNAVAILABLE')
    return {
      contractVersion: 2 as const,
      id,
      config: snapshot.config,
      baseRevision: snapshot.revision,
      apply: {
        state: status.apply,
        revision: snapshot.revision,
        ...(status.reason ? { reason: status.reason } : {}),
      },
    }
  }
  for (const method of Object.keys(IngressRequestSchemas) as Array<
    keyof typeof IngressRequestSchemas
  >) {
    router.register(method, async (ctx, raw) => {
      control(ctx)
      const params: unknown = IngressRequestSchemas[method].parse(raw)
      if (method === 'ingress.list')
        return {
          contractVersion: 2,
          hostApiVersion: 2,
          registryRevision: store.readRegistry().revision,
          plugins: host.status(),
        }
      if (method === 'ingress.ui.list')
        return {
          contractVersion: 2,
          registryRevision: store.readRegistry().revision,
          modules: host.uiList(),
        }
      if (method === 'ingress.management.call')
        return host.managementCall(params as Parameters<IngressHost['managementCall']>[0], ctx)
      if (method === 'ingress.ui.read') {
        const input = params as import('zod').infer<
          (typeof IngressRequestSchemas)['ingress.ui.read']
        >
        const { registration, descriptor } = host.uiRegistration(
          input.pluginId,
          input.moduleId,
          input.resourceVersion,
        )
        validateResourcePath(input.path)
        store.verify(registration)
        const relative = path.posix.join(
          'packages',
          registration.id,
          registration.version,
          path.posix.dirname(descriptor.entry),
          input.path,
        )
        const file = store.safe(relative)
        const contentType = mime[path.extname(file)]
        const stat = fs.statSync(file)
        if (!contentType || !stat.isFile() || stat.size > 1024 * 1024)
          throw ingressError('INVALID_PARAMS')
        return {
          contractVersion: 2,
          contentType,
          contentBase64: fs.readFileSync(file).toString('base64'),
          resourceVersion: descriptor.resourceVersion,
        }
      }
      if (method === 'ingress.config.get') return configView((params as { id: string }).id)
      return once(method, params as { requestId: string }, async () => {
        if (method === 'ingress.config.save') {
          const input = params as import('zod').infer<
            (typeof IngressRequestSchemas)['ingress.config.save']
          >
          await host.saveConfig(input.id, input.config, input.expectedBaseRevision)
          return { ...configView(input.id), saved: true }
        }
        const input = params as import('zod').infer<
          (typeof IngressRequestSchemas)['ingress.install']
        > & { id?: string }
        if (store.readRegistry().revision !== input.expectedRegistryRevision)
          throw ingressError('REVISION_CONFLICT')
        let id = input.id!
        let previous: IngressStatus | undefined
        if (method === 'ingress.install' || method === 'ingress.upgrade') {
          if (!sourceRoot) throw ingressError('INSTALL_SOURCE_UNAVAILABLE')
          validateResourcePath(input.packagePath)
          const root = fs.realpathSync(sourceRoot)
          const source = path.resolve(root, input.packagePath)
          let cursor = root
          for (const part of input.packagePath.split('/')) {
            cursor = path.join(cursor, part)
            if (fs.lstatSync(cursor).isSymbolicLink()) throw ingressError('INVALID_PARAMS')
          }
          if (!source.startsWith(`${root}${path.sep}`)) throw ingressError('INVALID_PARAMS')
          id = store.install(
            source,
            method === 'ingress.upgrade',
            input.expectedDigest,
            { grantedCapabilities: input.grantedCapabilities, channelGrants: input.channelGrants },
            input.expectedRegistryRevision,
          ).id
        } else {
          previous = host.status().find((item) => item.id === id)
          if (!previous) throw ingressError('UNAVAILABLE')
          if (method === 'ingress.uninstall')
            await host.uninstall(id, input.expectedRegistryRevision)
          else {
            store.setEnabled(id, method === 'ingress.enable', input.expectedRegistryRevision)
            if (method === 'ingress.disable') await host.disable(id)
          }
        }
        const status = host.status().find((item) => item.id === id) ?? {
          ...previous!,
          installed: false,
          enabled: false,
          activeVersion: null,
          savedVersion: null,
          state: 'stopped' as const,
          requiresRestart: false,
        }
        return {
          contractVersion: 2,
          requestId: input.requestId,
          registryRevision: store.readRegistry().revision,
          saved: true,
          status,
        }
      })
    })
  }
}
