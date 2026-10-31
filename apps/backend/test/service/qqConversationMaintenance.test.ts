import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sourceFixture } from '../helpers/sourceContext.js'
import { initAssetTables } from '@/db/assets.js'
import { cleanupQQConversation,convertQQConversationBundle } from '@/service/ingress/qqConversationMaintenance.js'
import { emptyState,atomicJson } from '../../../../../plugins/qq/src/state.js'
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
})
