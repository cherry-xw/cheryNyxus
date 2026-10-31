import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { atomicJson, digest, safePath } from '../../../../../plugins/qq/src/state.js'
import { convertQQConfiguration } from '../../../../../plugins/qq/src/configConversion.js'
import { convertQQToolGroups } from '../../../../../plugins/qq/src/toolConversion.js'

type Row = Record<string, any>
type Selection = { table: string; key: Row; hash: string }
type Manifest = { operationId: string; identity: string; epoch: string; stateHash: string; phase: number;
  stores: Array<{ file: string; rows: Selection[] }>; files: Array<{ file: string; hash: string }>; events: string[] }
const fail = (code: string): never => { throw new Error(code) }
const quote = (name: string) => '"' + name.replaceAll('"','""') + '"'
function read(file: string) { safePath(file); return JSON.parse(fs.readFileSync(file,'utf8')) as Row }
function tables(db: Database.Database) { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row=>row.name) }
function rows(db: Database.Database, table: string) { return db.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[] }
function primary(db: Database.Database, table: string) { return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{name:string;pk:number}>).filter(col=>col.pk).sort((a,b)=>a.pk-b.pk).map(col=>col.name) }
const terminal = (state: string) => ['completed','failed','cancelled','interrupted','ended'].includes(state)

