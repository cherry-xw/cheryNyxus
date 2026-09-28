import { getSoulDb } from './index.js'

export interface PendingInputRow {
  input_id: string
  chat_id: string
  message_id: string
  client_message_id: string | null
  command_id: string
  content: string
  queue_sequence: number
  state: 'accepted' | 'started' | 'queued' | 'consumed' | 'cancelled' | 'rejected'
  accepted_at: number
  consumed_at: number | null
  epoch_id?: string | null
}

/** Durable command-plane input queue. Accepted rows survive a process restart. */
export function addPendingInput(input: {
  inputId: string
  chatId: string
  messageId: string
  clientMessageId?: string
  commandId: string
  content: string
  queueSequence: number
  state: PendingInputRow['state']
  acceptedAt: number
}): void {
  const epoch = getSoulDb()
    .prepare('SELECT active_epoch_id FROM chats WHERE id = ?')
    .get(input.chatId) as { active_epoch_id: string | null } | undefined
  getSoulDb()
    .prepare(
      `INSERT INTO pending_inputs
        (input_id, chat_id, message_id, client_message_id, command_id, content, queue_sequence, state, accepted_at, epoch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.inputId,
      input.chatId,
      input.messageId,
      input.clientMessageId ?? null,
      input.commandId,
      input.content,
      input.queueSequence,
      input.state,
      input.acceptedAt,
      epoch?.active_epoch_id ?? null,
    )
}

export function listPendingInputs(chatId: string): PendingInputRow[] {
  return getSoulDb()
    .prepare(
      `SELECT * FROM pending_inputs
       WHERE chat_id = ? AND state IN ('accepted', 'started', 'queued')
         AND (
           epoch_id = (SELECT active_epoch_id FROM chats WHERE id = ?)
           OR (epoch_id IS NULL AND (SELECT active_epoch_id FROM chats WHERE id = ?) IS NULL)
         )
       ORDER BY queue_sequence ASC, accepted_at ASC`,
    )
    .all(chatId, chatId, chatId) as PendingInputRow[]
}

export function markPendingInputsConsumed(chatId: string, inputIds: string[]): void {
  if (inputIds.length === 0) return
  const db = getSoulDb()
  const update = db.prepare(
    `UPDATE pending_inputs SET state = 'consumed', consumed_at = ?
     WHERE chat_id = ? AND input_id = ? AND state IN ('accepted', 'started', 'queued')`,
  )
  const tx = db.transaction((ids: string[]) => {
    const now = Date.now()
    for (const id of ids) update.run(now, chatId, id)
  })
  tx(inputIds)
}
