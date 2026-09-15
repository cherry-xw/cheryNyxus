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
    put('channels', 576, row + 104)
    link('request', 'model', 'right', 'left', -12, -12)
    link('model', 'response', 'right', 'left', 12, 12)
    link('response', 'channels', 'bottom', 'top')
    link('context', 'request', 'top', 'bottom')
    end('model:error', 'model', 'right', -12)
    end('channels:checkpoint', 'channels', 'right', -12)
    end('channels:tool-list', 'channels', 'right', 12)
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
    pin('channels:checkpoint', 'top', right('channels') + 32)
    pin('channels:tool-list', 'right', cy('channels') + 12)
    height = Math.max(bottom('context'), bottom('channels')) + 64
  } else if (board === 'retry-layer') {
    // The chip's x keeps the error node clear of the retry node (160..308). 408 is the
    // tightest error pin bound for the folded compact state; the node keeps a 16px gap.
    // folded-compact pin (model:error at 244): the chip lands at 164 and the retry board
    // stays 1224 wide, so the tools column (right of it) keeps the whole chain under 3000.
    // When compact is expanded its pin (740) exceeds 408 and the chip stays at 64.
    put('model-layer', Math.max(64, 408 - interfaces.get('model-layer')!['model:error']!.at), 200)
    const errorX = childPin('model-layer', 'model:error').at
    put('retry', 160, 72)
    // Pull error left when the expanded model gives it room. This clears the nearby
    // checkpoint descent while preserving the folded layout's retry separation.
    put('error', Math.max(right('retry') + 16, errorX - 140), 72)
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
    // One horizontal row; the parent returns exit the last node's top/bottom and hug the
    // row's outer band back to the board's left face, so the folded chip keeps its
    // left-face pins for the tools board.
    for (const [i, id] of ['dispatch', 'child-run', 'child-return', 'parent-receive'].entries())
      put(id, 64 + i * 172, 72)
    link('dispatch', 'child-run', 'right', 'left')
    link('child-run', 'child-return', 'right', 'left')
    link('child-return', 'parent-receive', 'right', 'left')
    end('execution:dispatch', 'dispatch', 'top')
    end('parent-receive:input', 'parent-receive', 'bottom', -40)
    end('parent-receive:wake', 'parent-receive', 'top', 40)
    pin('execution:dispatch', 'top', cx('dispatch'))
    // Below the row, clear of the execution:dispatch column and the grid's bottom margin.
    // Wake sits BELOW input on the left face (156 / 180): in the board's own routing the
    // wake's target escape (0,180) sits below the input's y=156 lane, so the wake is forced
    // around the right edge (x=744, y=180) and never seals the dispatch column (x=138, 0..72).
    // The escape must stay within the router's sample axes (y <= height-16 = 184), which
    // caps the pin at 180. In the expanded parent board the two labels still stack below
    // the open chip (wake at 1452, input at 1492); the folded chip re-arranges them by peer
    // order (input above wake), which stacks the labels at 1316 / 1356.
    pin('parent-receive:input', 'left', 156)
    pin('parent-receive:wake', 'left', 180)
  } else if (board === 'tools') {
    // Retry control (with the model layer inside) sits top-left so the cascade stacks
    // vertically instead of growing the board height; the tool chain runs to its right
    // with the failure collector as a straight wall on the far right. Collaboration keeps
    // one compact horizontal row below the processing chain.
    put('retry-layer', 64, 96)
    // The chain starts below the retry chip's right flank so the collapsed top-pin
    // labels (error:result at y 84..108, channels:checkpoint at y 36..60) keep a
    // clear band; the tool-list row itself would block it at y=96.
    // Keep a full routing lane between the expanded retry package and the approval chain.
    // With compact open, channels:tool-list exits the package's right face inside this band;
    // 64px leaves its 24px escape plus the router's clearance before the first node.
    const x = right('retry-layer') + 64,
      y = 148
    for (const [i, id] of ['tool-list', 'validation', 'authorization', 'approval-needed'].entries())
      put(id, x, y + i * 88)
    put('approval', x + 172, n('approval-needed').y + 72)
    put('preflight', x, bottom('approval') + 28)
    put('execution', x, bottom('preflight') + 48)
    put('rejection', x + 347, n('validation').y)
    // One semantic result component, with a separate pin level for every failure source.
    n('rejection').height = bottom('execution') - n('rejection').y
    put('resume', n('rejection').x, y)
    put('tool-result', x, Math.max(bottom('execution') + 48, bottom('rejection') + 48))
    const bottomRowY = Math.max(bottom('retry-layer') + 64, bottom('tool-result') + 48)
    put(
      'collaboration',
      64,
      bottomRowY,
    )
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
    link('resume', 'tool-list', 'top', 'top')
    // Land the resume return on the tool-result's right flank instead of its bottom: the
    // bottom face's two escapes (checkpoint at x=318, resume at x=358, y 832..856) wall the
    // band the dispatch net must cross, forcing it to y=860 where it seals this net's own
    // end. The right flank (y=844) stays clear of the checkpoint lane (y=840, x 0..318)
    // and the dispatch lane (y=860, x 278..432) in every expansion state.
    link('resume', 'tool-result', 'right', 'right', 0, 24)
    end('channels:tool-list', 'tool-list', 'top', -40)
    // Collaboration dispatch owns the left corridor. With the duplicate calls panel gone,
    // the result can leave straight down and align with checkpoint and decision outside.
    end('execution:dispatch', 'execution', 'left')
    end('tool-result:checkpoint', 'tool-result', 'bottom')
    pin('tool-result:checkpoint', 'bottom', cx('tool-result'))
    for (const edge of [
      'command:request',
      'input:request',
      'error:result',
      'channels:checkpoint',
      'channels:tool-list',
    ])
      pass('retry-layer', edge)
    // When retry-layer is folded, its chip top pins sit at 126 (error) / 150 (checkpoint);
    // nudging the checkpoint pin right makes error:result route (and label) first: it claims
    // the (150..278, 60..84) band and the checkpoint label falls left of the chip at
    // (22..126, 60..84). When retry-layer is open, pass() already aligns the pin with its
    // top port, so the override must not apply (it would cut across the error vertical).
    if ((interfaces.get('retry-layer')?.['channels:checkpoint']?.at ?? 0) < 200)
      pin('channels:checkpoint', 'top', 174)
    for (const edge of ['parent-receive:input', 'parent-receive:wake']) pass('collaboration', edge)
  } else if (board === 'record') {
    put('tools', 304, 96)
    put('input', 48, childPin('tools', 'input:request').at - 28)
    put('command', 48, bottom('input') + 40)
    put(
      'checkpoint',
      childPin('tools', 'tool-result:checkpoint').at - n('checkpoint').width / 2,
      bottom('tools') + 48,
    )
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
    pass('tools', 'channels:tool-list')
  } else if (board === 'loop') {
    // The next-iteration return encloses the result path; wait/wake stay outside the cycle.
    put('record', 288, 144)
    put('entry', 64, childPin('record', 'entry:input').at - 28)
    put(
      'decision',
      childPin('record', 'checkpoint:decision').at - n('decision').width / 2,
      bottom('record') + 64,
    )
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
  if (board === 'retry-layer') {
    // The folded error:result label (不可恢复 / 耗尽, 128px wide) is walled on the right by
    // the checkpoint's x=478 descent and on the left by the error:retry label + retry node,
    // so it needs the d=88 slot at x=486 (board >= 622; 646 keeps the d=112 slot too).
    // This only widens the FOLDED board (542 -> 646): the open states are driven by the
    // open chip (>= 1124), and the folded states' tool chain stays narrow, so the width
    // cascade in every affected mask stays far below the 3000 cap.
    width = Math.max(width, 646)
  }
  if (board === 'collaboration') {
    // The horizontal row is only 128px tall; the parent-return routes and their labels
    // need the strip below it, so the board keeps a label-height bottom margin.
    height = Math.max(height, 200)
  }
  return { width, height, boundary, ends }
}