/** Identifiers and hashes only. Never writes a backup containing deleted message bodies. */
export function planQQCleanup(db: Database.Database, dataDir: string, dbFile: string, owner: string, selfId: string, operationId: string): Manifest {
  const state = read(path.join(dataDir,'state.json'))
  if (state.identityBinding?.selfId !== selfId || ![1,2,3].includes(state.schemaVersion)) fail('IDENTITY_MISMATCH')
  if ((state.jobs ?? []).some((job: Row)=>!terminal(job.state)) || (state.outbox ?? []).some((out: Row)=>!['sent','failed'].includes(out.status)) ||
    Object.values(state.sourceReceipts ?? {}).some((receipt:any)=>receipt.pendingReceipt)) fail('UNRESOLVED_QQ_WORK')
  const names = tables(db), conversations = names.includes('source_conversations') ? rows(db,'source_conversations').filter(row=>row.owner_id===owner&&row.channel==='qq'&&row.self_id===selfId) : []
  const conversationIds = new Set(conversations.map(row=>row.conversation_id)), scopeRows = names.includes('source_scopes') ? rows(db,'source_scopes').filter(row=>conversationIds.has(row.conversation_id)) : []
  const scopes = new Set(scopeRows.map(row=>row.scope_id)), chats = new Set<string>(), requests = new Set<string>()
  for (const row of scopeRows) {const scope=JSON.parse(row.data_json);if(scope.coreBinding)chats.add(scope.coreBinding.chatId)}
  for (const job of state.jobs ?? []) {if(job.input.selfId!==selfId)fail('MIXED_ROBOT_STATE');if(job.coreChatId)chats.add(job.coreChatId);requests.add(job.requestId);if(job.coreRequestId)requests.add(job.coreRequestId)}
  // Descendant chats are owned only through the already verified QQ roots.
  const chatRows=names.includes('chats')?rows(db,'chats'):[]
  let changed=true
  while(changed){changed=false;for(const chat of chatRows)if(chat.parent_chat_id&&chats.has(chat.parent_chat_id)&&!chats.has(chat.id)){chats.add(chat.id);changed=true}}
  const sourceRuns=names.includes('source_runs')?rows(db,'source_runs').filter(row=>scopes.has(row.scope_id)):[]
  for(const run of sourceRuns)requests.add(run.request_id)
  const runs=new Set(sourceRuns.map(row=>row.run_id))
  if(names.includes('source_tasks'))for(const task of rows(db,'source_tasks'))if(chats.has(task.chat_id)){
    if(!terminal(task.state))fail('UNRESOLVED_SOURCE_TASK');runs.add(task.run_id);requests.add(task.request_id)
  }
  for(const table of ['pending_inputs','interactions','execution_active_runs','agent_commands'])if(names.includes(table))for(const row of rows(db,table))if(chats.has(row.chat_id)||chats.has(row.root_chat_id)){
    if(table==='execution_active_runs'||table==='pending_inputs'&&!['consumed','cancelled'].includes(row.state)||table==='interactions'&&row.status==='pending'||table==='agent_commands'&&['running','starting'].includes(row.status))fail('UNRESOLVED_CORE_WORK')
  }
  const selected = new Map<string, Row[]>()
  const protectedTables = new Set(['assets','asset_versions','asset_draft_references','config_revisions','source_conversations','source_owner_access'])
  const chatColumns=['chat_id','root_chat_id','source_chat_id','parent_chat_id','child_chat_id','delivery_chat_id','original_chat_id','anchor_root_chat_id','task_key']
  for(const table of names){
    if(protectedTables.has(table)||table.startsWith('qq_conversation_maintenance'))continue
    const own=rows(db,table).filter(row=>{
      if(table==='chats')return chats.has(row.id)
      if(table==='source_config_applications')return row.owner_id===owner&&row.channel==='qq'&&row.self_id===selfId
      if(table==='source_legacy_migrations')return row.data_dir===path.resolve(dataDir)
      return scopes.has(row.scope_id)||conversationIds.has(row.conversation_id)||runs.has(row.run_id)||requests.has(row.request_id)||chatColumns.some(col=>chats.has(row[col]))
    })
    if(own.length)selected.set(table,own)
  }
  // Follow declared foreign keys for dependent bodies without guessing from JSON.
  changed=true
  while(changed){changed=false;for(const table of names){
    if(protectedTables.has(table))continue
    const keys=db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as Array<{table:string;from:string;to:string}>
    const existing=selected.get(table)??[], pk=primary(db,table)
    for(const row of rows(db,table))if(!existing.includes(row)&&keys.some(key=>(selected.get(key.table)??[]).some(parent=>row[key.from]!==null&&row[key.from]===parent[key.to]))){
      if(existing.some(old=>pk.every(col=>old[col]===row[col])))continue
      existing.push(row);selected.set(table,existing);changed=true
    }
  }}
  const manifestRows: Selection[]=[]
  for(const [table,selectedRows] of selected){const pk=primary(db,table);if(!pk.length)fail('UNKNOWN_ROW_IDENTITY')
    for(const row of selectedRows){
      if(row.scope_id&&names.includes('source_scopes')&&rows(db,'source_scopes').some(scope=>scope.scope_id===row.scope_id)&&!scopes.has(row.scope_id))fail('CROSS_SCOPE_REFERENCE')
      for(const col of chatColumns)if(row[col]&&chatRows.some(chat=>chat.id===row[col])&&!chats.has(row[col]))fail('CROSS_CHAT_REFERENCE')
      manifestRows.push({table,key:Object.fromEntries(pk.map(col=>[col,row[col]])),hash:digest(row)})
    }
  }
  const stores: Manifest['stores']=[{file:dbFile,rows:manifestRows}]
  for(const name of fs.readdirSync(path.dirname(dbFile)).filter(name=>/^\d{4}-\d{2}\.db$/.test(name))){
    const file=path.join(path.dirname(dbFile),name);safePath(file);const month=new Database(file,{readonly:true,fileMustExist:true})
    try{const selectedRows:Selection[]=[];for(const table of ['messages','chat_events','question_batches','question_items'])if(tables(month).includes(table)){
      const batches=tables(month).includes('question_batches')?new Set(rows(month,'question_batches').filter(row=>chats.has(row.chat_id)).map(row=>row.batch_id)):new Set()
      for(const row of rows(month,table).filter(row=>chats.has(row.chat_id)||table==='question_items'&&batches.has(row.batch_id))){
        if(table==='question_batches'&&['pending','saved','starting'].includes(row.status))fail('UNRESOLVED_QUESTION')
        const pk=primary(month,table);if(!pk.length)fail('UNKNOWN_ROW_IDENTITY');selectedRows.push({table,key:Object.fromEntries(pk.map(col=>[col,row[col]])),hash:digest(row)})
      }
    }if(selectedRows.length)stores.unshift({file,rows:selectedRows})}finally{month.close()}
  }
  const files:Manifest['files']=[], memory=path.join(dataDir,'memory')
  function scan(dir:string){safePath(dir);for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);safePath(file)
    if(entry.isDirectory())scan(file)
    else if(entry.isFile()&&entry.name.endsWith('.json')){const bytes=fs.readFileSync(file);files.push({file,hash:digest(bytes.toString('utf8'))})}
    else fail('UNRESOLVED_MEMORY_FILE')
  }}
  if(fs.existsSync(memory))scan(memory)
  return {operationId,identity:digest([owner,selfId,path.resolve(dataDir),path.resolve(dbFile)]),epoch:`qq-clean-${operationId}`,phase:0,stateHash:digest(state),stores,files,
    events:[...new Set([...Object.keys(state.receipts??{}),...Object.keys(state.sourceReceipts??{}),...conversations.flatMap(conversation=>names.includes('source_receipt_events')?rows(db,'source_receipt_events').filter(row=>row.conversation_id===conversation.conversation_id).map(row=>row.event_id):[])])].map(event=>digest(event))}
}

