import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AssetRecord } from '@chery/protocol'
import { identifyFile } from './fileFormat.js'
import { AssetStore } from './assetStore.js'

export interface SourcePublicationContext {
  ownerId: string; chatId: string; sourceKey: string; sourceIdentity: string; targetKey: string
  limits: { singleBytes: number; totalBytes: number; perTargetBytes: number }
  validate(): void
}
interface SourceRow { source_key: string; identity_json: string; owner_id: string; chat_id: string; target_key: string;
  size: number; digest: string; mime: string; upload_id: string; received: number; state: string; asset_id: string | null; version_id: string | null }
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
/** Host-owned publication ledger. No plugin-selected paths or SQL cross this boundary. */
export class SourcePublicationStore {
  private committing = new Map<string, Promise<ReturnType<SourcePublicationStore['status']>>>()
  private activeCommits=0
  constructor(private db: Database.Database, private root: string, private assets: AssetStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS ingress_image_sources (
      source_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      target_key TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, mime TEXT NOT NULL,
      upload_id TEXT NOT NULL UNIQUE, received INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      asset_id TEXT, version_id TEXT);
      CREATE INDEX IF NOT EXISTS ingress_image_target ON ingress_image_sources(owner_id,target_key);`)
    const columns=db.prepare('PRAGMA table_info(ingress_image_sources)').all() as {name:string}[]
    if(!columns.some(c=>c.name==='permitted'))db.exec('ALTER TABLE ingress_image_sources ADD COLUMN permitted INTEGER NOT NULL DEFAULT 1')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(root).isSymbolicLink()) fail('STORAGE_UNAVAILABLE')
  }
  private filename(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) fail('UPLOAD_ABORTED')
    return path.join(this.root, id)
  }
  private manifest():string[] {
    const filename=path.join(this.root,'owned.json')
    let fd:number
    try{fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1048576)fail('STORAGE_UNAVAILABLE');const value=JSON.parse(fs.readFileSync(fd,'utf8'));if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!/^[0-9a-f-]{36}$/.test(v)))fail('STORAGE_UNAVAILABLE');return value}finally{fs.closeSync(fd)}
  }
  private own(id:string,add:boolean) {
    const ids=new Set(this.manifest());if(add)ids.add(id);else ids.delete(id)
    const filename=path.join(this.root,'owned.json'),temp=path.join(this.root,'owned.next')
    const fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600)
    try{fs.writeFileSync(fd,JSON.stringify([...ids]));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
    fs.renameSync(temp,filename)
    const directory=fs.openSync(this.root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(directory)}finally{fs.closeSync(directory)}
  }
  private row(c: SourcePublicationContext): SourceRow | undefined {
    c.validate()
    const row = this.db.prepare('SELECT * FROM ingress_image_sources WHERE source_key = ?').get(c.sourceKey) as SourceRow | undefined
    if (row && (row.owner_id !== c.ownerId || row.chat_id !== c.chatId || row.target_key !== c.targetKey || row.identity_json !== c.sourceIdentity)) fail('SOURCE_CONFLICT')
    if(row && (this.db.prepare('SELECT permitted FROM ingress_image_sources WHERE source_key=?').get(c.sourceKey) as {permitted:number}).permitted!==1)fail('IDENTITY_REJECTED')
    return row
  }
  reserve(c:SourcePublicationContext,size:number) {
    const row=this.row(c)
    if(row) {if(row.size!==size)fail('SOURCE_CONFLICT');if(row.state!=='aborted')return this.status(c)}
    return this.begin(c,{size,sha256:row?.digest??'',mimeType:row?.mime??''})
  }
  status(c: SourcePublicationContext) {
    const r = this.row(c)
    return r ? { state: r.state as 'uploading' | 'committed' | 'aborted', nextOffset: r.received, uploadId: r.upload_id,
      ...(r.asset_id && r.version_id ? { assetId: r.asset_id, assetVersionId: r.version_id } : {}) }
      : { state: 'registered' as const, nextOffset: 0 }
  }
  begin(c: SourcePublicationContext, input: { size: number; sha256: string; mimeType: string }) {
    const existing = this.row(c)
    if (existing) {
      if(existing.state==='uploading' && !existing.digest && input.sha256 && existing.size===input.size) {
        this.db.prepare('UPDATE ingress_image_sources SET digest=?,mime=? WHERE source_key=?').run(input.sha256,input.mimeType,c.sourceKey)
        return this.status(c)
      }
      if (existing.size !== input.size || existing.digest !== input.sha256 || existing.mime !== input.mimeType) fail('SOURCE_CONFLICT')
      if (existing.state !== 'aborted') return this.status(c)
    }
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > c.limits.singleBytes) fail('QUOTA_EXCEEDED')
    const uploadId = randomUUID(), filename = this.filename(uploadId)
    this.db.transaction(() => {
      c.validate()
      const usage = this.db.prepare("SELECT COALESCE(SUM(size),0) total, COALESCE(SUM(CASE WHEN target_key = ? THEN size ELSE 0 END),0) target FROM ingress_image_sources WHERE owner_id = ? AND state != 'aborted'").get(c.targetKey, c.ownerId) as { total: number; target: number }
      if (usage.total + input.size > c.limits.totalBytes || usage.target + input.size > c.limits.perTargetBytes) fail('QUOTA_EXCEEDED')
      const disk = fs.statfsSync(this.root)
      if (disk.bavail * disk.bsize < input.size * 2) fail('STORAGE_UNAVAILABLE')
      this.own(uploadId,true)
      const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      this.db.prepare(`INSERT INTO ingress_image_sources(source_key,identity_json,owner_id,chat_id,target_key,size,digest,mime,upload_id,received,state)
        VALUES (?,?,?,?,?,?,?,?,?,0,'uploading') ON CONFLICT(source_key) DO UPDATE SET upload_id=excluded.upload_id, received=0,state='uploading'`).run(c.sourceKey,c.sourceIdentity,c.ownerId,c.chatId,c.targetKey,input.size,input.sha256,input.mimeType,uploadId)
    }).immediate()
    return this.status(c)
  }
  chunk(c: SourcePublicationContext, input: { uploadId: string; offset: number; dataBase64: string }) {
    const row = this.row(c)
    if (!row || row.state !== 'uploading' || row.upload_id !== input.uploadId) fail('UPLOAD_ABORTED')
    const data = Buffer.from(input.dataBase64, 'base64')
    if (!data.length || data.length > 65536 || data.toString('base64') !== input.dataBase64) fail('FILE_INVALID')
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset + data.length > row.size) fail('OFFSET_MISMATCH')
    const fd = fs.openSync(this.filename(row.upload_id), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      if (!fs.fstatSync(fd).isFile()) fail('STORAGE_UNAVAILABLE')
      if (input.offset < row.received) {
        if (input.offset + data.length > row.received) fail('OFFSET_MISMATCH')
        const old = Buffer.alloc(data.length)
        if (fs.readSync(fd, old, 0, old.length, input.offset) !== old.length || !old.equals(data)) fail('OFFSET_MISMATCH')
        return { nextOffset: row.received }
      }
      if (input.offset !== row.received) fail('OFFSET_MISMATCH')
      c.validate()
      let written = 0
      while (written < data.length) { const n = fs.writeSync(fd, data, written, data.length - written, input.offset + written); if (!n) fail('STORAGE_UNAVAILABLE'); written += n }
      fs.fsyncSync(fd)
      c.validate()
      this.db.prepare('UPDATE ingress_image_sources SET received=? WHERE source_key=? AND received=?').run(input.offset + data.length,c.sourceKey,input.offset)
      return { nextOffset: input.offset + data.length }
    } finally { fs.closeSync(fd) }
  }
  async commit(c: SourcePublicationContext, input: { uploadId: string; size: number; sha256: string }): Promise<ReturnType<SourcePublicationStore['status']>> {
    this.row(c)
    const existing=this.committing.get(c.sourceKey)
    if(existing) { await existing; return this.commit(c,input) }
    if(this.activeCommits>=2)fail('STORAGE_UNAVAILABLE')
    this.activeCommits++
    const work=this.commitOne(c,input)
    this.committing.set(c.sourceKey,work)
    try{return await work}finally{this.activeCommits--;if(this.committing.get(c.sourceKey)===work)this.committing.delete(c.sourceKey)}
  }
  private async commitOne(c: SourcePublicationContext, input: { uploadId: string; size: number; sha256: string }): Promise<ReturnType<SourcePublicationStore['status']>> {
    const row = this.row(c)
    if (!row || row.upload_id !== input.uploadId || row.size !== input.size || row.digest !== input.sha256) fail('SOURCE_CONFLICT')
    if (row.state === 'committed') return this.status(c)
    if (row.state !== 'uploading' || row.received !== row.size) fail('OFFSET_MISMATCH')
    const fd = fs.openSync(this.filename(row.upload_id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let body: Buffer
    try {
      const before = fs.fstatSync(fd)
      if (!before.isFile() || before.size !== row.size || before.size > c.limits.singleBytes) fail('FILE_INVALID')
      body = Buffer.alloc(row.size)
      let offset=0
      while (offset<body.length) { const n=fs.readSync(fd,body,offset,body.length-offset,offset);if(!n)fail('FILE_INVALID');offset+=n }
      const after = fs.fstatSync(fd)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('FILE_INVALID')
    } finally { fs.closeSync(fd) }
    if (createHash('sha256').update(body).digest('hex') !== row.digest) fail('DIGEST_MISMATCH')
    const format = identifyFile(body, row.mime)
    if (format.kind !== 'image') fail('FILE_INVALID')
    c.validate()
    const asset = await this.assets.publishSource(body, { ownerId:c.ownerId, chatId:c.chatId, originalName:'QQ image', ...format,
      sourceKey:c.sourceKey, validate:() => { c.validate(); const current=this.row(c);if(current?.state!=='uploading' || current.upload_id!==row.upload_id)fail('UPLOAD_ABORTED') },
      published: (asset: AssetRecord) => { this.db.prepare("UPDATE ingress_image_sources SET state='committed',asset_id=?,version_id=? WHERE source_key=?").run(asset.id,asset.versionId,c.sourceKey) } })
    void asset
    this.remove(row.upload_id)
    return this.status(c)
  }
  cancel(c: SourcePublicationContext, uploadId: string) {
    const row=this.row(c)
    if (!row || row.upload_id!==uploadId) fail('UPLOAD_ABORTED')
    if(row.state==='committed') return {cancelled:false}
    this.db.prepare("UPDATE ingress_image_sources SET state='aborted' WHERE source_key=?").run(c.sourceKey)
    this.remove(row.upload_id)
    return {cancelled:true}
  }
  private remove(id:string) { const p=this.filename(id);try{const s=fs.lstatSync(p);if(s.isFile()&&!s.isSymbolicLink())fs.unlinkSync(p)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}this.own(id,false) }
  /** Only owned ledger entries; QQ caches and arbitrary directory files are never scanned. */
  recover() {
    this.assets.recoverPublications()
    const rows=this.db.prepare('SELECT * FROM ingress_image_sources').all() as SourceRow[]
    const active=new Set(rows.filter(r=>r.state==='uploading').map(r=>r.upload_id))
    for(const id of this.manifest())if(!active.has(id))this.remove(id)
    for(const r of rows) {
      if(r.state!=='uploading') {this.remove(r.upload_id);continue}
      if(/^[a-f0-9]{64}$/.test(r.digest))this.assets.discardUnpublishedBlob(r.digest)
      try {const fd=fs.openSync(this.filename(r.upload_id),fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size<r.received)throw Error();fs.ftruncateSync(fd,r.received);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
      catch {this.db.prepare("UPDATE ingress_image_sources SET state='aborted' WHERE source_key=?").run(r.source_key);this.remove(r.upload_id)}
    }
  }
}
