import type { HeaderPort } from './headerTemplate'
import type { VisibleHeaderItem } from './headerLayout'

export type PinSpec = { side: HeaderPort; at: number }
export type CircuitPlacement = {
  width: number
  height: number
  boundary: Record<string, PinSpec>
  ends: Record<string, { side: HeaderPort; offset?: number }>
}
/** Fixed semantic template: positions depend on measured child sizes, never relation-array order. */
export function placeCircuit(
  board: string,
  items: VisibleHeaderItem[],
  interfaces: ReadonlyMap<string, Record<string, PinSpec>>,
): CircuitPlacement {
  const nodes = new Map(items.map((n) => [n.id, n]))
  const n = (id: string) => nodes.get(id)!
  const put = (id: string, x: number, y: number) => Object.assign(n(id), { x, y })
  const right = (id: string) => n(id).x + n(id).width
  const bottom = (id: string) => n(id).y + n(id).height
  const cx = (id: string) => n(id).x + n(id).width / 2
  const cy = (id: string) => n(id).y + n(id).height / 2
  const ends: CircuitPlacement['ends'] = {},
    boundary: CircuitPlacement['boundary'] = {}
  const end = (id: string, node: string, side: HeaderPort, offset = 0) => {
    ends[`${id}@${node}`] = { side, offset }
  }
  const link = (a: string, b: string, sa: HeaderPort, sb: HeaderPort, oa = 0, ob = 0) => {
    end(`${a}:${b}`, a, sa, oa)
    end(`${a}:${b}`, b, sb, ob)
  }
  const pin = (id: string, side: HeaderPort, at: number) => {
    boundary[id] = { side, at }
  }
  const childPin = (id: string, edge: string): PinSpec => {
    // Measured package interfaces are assigned before placement.
    const p = interfaces.get(id)![edge]!
    return {
      side: p.side,
      at: p.at + (p.side === 'left' || p.side === 'right' ? n(id).y : n(id).x),
    }
  }
  const pass = (id: string, edge: string) => {
    boundary[edge] = childPin(id, edge)
  }
  let width = 0,
    height = 0
  if (board === 'compact') {
    put('compact-request', 64, 72)
    put('compact-summary', 272, 72)
    put('compact-applied', 448, 72)
    link('compact-request', 'compact-summary', 'right', 'left')
    link('compact-summary', 'compact-applied', 'right', 'left')
    end('request:compact-request', 'compact-request', 'bottom')
    end('compact-applied:request', 'compact-applied', 'bottom')
    pin('request:compact-request', 'bottom', cx('compact-request'))
    pin('compact-applied:request', 'bottom', cx('compact-applied'))
  } else if (board === 'model-layer') {
    put('compact', 64, 64)
    const row = bottom('compact') + 48
    put('request', 96, row)
    put('model', 336, row)
    put('response', 576, row)
    put('context', 96, row + 104)
    put('channels', 816, row)
    link('request', 'model', 'right', 'left', -12, -12)
    link('model', 'response', 'right', 'left', 12, 12)
    link('response', 'channels', 'right', 'left')
    link('context', 'request', 'top', 'bottom')
    end('model:error', 'model', 'right', -12)
    end('channels:checkpoint', 'channels', 'top')
    end('channels:tool-list', 'channels', 'bottom')
    end('request:compact-request', 'request', 'top', -48)
    end('compact-applied:request', 'request', 'top', 48)
    for (const [edge, offset] of [
      ['retry:request', -24],
      ['input:request', 0],
      ['command:request', 24],
    ] as const) {
      end(edge, 'request', 'left', offset)
      pin(edge, 'left', cy('request') + offset)
    }
    pin('model:error', 'top', right('compact') + 32)
    pin('channels:checkpoint', 'top', cx('channels'))
    pin('channels:tool-list', 'bottom', cx('channels'))
    height = Math.max(bottom('context'), bottom('model') + 204) + 64
  } else if (board === 'retry-layer') {
    put('model-layer', Math.max(64, 520 - interfaces.get('model-layer')!['model:error']!.at), 200)
    const errorX = childPin('model-layer', 'model:error').at
    put('error', errorX - 84, 72)
    put('retry', 160, 72)
    link('error', 'retry', 'left', 'right')
    end('model:error', 'error', 'bottom')
    end('retry:request', 'retry', 'left')
    end('error:result', 'error', 'top')
    pin('error:result', 'top', cx('error'))
    for (const edge of [
      'command:request',
      'input:request',
      'channels:checkpoint',
      'channels:tool-list',
    ])
      pass('model-layer', edge)
  } else if (board === 'collaboration') {
    for (const [i, id] of ['dispatch', 'child-run', 'child-return', 'parent-receive'].entries())
      put(id, 64, 72 + i * 88)
    link('dispatch', 'child-run', 'bottom', 'top')
    link('child-run', 'child-return', 'bottom', 'top')
    link('child-return', 'parent-receive', 'bottom', 'top')
    end('execution:dispatch', 'dispatch', 'right')
    end('parent-receive:input', 'parent-receive', 'left', -12)
    end('parent-receive:wake', 'parent-receive', 'left', 12)
    pin('execution:dispatch', 'right', cy('dispatch'))
    pin('parent-receive:input', 'left', cy('parent-receive') - 12)
    pin('parent-receive:wake', 'left', cy('parent-receive') + 12)
  } else if (board === 'tools') {
    // Keep the approval triangle inside the failure fan. Resume wraps outside that fan;
    // collaboration leaves on the opposite side so its parent returns remain on the outer face.
    put('retry-layer', 64, 64)
    const x = 64 + n('collaboration').width + 64,
      y = bottom('retry-layer') + 64
    for (const [i, id] of ['tool-list', 'validation', 'authorization', 'approval-needed'].entries())
      put(id, x, y + i * 88)
    put('approval', x + 232, n('approval-needed').y + 72)
    put('preflight', x, bottom('approval') + 28)
    put('execution', x, bottom('preflight') + 48)
    put('collaboration', 64, Math.max(y + 244, n('execution').y - n('collaboration').height + 48))
    put('tool-result', x, Math.max(bottom('execution') + 48, bottom('collaboration') + 32))
    put('rejection', x + 472, n('validation').y)
    // One semantic result component, with a separate pin level for every failure source.
    n('rejection').height = bottom('execution') - n('rejection').y
    put('resume', n('rejection').x, y)
    for (const [a, b] of [
      ['tool-list', 'validation'],
      ['validation', 'authorization'],
      ['authorization', 'approval-needed'],
      ['approval-needed', 'preflight'],
      ['preflight', 'execution'],
      ['execution', 'tool-result'],
    ])
      link(a!, b!, 'bottom', 'top')
    link('approval-needed', 'approval', 'right', 'top')
    link('approval', 'preflight', 'bottom', 'right')
    for (const id of ['validation', 'authorization', 'approval', 'preflight', 'execution']) {
      end(`${id}:rejection`, id, 'right', id === 'approval' ? 0 : 12)
      end(
        `${id}:rejection`,
        'rejection',
        'left',
        cy(id) + (id === 'approval' ? 0 : 12) - cy('rejection'),
      )
    }
    link('rejection', 'tool-result', 'bottom', 'right')
    link('resume', 'tool-list', 'left', 'right')
    link('resume', 'tool-result', 'right', 'bottom')
    end('channels:tool-list', 'tool-list', 'top')
    end('execution:dispatch', 'execution', 'left')
    end('tool-result:checkpoint', 'tool-result', 'left')
    pin('tool-result:checkpoint', 'bottom', cx('tool-result') - 40)
    for (const edge of ['command:request', 'input:request', 'error:result', 'channels:checkpoint'])
      pass('retry-layer', edge)
    for (const edge of ['parent-receive:input', 'parent-receive:wake']) pass('collaboration', edge)
  } else if (board === 'record') {
    put('tools', 304, 96)
    put('input', 48, childPin('tools', 'input:request').at - 32)
    put('command', 48, bottom('input') + 40)
    put('checkpoint', childPin('tools', 'tool-result:checkpoint').at - 84, bottom('tools') + 48)
    link('input', 'command', 'bottom', 'top')
    end('input:request', 'input', 'right')
    end('command:request', 'command', 'right')
    end('parent-receive:input', 'input', 'left', 12)
    end('entry:input', 'input', 'left', -12)
    end('channels:checkpoint', 'checkpoint', 'right')
    end('tool-result:checkpoint', 'checkpoint', 'top')
    end('checkpoint:decision', 'checkpoint', 'bottom')
    pin('entry:input', 'left', cy('input') - 12)
    pin('checkpoint:decision', 'bottom', cx('checkpoint'))
    pass('tools', 'error:result')
    pin(
      'parent-receive:wake',
      'left',
      Math.max(childPin('tools', 'parent-receive:wake').at, bottom('command') + 96),
    )
  } else if (board === 'loop') {
    // The next-iteration return encloses the result path; wait/wake stay outside the cycle.
    put('record', 288, 144)
    put('entry', 64, childPin('record', 'entry:input').at - 32)
    put('decision', childPin('record', 'checkpoint:decision').at - 84, bottom('record') + 64)
    put('wait', 96, n('decision').y)
    put('result', right('record') - 168, 64)
    link('entry', 'input', 'right', 'left')
    end('checkpoint:decision', 'decision', 'top')
    link('decision', 'result', 'right', 'right')
    link('decision', 'entry', 'bottom', 'top')
    link('decision', 'wait', 'left', 'right')
    end('error:result', 'result', 'left')
    end('wait:wake', 'wait', 'left')
    end('wake:entry', 'entry', 'left', 12)
    end('queue:entry', 'entry', 'left', -12)
    pin('queue:entry', 'left', cy('entry') - 12)
    pin('wake:entry', 'left', cy('entry') + 12)
    pin('wait:wake', 'left', cy('wait'))
    pass('record', 'parent-receive:wake')
    width = right('record') + 128
    height = bottom('decision') + 96
  } else if (board === 'intake') {
    put('submission', 64, 72)
    put('queue', 64, 160)
    put('wake', 64, 264)
    link('submission', 'queue', 'bottom', 'top')
    end('queue:entry', 'queue', 'right')
    end('wake:entry', 'wake', 'right', -16)
    end('parent-receive:wake', 'wake', 'right', 0)
    end('wait:wake', 'wake', 'right', 16)
    pin('queue:entry', 'right', cy('queue'))
    pin('wake:entry', 'right', cy('wake') - 16)
    pin('parent-receive:wake', 'right', cy('wake'))
    pin('wait:wake', 'right', cy('wake') + 16)
  } else {
    put('intake', 48, 112)
    put('loop', right('intake') + 112, 112)
  }
  width ||= Math.max(...items.map((n) => n.x + n.width)) + 48
  height ||= Math.max(...items.map((n) => n.y + n.height)) + 48
  if (board === 'tools') {
    items.push({
      id: 'calls',
      kind: 'calls',
      x: 64,
      y: n('tool-list').y,
      width: Math.min(720, n('tool-list').x - 128),
      height: 196,
    })
  }
  return { width, height, boundary, ends }
}
