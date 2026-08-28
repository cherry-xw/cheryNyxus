/**
 * Non-callable identifiers retained for journals, idempotency claims and
 * internal recovery helpers. They are deliberately absent from public Method.
 */
export const InternalCommand = {
  CHAT_GET: 'chat.get',
  CHAT_SEND: 'chat.send',
  CHAT_RESUME: 'chat.resume',
  CHAT_SYNC: 'chat.sync',
  CHAT_START_SPAWN: 'chat.startSpawn',
  CHAT_SEND_TO_CHILD: 'chat.sendToChild',
  CHAT_ATTACH: 'chat.attach',
  SENSE_APPROVAL: 'sense.approval',
  SENSE_QUESTION_ANSWER: 'sense.question.answer',
  SENSE_QUESTION_BATCH_ANSWER: 'sense.question.batchAnswer',
} as const

export type InternalCommand = (typeof InternalCommand)[keyof typeof InternalCommand]

