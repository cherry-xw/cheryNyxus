import { describe, it, expect, vi } from 'vitest'
import {
  sense,
  executeSenseWithControl,
  normalizeObservation,
  createSenseCheckpoint,
  getSenseRecoveryState,
  type SenseFunction,
  type SenseResult,
} from '@/core/sense/senseCreator'
import { SupervisionLevel } from '@/core/config'
import { z } from 'zod'

describe('sense factory function', () => {
  describe('structured observation', () => {
    it('defaults observations to untrusted and preserves source metadata', () => {
      const observation = normalizeObservation({
        kind: 'observation',
        content: 'external data',
        sources: [{ url: 'https://example.com/a', citationId: 'c1', provider: 'test' }],
      })
      expect(observation.untrusted).toBe(true)
      expect(observation.sources?.[0]?.citationId).toBe('c1')
    })

    it('rejects unsafe or oversized observations', () => {
      expect(() =>
        normalizeObservation({
          kind: 'observation',
          content: 'x',
          sources: [{ url: 'file:///tmp/a' }],
        }),
      ).toThrow('Invalid observation source URL')
      expect(() =>
        normalizeObservation({ kind: 'observation', content: 'x'.repeat(100_001) }),
      ).toThrow('Observation content exceeds server limit')
    })
  })
  describe('checkpoint and lifecycle contract', () => {
    it('requires recovery when a checkpoint is missing or incomplete', () => {
      expect(getSenseRecoveryState()).toMatchObject({ required: true, reason: 'process_restart' })
      const checkpoint = createSenseCheckpoint({
        operationId: 'op-1',
        senseCallId: 'call-1',
        status: 'incomplete',
      })
      expect(getSenseRecoveryState(checkpoint)).toMatchObject({
        required: true,
        reason: 'incomplete_checkpoint',
      })
      expect(getSenseRecoveryState({ ...checkpoint, status: 'completed', completedAt: 1 })).toMatchObject({
        required: false,
      })
    })

    it('emits non-blocking start and finish lifecycle events', async () => {
      const events: string[] = []
      const result = await executeSenseWithControl(
        async () => ({ content: 'ok' }),
        {},
        new Map(),
        {
          chatId: 'chat',
          operationId: 'op-1',
          onLifecycleEvent: (event: { phase: string }) => {
            events.push(event.phase)
            throw new Error('observer must not affect execution')
          },
        },
      )
      expect(result.status).toBe('ok')
      expect(events).toEqual(['start', 'finish'])
    })
  })

  describe('definition generation', () => {
    it('creates correct function definition', () => {
      const testSense = sense(
        'test_sense',
        'A test sense',
        z.object({ path: z.string() }),
        async () => ({ content: 'ok', hash: '' }),
      )

      expect(testSense.definition.type).toBe('function')
      expect(testSense.definition.function.name).toBe('test_sense')
      expect(testSense.definition.function.description).toBe('A test sense')
      expect(testSense.definition.function.parameters.type).toBe('object')
      expect(testSense.definition.function.parameters.required).toEqual(['path'])
      // 源码 definition.function 不生成 strict 字段（仅 type/name/description/parameters）
    })

    it('creates correct schema for multiple parameters', () => {
      const testSense = sense(
        'multi_params',
        'Sense with multiple params',
        z.object({
          path: z.string(),
          count: z.number(),
          enabled: z.boolean().optional(),
        }),
        async () => ({ content: 'ok', hash: '' }),
      )

      expect(testSense.definition.function.parameters.required).toEqual(['path', 'count'])
    })

    it('handles optional parameters', () => {
      const testSense = sense(
        'optional_params',
        'Sense with optional params',
        z.object({
          required: z.string(),
          optional: z.string().optional(),
        }),
        async () => ({ content: 'ok', hash: '' }),
      )

      expect(testSense.definition.function.parameters.required).toEqual(['required'])
    })
  })

  describe('executor creation', () => {
    it('creates executor with correct schema', () => {
      const schema = z.object({ input: z.string() })
      const testSense = sense('schema_test', 'Test schema', schema, async () => ({
        content: 'ok',
        hash: '',
      }))

      expect(testSense.executor.schema).toBe(schema)
    })

    it('executor execute function returns SenseResult', async () => {
      const testSense = sense(
        'executor_test',
        'Test executor',
        z.object({ msg: z.string() }),
        async ({ msg }) => ({ content: `received: ${msg}`, hash: 'test-hash' }),
      )

      const result = await testSense.executor.execute({ msg: 'hello' }, new Map())
      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('hash')
      expect(result.content).toBe('received: hello')
      expect(result.hash).toBe('test-hash')
    })

    it('executor receives senseSharedData', async () => {
      const sharedData = new Map<string, Map<string, unknown>>()
      sharedData.set('test', new Map([['key', 'value']]))

      const testSense = sense(
        'shared_data_test',
        'Test shared data',
        z.object({}),
        async (_, data) => ({
          content: JSON.stringify(Array.from(data.entries())),
          hash: '',
        }),
      )

      const result = await testSense.executor.execute({}, sharedData)
      expect(result.content).toContain('test')
    })
  })

  describe('supervision level', () => {
    it('defaults to undefined when not specified', () => {
      const testSense = sense('default_level', 'Default supervision', z.object({}), async () => ({
        content: 'ok',
        hash: '',
      }))

      expect(testSense.supervisionLevel).toBeUndefined()
    })

    it('accepts custom supervision level', () => {
      const autoSense = sense(
        'auto_sense',
        'Auto execution',
        z.object({}),
        async () => ({ content: 'ok', hash: '' }),
        SupervisionLevel.auto,
      )

      const manualSense = sense(
        'manual_sense',
        'Manual execution',
        z.object({}),
        async () => ({ content: 'ok', hash: '' }),
        SupervisionLevel.manual,
      )

      expect(autoSense.supervisionLevel).toBe(SupervisionLevel.auto)
      expect(manualSense.supervisionLevel).toBe(SupervisionLevel.manual)
    })
  })

  describe('execution control', () => {
    function deferred() {
      let resolve!: (result: SenseResult) => void
      let reject!: (error: Error) => void
      const promise = new Promise<SenseResult>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    it.each([999, NaN, Infinity])(
      'enforces a process-wide maxConcurrent of 8 with budget %s',
      async (maxConcurrent) => {
        const pending = Array.from({ length: 8 }, deferred)
        const calls = pending.map((item, index) =>
          executeSenseWithControl(
            async (_input, _shared, ctx) => {
              expect(ctx?.budget?.maxConcurrent).toBe(8)
              return item.promise
            },
            { maxConcurrent: 9999 },
            new Map(),
            { chatId: `chat-${index}`, budget: { maxConcurrent } },
          ),
        )
        const rejected = vi.fn(async () => ({ content: 'must not run' }))
        try {
          expect(
            (await executeSenseWithControl(rejected, {}, new Map(), { chatId: 'other' })).status,
          ).toBe('budget_exceeded')
          expect(rejected).not.toHaveBeenCalled()
          pending[0]!.resolve({ content: 'done' })
          await calls[0]
          expect(
            (await executeSenseWithControl(rejected, {}, new Map(), { chatId: 'other' })).status,
          ).toBe('ok')
        } finally {
          pending.forEach((item) => item.resolve({ content: 'done' }))
          await Promise.all(calls)
        }
      },
    )

    it('retains cancelled handler slots until settlement and discards late results and yieldTurn', async () => {
      const pending = deferred()
      const controller = new AbortController()
      const yieldTurn = vi.fn()
      const messages: string[] = []
      const call = executeSenseWithControl(
        async (_input, _shared, ctx) => {
          const result = await pending.promise
          ctx?.yieldTurn?.()
          return result
        },
        {},
        new Map(),
        { chatId: 'chat', signal: controller.signal, yieldTurn },
      ).then((result) => {
        if (result.status === 'ok') messages.push(result.content)
        return result
      })
      controller.abort()
      controller.abort()
      expect((await call).status).toBe('cancelled')
      const probe = () =>
        executeSenseWithControl(async () => ({ content: 'ok' }), {}, new Map(), {
          chatId: 'other',
          budget: { maxConcurrent: 1.9 },
        })
      expect((await probe()).status).toBe('budget_exceeded')
      pending.resolve({ content: 'late Agent message', hash: 'late' })
      await pending.promise
      await Promise.resolve()
      await Promise.resolve()
      expect((await probe()).status).toBe('ok')
      expect(messages).toEqual([])
      expect(yieldTurn).not.toHaveBeenCalled()
    })

    it('cleans slots after synchronous throws and rejected promises', async () => {
      for (const execute of [
        () => {
          throw new Error('sync')
        },
        async () => {
          throw new Error('async')
        },
      ]) {
        expect(
          (
            await executeSenseWithControl(execute, {}, new Map(), {
              chatId: 'chat',
              budget: { maxConcurrent: 1 },
            })
          ).status,
        ).toBe('provider_error')
      }
      expect(
        (
          await executeSenseWithControl(async () => ({ content: 'ok' }), {}, new Map(), {
            chatId: 'chat',
            budget: { maxConcurrent: 1 },
          })
        ).status,
      ).toBe('ok')
    })

    it('does not start pre-cancelled or expired calls and handles synchronous cancellation', async () => {
      const controller = new AbortController()
      controller.abort()
      const handler = vi.fn(async () => ({ content: 'unexpected' }))
      expect(
        (
          await executeSenseWithControl(handler, {}, new Map(), {
            chatId: 'chat',
            signal: controller.signal,
          })
        ).status,
      ).toBe('cancelled')
      expect(
        (
          await executeSenseWithControl(handler, {}, new Map(), {
            chatId: 'chat',
            deadlineAt: Date.now() - 1,
          })
        ).status,
      ).toBe('timeout')
      expect(handler).not.toHaveBeenCalled()
      const synchronous = new AbortController()
      expect(
        (
          await executeSenseWithControl(
            async () => {
              synchronous.abort()
              return { content: 'ignored' }
            },
            {},
            new Map(),
            { chatId: 'chat', signal: synchronous.signal },
          )
        ).status,
      ).toBe('cancelled')
    })

    it('returns timeout without waiting for a provider', async () => {
      const pending = deferred()
      let signal: AbortSignal | undefined
      const result = await executeSenseWithControl(
        async (_input, _shared, ctx) => {
          signal = ctx?.signal
          return pending.promise
        },
        {},
        new Map(),
        { chatId: 'chat', budget: { timeoutMs: 5 } },
      )
      expect(result.status).toBe('timeout')
      expect(result.errorCode).toBe('timeout')
      expect(signal?.aborted).toBe(true)
      expect(
        (
          await executeSenseWithControl(async () => ({ content: 'ok' }), {}, new Map(), {
            chatId: 'chat',
            budget: { maxConcurrent: 1 },
          })
        ).status,
      ).toBe('budget_exceeded')
      pending.reject(new Error('late rejection'))
      await pending.promise.catch(() => undefined)
      await Promise.resolve()
      await Promise.resolve()
      expect(
        (
          await executeSenseWithControl(async () => ({ content: 'ok' }), {}, new Map(), {
            chatId: 'chat',
            budget: { maxConcurrent: 1 },
          })
        ).status,
      ).toBe('ok')
    })

    it('propagates cancellation and bounds output', async () => {
      const controller = new AbortController()
      const resultPromise = executeSenseWithControl(
        async (_input, _shared, ctx) => {
          await new Promise<void>((resolve) =>
            ctx?.signal?.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { content: 'ignored' }
        },
        {},
        new Map(),
        { chatId: 'chat', signal: controller.signal, budget: { maxOutputChars: 3 } },
      )
      controller.abort()
      const result = await resultPromise
      expect(result.status).toBe('cancelled')
      expect(
        (
          await executeSenseWithControl(async () => ({ content: 'ok' }), {}, new Map(), {
            chatId: 'chat',
            budget: { maxConcurrent: 1 },
          })
        ).status,
      ).toBe('ok')
    })

    it('enforces maxBytes and reports truncation', async () => {
      const result = await executeSenseWithControl(
        async () => ({ content: '你'.repeat(100) }),
        {},
        new Map(),
        { chatId: 'chat', budget: { maxBytes: 20 } },
      )
      expect(result.status).toBe('budget_exceeded')
      expect(result.errorCode).toBe('budget_exceeded')
      expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(20)
    })

    it('normalizes malformed provider output', async () => {
      const result = await executeSenseWithControl(
        async () => ({ content: 42 }) as unknown as SenseResult,
        {},
        new Map(),
        { chatId: 'chat' },
      )
      expect(result.status).toBe('invalid_result')
    })
  })
})
