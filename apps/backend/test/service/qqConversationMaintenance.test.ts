import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { sourceFixture } from '../helpers/sourceContext.js'
import { initAssetTables } from '@/db/assets.js'
import { cleanupQQConversation,convertQQConversationBundle,planQQCleanup } from '@/service/ingress/qqConversationMaintenance.js'
import { emptyState,atomicJson,digest,readState } from '../../../../plugins/qq/src/state.js'
import { QQKnowledgeStore,TermInputSchema } from '../../../../plugins/qq/src/knowledge.js'
import { QQDefaultConfig } from '@chery/protocol'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true})})
function fixture(){
  const dir=fs.mkdtempSync('/tmp/opencode/qq-clean-');dirs.push(dir)
  const f=sourceFixture();initAssetTables(f.db);f.receive('QQ历史正文')
  f.db.exec('CREATE TABLE chats(id TEXT PRIMARY KEY)')
  const other={...f.authority,ownerId:'other',selfId:'101'}
  f.repo.applyScopes(other,1,[{...f.target,targetId:other.targetId}])
  const db=path.join(dir,'soul.db');fs.writeFileSync(db,f.db.serialize());f.db.close()
  const dataDir=path.join(dir,'qq');fs.mkdirSync(dataDir);const state=emptyState()
  state.identityBinding={selfId:'100',sourceType:'napcat-action',verifiedAt:1,sourceVersion:'1.0.0'}
  state.receipts.old={hash:'saved-hash',accepted:true}
  atomicJson(path.join(dataDir,'state.json'),state)
  fs.mkdirSync(path.join(dataDir,'memory','personal'),{recursive:true});fs.writeFileSync(path.join(dataDir,'memory','personal','old.json'),'{"memories":{"old":"旧内容"}}')
  fs.writeFileSync(path.join(dataDir,'reminders.json'),'preserved');fs.mkdirSync(path.join(dataDir,'user-files'));fs.writeFileSync(path.join(dataDir,'user-files','note'),'preserved')
  return {db,dataDir,owner:'qq-fixture',selfId:'100',operationId:'cleanup-test'}
}
function manifest(input:ReturnType<typeof fixture>) {
  const db=new Database(input.db,{readonly:true})
  try {const plan=planQQCleanup(db,input.dataDir,input.db,input.owner,input.selfId,input.operationId)
    atomicJson(path.join(input.dataDir,`conversation-clean-${input.operationId}.json`),plan);return plan
  }finally{db.close()}
}
describe('offline QQ conversation maintenance',()=>{
  it('previews without writes and requires explicit stopped apply',()=>{
    const input=fixture(),before=fs.readFileSync(input.db)
    expect(cleanupQQConversation(input).completed).toBe(false)
    expect(fs.readFileSync(input.db)).toEqual(before)
    expect(()=>cleanupQQConversation({...input,apply:true})).toThrow('STOPPED_BACKEND_REQUIRED')
  })
  it('clears only QQ bodies and memory; repeat operation preserves new data',async()=>{
    const input=fixture()
    expect(cleanupQQConversation({...input,apply:true,stopped:true}).completed).toBe(true)
    const Database=(await import('better-sqlite3')).default,db=new Database(input.db)
    try{expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({n:0})
      expect(db.prepare("SELECT COUNT(*) AS n FROM source_scopes s JOIN source_conversations c USING(conversation_id) WHERE c.owner_id='other'").get()).toEqual({n:1})
    }finally{db.close()}
    const state=JSON.parse(fs.readFileSync(path.join(input.dataDir,'state.json'),'utf8'));expect(state.clearedEvents.length).toBeGreaterThan(0)
    expect(state.sourceReceipts).toEqual({});expect(state.identityBinding.selfId).toBe('100')
    fs.writeFileSync(path.join(input.dataDir,'memory','personal','new.json'),'new data')
    expect(cleanupQQConversation({...input,apply:true,stopped:true}).completed).toBe(true)
    expect(fs.readFileSync(path.join(input.dataDir,'memory','personal','new.json'),'utf8')).toBe('new data')
    expect(fs.readFileSync(path.join(input.dataDir,'reminders.json'),'utf8')).toBe('preserved')
    expect(fs.readFileSync(path.join(input.dataDir,'user-files','note'),'utf8')).toBe('preserved')
  })
  it('converts selections and role rules without relaxing supervision',()=>{
    const old=structuredClone(QQDefaultConfig) as Record<string,any>;delete old.schemaVersion;old.historyLimit=20;delete old.backgroundMessageLimit;delete old.managementHistoryLimit
    const result=convertQQConversationBundle({config:old,toolGroups:{qq:['qq_react:manual']},roles:{main:{permissions:{tools:{qq_react:'deny'}}}}})
    expect(result.bundle.toolGroups.qq).toEqual(['qq_interact.reaction:manual'])
    expect(result.bundle.roles.main.permissions.tools).toEqual({'qq_interact.reaction':'deny'})
    expect(result.bundle.config.backgroundMessageLimit).toBe(20)
  })
  it('matches all composite foreign-key columns and clears only owned monthly bodies',()=>{
    const input=fixture(),db=new Database(input.db),monthFile=path.join(path.dirname(input.db),'2026-10.db')
    try {
      db.exec("ALTER TABLE chats ADD COLUMN parent_chat_id TEXT; INSERT INTO chats VALUES ('qq-chat',NULL),('qq-child','qq-chat'),('other-chat',NULL)")
      db.prepare("UPDATE source_scopes SET data_json=json_set(data_json,'$.coreBinding',json(?)) WHERE conversation_id IN (SELECT conversation_id FROM source_conversations WHERE owner_id=?)").run(JSON.stringify({chatId:'qq-chat',epochId:'epoch'}),input.owner)
      db.exec(`CREATE TABLE cleanup_parents(owner TEXT,n INTEGER,chat_id TEXT,PRIMARY KEY(owner,n));
        CREATE TABLE cleanup_children(id TEXT PRIMARY KEY,parent_owner TEXT,parent_n INTEGER,body TEXT,FOREIGN KEY(parent_owner,parent_n) REFERENCES cleanup_parents(owner,n) ON DELETE CASCADE);
        INSERT INTO cleanup_parents VALUES ('qq',1,'qq-chat'),('other',1,'other-chat');
        INSERT INTO cleanup_children VALUES ('qq-body','qq',1,'QQ正文'),('other-body','other',1,'其他正文')`)
    }finally{db.close()}
    const month=new Database(monthFile)
    try{month.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT,content TEXT);
      INSERT INTO messages VALUES ('own','qq-chat','QQ正文'),('child','qq-child','子任务正文'),('other','other-chat','其他正文');
      CREATE TABLE question_batches(batch_id TEXT PRIMARY KEY,chat_id TEXT,status TEXT);
      CREATE TABLE question_items(question_id TEXT PRIMARY KEY,batch_id TEXT,answer_text TEXT);
      INSERT INTO question_batches VALUES ('qq-batch','qq-chat','answered'),('other-batch','other-chat','answered');
      INSERT INTO question_items VALUES ('qq-answer','qq-batch','QQ答案'),('other-answer','other-batch','其他答案')`)}finally{month.close()}
    cleanupQQConversation({...input,apply:true,stopped:true})
    const after=new Database(input.db),afterMonth=new Database(monthFile)
    try{
      expect(after.prepare('SELECT id,body FROM cleanup_children').all()).toEqual([{id:'other-body',body:'其他正文'}])
      expect(after.prepare('SELECT id FROM chats').all()).toEqual([{id:'other-chat'}])
      expect(afterMonth.prepare('SELECT id FROM messages').all()).toEqual([{id:'other'}])
      expect(afterMonth.prepare('SELECT question_id FROM question_items').all()).toEqual([{question_id:'other-answer'}])
    }finally{after.close();afterMonth.close()}
  })
  it('keeps other robots knowledge and caches even when they share the module directory',async()=>{
    const input=fixture(),store=new QQKnowledgeStore(input.dataDir)
    const subject={selfId:'100',conversationType:'group' as const,groupId:'999',userId:'123'},other={...subject,selfId:'101'}
    const term=TermInputSchema.parse({id:'fact',term:'约定',meaning:'测试约定',evidenceRefs:['admin']})
    for(const selected of [subject,other])await store.manage(selected,'local',{operationId:'one',expectedRevision:0,save:[term],delete:[],admin:true},[{kind:'admin',evidenceId:'admin',note:'测试'}])
    await store.cache(subject.selfId,'fragment','own cache');await store.cache(other.selfId,'fragment','other cache')
    cleanupQQConversation({...input,apply:true,stopped:true})
    expect((await store.list(subject,'local')).entries).toEqual([])
    expect((await store.list(other,'local')).entries).toHaveLength(1)
    expect(await store.cache(subject.selfId,'fragment')).toBeUndefined()
    expect(await store.cache(other.selfId,'fragment')).toBe('other cache')
  })
  it.each(['state','memory','source'])('preflights changed %s before deleting another store',kind=>{
    const input=fixture(),plan=manifest(input)
    expect(()=>readState(path.join(input.dataDir,'state.json'))).toThrow('QQ_CONVERSATION_CLEANUP_INCOMPLETE')
    if(kind==='state'){
      const file=path.join(input.dataDir,'state.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));state.seq.test=1;atomicJson(file,state)
    }else if(kind==='memory')fs.writeFileSync(plan.files[0]!.file,'{"changed":true}')
    else {const db=new Database(input.db);try{db.exec('UPDATE source_records SET revision=revision+1')}finally{db.close()}}
    expect(()=>cleanupQQConversation({...input,apply:true,stopped:true})).toThrow(kind==='state'?'STATE_CHANGED':kind==='memory'?'MEMORY_CHANGED':'SOURCE_CHANGED')
    const db=new Database(input.db);try{expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({n:1})}finally{db.close()}
    expect(JSON.parse(fs.readFileSync(path.join(input.dataDir,`conversation-clean-${input.operationId}.json`),'utf8')).phase).toBe(0)
  })
  it('resumes the same fixed manifest and retains prior deleted-event hashes',()=>{
    const input=fixture();manifest(input)
    expect(cleanupQQConversation({...input,apply:true,stopped:true}).completed).toBe(true)
    const file=path.join(input.dataDir,'state.json'),state=readState(file)
    state.receipts.fresh={hash:'hash',accepted:false};state.seq.preserved=17;state.configWrites.saved={hash:'configuration',response:{saved:true}}
    atomicJson(file,state);fs.writeFileSync(path.join(input.dataDir,'config.json'),'unchanged-config');fs.writeFileSync(path.join(input.dataDir,'credential'),'unchanged-credential')
    cleanupQQConversation({...input,operationId:'second-clean',apply:true,stopped:true})
    const result=readState(file)
    expect(result.clearedEvents).toEqual(expect.arrayContaining([digest('old'),digest('fresh')]))
    expect(result.seq.preserved).toBe(17);expect(result.configWrites.saved).toEqual(state.configWrites.saved)
    expect(fs.readFileSync(path.join(input.dataDir,'config.json'),'utf8')).toBe('unchanged-config')
    expect(fs.readFileSync(path.join(input.dataDir,'credential'),'utf8')).toBe('unchanged-credential')
  })
  it('finishes only remaining stores after a committed monthly deletion',()=>{
    const input=fixture(),db=new Database(input.db),monthly=path.join(path.dirname(input.db),'2026-10.db')
    try{db.prepare("UPDATE source_scopes SET data_json=json_set(data_json,'$.coreBinding',json(?)) WHERE conversation_id IN (SELECT conversation_id FROM source_conversations WHERE owner_id=?)").run(JSON.stringify({chatId:'qq-chat',epochId:'epoch'}),input.owner)}finally{db.close()}
    const month=new Database(monthly)
    try{month.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT,content TEXT); INSERT INTO messages VALUES ('old','qq-chat','旧正文')")}finally{month.close()}
    const plan=manifest(input),committed=new Database(monthly)
    try{committed.prepare('DELETE FROM messages WHERE id=?').run('old');committed.prepare('INSERT INTO messages VALUES (?,?,?)').run('unselected','other-chat','后续非QQ正文')}finally{committed.close()}
    plan.phase=1;atomicJson(path.join(input.dataDir,`conversation-clean-${input.operationId}.json`),plan)
    expect(()=>cleanupQQConversation({...input,operationId:'another',apply:true,stopped:true})).toThrow('OTHER_CLEANUP_INCOMPLETE')
    expect(cleanupQQConversation({...input,apply:true,stopped:true}).completed).toBe(true)
    const after=new Database(monthly)
    try{expect(after.prepare('SELECT id FROM messages').all()).toEqual([{id:'unselected'}])}finally{after.close()}
    expect(readState(path.join(input.dataDir,'state.json')).sourceScopes).toEqual({})
  })
  it.each(['running','question','unknown','receipt'])('refuses unresolved %s without changing data',kind=>{
    const input=fixture(),file=path.join(input.dataDir,'state.json'),state=JSON.parse(fs.readFileSync(file,'utf8'))
    if(kind==='running')state.jobs=[{state:'running'}]
    if(kind==='question')state.jobs=[{state:'completed',questionBatches:[{status:'pending'}]}]
    if(kind==='unknown')state.outbox=[{status:'unknown'}]
    if(kind==='receipt')state.sourceReceipts.test={pendingReceipt:true}
    atomicJson(file,state)
    expect(()=>cleanupQQConversation({...input,apply:true,stopped:true})).toThrow('UNRESOLVED_QQ_WORK')
    expect(fs.existsSync(path.join(input.dataDir,`conversation-clean-${input.operationId}.json`))).toBe(false)
  })
})