export function cleanupQQConversation(input:{db:string;dataDir:string;owner:string;selfId:string;operationId:string;apply?:boolean;stopped?:boolean}){
  for(const file of [input.db,path.join(input.dataDir,'state.json')]){if(!path.isAbsolute(file))fail('ABSOLUTE_PATH_REQUIRED');safePath(file)}
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(input.operationId)||!/^\d+$/.test(input.selfId))fail('INVALID_ARGUMENTS')
  if(input.apply&&!input.stopped)fail('STOPPED_BACKEND_REQUIRED')
  const manifestFile=path.join(input.dataDir,`conversation-clean-${input.operationId}.json`), identity=digest([input.owner,input.selfId,path.resolve(input.dataDir),path.resolve(input.db)])
  let manifest:Manifest
  if(fs.existsSync(manifestFile)){manifest=read(manifestFile) as Manifest;if(manifest.identity!==identity)fail('OPERATION_CONFLICT')}
  else{const db=new Database(input.db,{readonly:true,fileMustExist:true});try{manifest=planQQCleanup(db,input.dataDir,input.db,input.owner,input.selfId,input.operationId)}finally{db.close()}}
  const report=()=>({operationId:manifest.operationId,mode:input.apply?'apply':'preview',phase:manifest.phase,completed:manifest.phase===manifest.stores.length+2,
    stores:manifest.stores.map(store=>({rows:store.rows.length})),memoryFiles:manifest.files.length,eventHashes:manifest.events.length})
  if(!input.apply||report().completed)return report()
  if(!fs.existsSync(manifestFile))atomicJson(manifestFile,manifest)
  for(let index=manifest.phase;index<manifest.stores.length;index++){
    const store=manifest.stores[index]!;safePath(store.file);const db=new Database(store.file,{fileMustExist:true})
    try{db.pragma('foreign_keys = ON');db.pragma('secure_delete = ON');db.transaction(()=>{
      db.pragma('defer_foreign_keys = ON')
      for(const item of store.rows){const cols=Object.keys(item.key),where=cols.map(col=>`${quote(col)} IS ?`).join(' AND '),values=Object.values(item.key)
        const old=db.prepare(`SELECT * FROM ${quote(item.table)} WHERE ${where}`).get(...values)
        if(!old)continue
        if(digest(old)!==item.hash)fail('SOURCE_CHANGED')
        db.prepare(`DELETE FROM ${quote(item.table)} WHERE ${where}`).run(...values)
      }
      if((db.pragma('foreign_key_check') as unknown[]).length)fail('CROSS_STORE_REFERENCE')
    })();db.pragma('wal_checkpoint(TRUNCATE)')}finally{db.close()}
    manifest.phase=index+1;atomicJson(manifestFile,manifest)
  }
  if(manifest.phase===manifest.stores.length){for(const item of manifest.files){safePath(item.file);if(!fs.existsSync(item.file))continue
    if(digest(fs.readFileSync(item.file,'utf8'))!==item.hash)fail('MEMORY_CHANGED');fs.unlinkSync(item.file)
  }manifest.phase++;atomicJson(manifestFile,manifest)}
  if(manifest.phase===manifest.stores.length+1){const file=path.join(input.dataDir,'state.json'),state=read(file)
    if(state.contextEpoch!==manifest.epoch){if(digest(state)!==manifest.stateHash)fail('STATE_CHANGED')
      Object.assign(state,{schemaVersion:3,contextEpoch:manifest.epoch,jobs:[],outbox:[],imageSources:{},observations:{},sourceScopes:{},sourceReceipts:{},discussions:{},windows:{},receipts:{},learning:{since:Date.now(),calls:[],positions:{},tasks:[],nextPollAt:0},clearedEvents:manifest.events})
      atomicJson(file,state)
    }manifest.phase++;atomicJson(manifestFile,manifest)
  }
  return report()
}

/** Writes a new output bundle; credentials and prompts are copied unchanged, never logged. */
export function convertQQConversationBundle(bundle:Row){
  const {config,changes}=convertQQConfiguration(bundle.config),converted=convertQQToolGroups(bundle.toolGroups??{})
  const roles=structuredClone(bundle.roles??{})
  const rank:Record<string,number>={allow:0,inherit:1,ask:2,deny:3}
  for(const role of Object.values(roles) as Row[]){if(!role.permissions?.tools)continue
    const rules:Record<string,string>={}
    for(const [name,effect]of Object.entries(role.permissions.tools) as Array<[string,string]>){if(name.includes('*')&&name.includes('qq_'))fail('QQ_PERMISSION_PATTERN_REQUIRES_REVIEW')
      for(const converted of convertQQToolGroups({policy:[name]}).groups.policy!){const old=rules[converted];if(!old||(rank[effect]??3)>(rank[old]??3))rules[converted]=effect}}
    role.permissions.tools=rules
  }
  return {bundle:{...bundle,config,toolGroups:converted.groups,roles},changes:[...changes,...converted.changes,'角色权限仅转换原有选择；不增加授权。自定义提示和图标须人工核对。']}
}
