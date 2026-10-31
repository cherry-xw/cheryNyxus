import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QQDefaultConfig } from '@chery/protocol'
import { migrateLegacyQQSources } from '@/service/ingress/sourceMigration.js'
import { readState } from '../../../../plugins/qq/src/state.js'
import { QQGroupMemoryStore } from '../../../../plugins/qq/src/groupMemory.js'
import { textVersion } from '../../../../plugins/qq/src/files.js'

const tempDirs: string[] = []
const databases: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function createLegacyFixture() {
  const dir = fs.mkdtempSync('/tmp/opencode/qq-source-migration-')
  tempDirs.push(dir)
  const db = new Database(':memory:')
  databases.push(db)
  const groupId = '789000'
  const selfId = '100001'
  const senderId = '200002'
  const eventId1 = `qq:${selfId}:group:${groupId}:5001`
  const eventId2 = `qq:${selfId}:group:${groupId}:5002`

  const legacyInput1 = {
    eventId: eventId1,
    selfId,
    conversationType: 'group',
    targetId: groupId,
    senderId,
    senderName: 'Alice',
    parts: [{ type: 'text', text: '网络已经恢复正常了' }],
    text: '网络已经恢复正常了',
    messageId: '5001',
    mentionedBot: true,
    occurredAt: 1700000001000,
  }
  const legacyInput2 = {
    eventId: eventId2,
    selfId,
    conversationType: 'group',
    targetId: groupId,
    senderId,
    senderName: 'Alice',
    parts: [{ type: 'text', text: '补充说明一条背景消息' }],
    text: '补充说明一条背景消息',
    messageId: '5002',
    mentionedBot: false,
    occurredAt: 1700000002000,
  }

  const legacyState = {
    schemaVersion: 1,
    serviceVersion: 3,
    contextEpoch: '',
    imageSources: {},
    identityBinding: {
      selfId,
      sourceType: 'napcat-action',
      verifiedAt: 1700000000000,
      sourceVersion: '1.0.0',
    },
    jobs: [
      {
        requestId: 'req-legacy-1',
        coreRequestId: 'core-legacy-1',
        input: legacyInput1,
        target: `group:${groupId}`,
        conversationKey: `${selfId}:group:${groupId}:preset-1`,
        snapshot: {
          revision: 1,
          config: {
            ...QQDefaultConfig,
            selfId,
            groups: [groupId],
            bindings: { [`group:${groupId}`]: 'default' },
          },
          preset: 'default',
          brain: 'default',
          senseGroup: 'default',
          presetId: 'preset-1',
        },
        state: 'completed',
        acceptedAt: 1700000001000,
        version: 2,
        reply: '好的，已记录网络恢复。',
        toolIds: [],
        waits: 0,
      },
    ],
    outbox: [
      {
        frame: {
          kind: 'notification',
          type: 'qq.reply.part',
          data: {
            eventId: 'out-legacy-1',
            requestId: 'req-legacy-1',
            selfId,
            conversationType: 'group',
            targetId: groupId,
            seq: 1,
            partIndex: 1,
            totalParts: 1,
            text: '好的，已记录网络恢复。',
          },
        },
        status: 'sent',
        confirmedAt: 1700000003000,
        messageIds: ['6001'],
      },
    ],
    seq: { [`group:${groupId}`]: 1 },
    receipts: { [eventId1]: { hash: 'h1', accepted: true } },
    windows: {},
    discussions: {
      [`group:${groupId}`]: {
        events: [legacyInput1, legacyInput2],
        pendingChars: 20,
        summaryPending: false,
        summaryRunning: false,
        lastEventAt: 1700000002000,
      },
    },
    configWrites: {},
  }

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacyState), { mode: 0o600 })

  const topicsDir = path.join(dir, 'memory', 'topics')
  fs.mkdirSync(topicsDir, { recursive: true, mode: 0o700 })
  const topicFile = path.join(topicsDir, `${textVersion(groupId)}.json`)
  const legacyGroupMemory = {
    schemaVersion: 2,
    groupId,
    revision: 1,
    updatedAt: 1700000002500,
    records: [
      {
        id: 'net-recovered',
        topic: '网络',
        kind: 'experience',
        content: 'Alice 确认网络已恢复正常',
        members: [senderId],
        evidence: 'statement',
        sources: [
          {
            messageId: '5001',
            userId: senderId,
            occurredAt: 1700000001000,
          },
        ],
        status: 'active',
        updatedAt: 1700000002500,
      },
    ],
    operations: {},
  }
  fs.writeFileSync(topicFile, JSON.stringify(legacyGroupMemory), { mode: 0o600 })

  return { dir, db, groupId, selfId, senderId, topicFile }
}

