import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { runSourceMigrationCommand } from '@/service/ingress/sourceMigrationCommand.js'
import { emptyState } from '../../../../plugins/qq/src/state.js'

const roots: string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
function fixture() {
  const root=fs.mkdtempSync('/tmp/opencode/qq-migration-cli-');roots.push(root)
  const dataDir=path.join(root,'qq'),dbDir=path.join(root,'db'),assetsDir=path.join(root,'assets'),backupDir=path.join(root,'backups')
  for(const dir of [dataDir,dbDir,assetsDir,backupDir])fs.mkdirSync(dir)
  const database=path.join(dbDir,'soul.db'),db=new Database(database)
  db.exec('CREATE TABLE preserved(value TEXT);INSERT INTO preserved VALUES (\'keep\')');db.close()
  const stateFile=path.join(dataDir,'state.json')
  fs.writeFileSync(stateFile,JSON.stringify({...emptyState(),schemaVersion:1}))
  const original=fs.readFileSync(database),args=['--db',database,'--data-dir',dataDir]
  const files=[database,stateFile].map((file,index)=>{
    const body=fs.readFileSync(file),backupPath=path.join(backupDir,`original-${index}`)
    fs.writeFileSync(backupPath,body)
    return {originalPath:file,backupPath,sha256:createHash('sha256').update(body).digest('hex')}
  })
  const manifest=path.join(root,'recovery.json');fs.writeFileSync(manifest,JSON.stringify({files}))
  const apply=[...args,'--mode','apply','--stopped','--recovery-manifest',manifest,'--assets-dir',assetsDir,'--backup-dir',path.join(root,'migration-backups')]
  return {root,args,apply,database,stateFile,original,manifest}
}
it('previews a read-only database without changing bytes or initializing live tables',()=>{
  const f=fixture()
  expect(runSourceMigrationCommand(f.args).mode).toBe('dry-run')
  expect(fs.readFileSync(f.database)).toEqual(f.original)
  expect(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).schemaVersion).toBe(1)
})
it('requires stopped business and a complete verified recovery backup before applying',()=>{
  const f=fixture()
  expect(()=>runSourceMigrationCommand(f.apply.filter(arg=>arg!=='--stopped'))).toThrow('STOPPED_BACKEND_REQUIRED')
  const manifest=JSON.parse(fs.readFileSync(f.manifest,'utf8'));manifest.files.pop()
  fs.writeFileSync(f.manifest,JSON.stringify(manifest))
  expect(()=>runSourceMigrationCommand(f.apply)).toThrow('RECOVERY_BACKUP_INCOMPLETE')
  expect(fs.readFileSync(f.database)).toEqual(f.original)
})
it('converts only explicit offline inputs while retaining unrelated database facts',()=>{
  const f=fixture(),report=runSourceMigrationCommand(f.apply)
  expect(report.conflicts).toEqual([]);expect(report.publicationState).toBe('completed')
  expect(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).schemaVersion).toBe(2)
  const db=new Database(f.database,{readonly:true})
  try{expect(db.prepare('SELECT value FROM preserved').get()).toEqual({value:'keep'})}finally{db.close()}
})