describe('one-time legacy QQ source migration', () => {
  it('rejects unmigrated legacy state (schemaVersion 1) and legacy group memory (schemaVersion 2) at runtime', async () => {
    const { dir, groupId, selfId, senderId } = createLegacyFixture()
    expect(() => readState(path.join(dir, 'state.json'))).toThrow(/Unsupported legacy QQ plugin state/)
    const store = new QQGroupMemoryStore(dir)
    await expect(
      store.search({ selfId, userId: senderId, groupId, conversationType: 'group' }, '网络'),
    ).rejects.toThrow(/Unsupported legacy group memory format/)
  })

  it('supports read-only dry-run preview, verified backup, atomic conversion, and idempotent re-run', async () => {
    const { dir, db, groupId, selfId, senderId } = createLegacyFixture()

    const preview = migrateLegacyQQSources({
      db,
      dataDir: dir,
      mode: 'dry-run',
    })
    expect(preview.conflicts).toEqual([])
    expect(preview.stateSchemaVersionBefore).toBe(1)
    expect(preview.stateSchemaVersionAfter).toBe(2)
    expect(preview.memberRecordsImported).toBe(2)
    expect(preview.botDeliveriesImported).toBe(1)
    expect(preview.groupMemoryFilesMigrated).toBe(1)

    // Dry-run must not mutate state.json or database rows
    expect(() => readState(path.join(dir, 'state.json'))).toThrow(/Unsupported legacy QQ plugin state/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'source_%'").all()).toEqual([])

    // Apply migration
    const applied = migrateLegacyQQSources({
      db,
      dataDir: dir,
      mode: 'apply',
    })
    expect(applied.conflicts).toEqual([])
    expect(applied.backupManifestPath).toBeTruthy()
    expect(fs.existsSync(applied.backupManifestPath!)).toBe(true)

    // Runtime state and group memory now pass strict schema validation
    const migratedState = readState(path.join(dir, 'state.json'))
    expect(migratedState.schemaVersion).toBe(2)
    expect(migratedState.jobs[0]?.sourceScopeId).toBeTruthy()
    expect(migratedState.jobs[0]?.sourceRecords).toHaveLength(1)

    const store = new QQGroupMemoryStore(dir)
    const searchResult = await store.search(
      { selfId, userId: senderId, groupId, conversationType: 'group' },
      '网络',
    )
    expect(searchResult.records).toHaveLength(1)
    expect(searchResult.records[0]!.sources[0]!.source.recordId).toMatch(/^record-/)
    expect(searchResult.records[0]!.sources[0]!.partIds).toEqual(['p1'])

    // Idempotent re-run produces zero conflicts and does not duplicate records
    const rerun = migrateLegacyQQSources({
      db,
      dataDir: dir,
      mode: 'apply',
    })
    expect(rerun.conflicts).toEqual([])
    expect(rerun.alreadyMigrated).toBe(true)
    const totalRecords = (db.prepare('SELECT COUNT(*) AS n FROM source_records').get() as { n: number }).n
    expect(totalRecords).toBe(3)
  })

  it('reports conflicts and refuses to overwrite files when group memory references an unverified source', () => {
    const { dir, db, topicFile } = createLegacyFixture()
    const badMemory = JSON.parse(fs.readFileSync(topicFile, 'utf8'))
    badMemory.records[0].sources.push({
      messageId: '999999',
      userId: '200002',
      occurredAt: 1700000009000,
    })
    fs.writeFileSync(topicFile, JSON.stringify(badMemory), { mode: 0o600 })

    const report = migrateLegacyQQSources({
      db,
      dataDir: dir,
      mode: 'apply',
    })
    expect(report.conflicts).toEqual([
      expect.objectContaining({
        kind: 'group_memory_source_missing',
      }),
    ])
    // Files remain untouched and database rolled back
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).schemaVersion).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_records').get() as { n: number }).n).toBe(0)
  })

  it('prefers full job input over shortened discussion copies and never imports fabricated bot background', () => {
    const { dir, db, selfId } = createLegacyFixture()
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
    const discussion = Object.values(state.discussions)[0] as any
    discussion.events[0].parts = [{type:'text',text:'[时间] 裁剪副本'}]
    discussion.events.push({...discussion.events[0],eventId:'fabricated',messageId:'6001',senderId:selfId,
      parts:[{type:'text',text:'错误的完整机器人回答'}]})
    discussion.events.push({...discussion.events[0],eventId:'untrusted',messageId:'5999',parts:undefined,content:'没有可信原始段的副本'})
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
    expect(migrateLegacyQQSources({db,dataDir:dir,mode:'apply'}).conflicts).toEqual([])
    const records = db.prepare('SELECT data_json FROM source_records ORDER BY ingest_ordinal').all() as {data_json:string}[]
    expect(records).toHaveLength(3)
    const content = records.map(row=>JSON.parse(row.data_json).parts.map((part:any)=>part.text??'').join('')).join('\n')
    expect(content).toContain('网络已经恢复正常了')
    expect(content).not.toContain('裁剪副本');expect(content).not.toContain('错误的完整机器人回答');expect(content).not.toContain('没有可信原始段')
  })

  it('resumes committed conversion after a file publication interruption without overwriting the original backup', () => {
    const { dir, db, topicFile } = createLegacyFixture()
    const stateFile = path.join(dir,'state.json'), originalState = fs.readFileSync(stateFile,'utf8')
    const rename = fs.renameSync
    let fail = true
    vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
      if (to===stateFile && fail) { fail=false;throw new Error('synthetic publication interruption') }
      rename(from,to)
    })
    expect(()=>migrateLegacyQQSources({db,dataDir:dir,mode:'apply'})).toThrow('synthetic publication interruption')
    expect(fs.readFileSync(stateFile,'utf8')).toBe(originalState)
    expect(JSON.parse(fs.readFileSync(topicFile,'utf8')).schemaVersion).toBe(3)
    const pending = db.prepare('SELECT operation_id,data_json FROM source_legacy_migrations').get() as {operation_id:string;data_json:string}
    const publication=JSON.parse(pending.data_json)
    const backupState=JSON.parse(fs.readFileSync(publication.report.backupManifestPath,'utf8')).files.find((file:any)=>file.originalPath===stateFile).backupPath
    expect(fs.readFileSync(backupState,'utf8')).toBe(originalState)
    expect(migrateLegacyQQSources({db,dataDir:dir}).publicationState).toBe('pending')
    const resumed=migrateLegacyQQSources({db,dataDir:dir,mode:'apply'})
    expect(resumed.operationId).toBe(pending.operation_id)
    expect(resumed.publicationState).toBe('completed')
    expect(fs.readFileSync(backupState,'utf8')).toBe(originalState)
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_records').get() as {n:number}).n).toBe(3)
    expect(migrateLegacyQQSources({db,dataDir:dir,mode:'apply'}).alreadyMigrated).toBe(true)
  })

  it('does not commit source data when backup cannot be written', () => {
    const {dir,db}=createLegacyFixture(), write=fs.writeFileSync
    vi.spyOn(fs,'writeFileSync').mockImplementation((...args:any[])=>{
      if (typeof args[0]==='string' && args[0].includes('migration-backup-v1-to-v2')) throw new Error('synthetic backup unavailable')
      return (write as any)(...args)
    })
    expect(()=>migrateLegacyQQSources({db,dataDir:dir,mode:'apply'})).toThrow('synthetic backup unavailable')
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({n:0})
    expect(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).schemaVersion).toBe(1)
  })

  it('converts native question replies into their own source records and retains unknown deliveries without resending', () => {
    const {dir,db}=createLegacyFixture(),file=path.join(dir,'state.json')
    const state=JSON.parse(fs.readFileSync(file,'utf8')),job=state.jobs[0]
    const reply={...job.input,eventId:job.input.eventId.replace('5001','5003'),messageId:'5003',replyToMessageId:'6001',
      parts:[{type:'text',text:'确认的答案'}],text:'确认的答案',occurredAt:1700000004000}
    job.state='paused'
    job.questions={batchId:'legacy-batch',runId:'legacy-run',items:[{questionId:'q1',question:'是否确认？',options:[],multiSelect:false,eventId:'out-legacy-1',answer:'确认的答案'}],replies:[reply]}
    state.outbox.push({...state.outbox[0],frame:{...state.outbox[0].frame,data:{...state.outbox[0].frame.data,eventId:'unknown-output',seq:2,text:'结果未知的正文'}},status:'unknown',messageIds:[]})
    fs.writeFileSync(file,JSON.stringify(state))
    expect(migrateLegacyQQSources({db,dataDir:dir,mode:'apply'}).conflicts).toEqual([])
    const migrated=readState(file),questions=migrated.jobs[0]!.questions!
    expect(questions.replies[0]!.sourceParts).toContainEqual(expect.objectContaining({type:'text',text:'确认的答案'}))
    const reference=questions.items[0]!.answerRecord!
    expect(reference.recordId).toMatch(/^record-/)
    expect(JSON.parse((db.prepare('SELECT result_json FROM source_receipts WHERE record_id=?').get(reference.recordId) as {result_json:string}).result_json).handling)
      .toEqual({kind:'question_answer',requestId:job.requestId,runId:'legacy-run',batchId:'legacy-batch',questionId:'q1'})
    expect(migrated.outbox.find(output=>output.frame.data.eventId==='unknown-output')?.status).toBe('unknown')
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({n:4})
    expect(migrateLegacyQQSources({db,dataDir:dir,mode:'apply'}).alreadyMigrated).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({n:4})
  })

  it.each(['robot','preset'])('refuses ambiguous %s identity for the same legacy target before publication', kind => {
    const {dir,db}=createLegacyFixture(),file=path.join(dir,'state.json'),original=JSON.parse(fs.readFileSync(file,'utf8'))
    const other=structuredClone(original.jobs[0]);other.requestId='another-job'
    if(kind==='robot')other.input.selfId='300003'
    else other.snapshot.presetId='another-preset'
    original.jobs.push(other);fs.writeFileSync(file,JSON.stringify(original))
    const before=fs.readFileSync(file,'utf8'),report=migrateLegacyQQSources({db,dataDir:dir,mode:'apply'})
    expect(report.conflicts).toContainEqual(expect.objectContaining({kind:'unresolvable_scope'}))
    expect(fs.readFileSync(file,'utf8')).toBe(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({n:0})
  })
})
