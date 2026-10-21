import { createHash, randomUUID } from 'node:crypto'
import { linkSync, existsSync, unlinkSync, lstatSync, readFileSync, constants } from 'node:fs'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AssetKind, AssetRecord, AssetSource, MessagePart } from '@chery/protocol'
import { imageDimensions } from './imageDimensions.js'

export interface AssetAccess {
  ownerId: string
  /** 子任务和会话读取必须提供，由已验证的请求上下文确定，不接受文件自己的声明。 */
  chatId?: string
}

interface VersionRow {
  id: string
  asset_id: string
  variant: 'original' | 'adapted'
  parent_version_id: string | null
  sha256: string
  mime_type: string
  kind: AssetKind
  size_bytes: number
  created_at: number
  transform_json: string
  original_name: string
  owner_id: string
  source: AssetSource
  availability: 'available' | 'missing' | 'unclaimed'
}

function unavailable(): never {
  throw Object.assign(new Error('文件不存在或无权访问'), { code: 'ASSET_UNAVAILABLE' })
}

/** 单个后端主库的文件仓库。公开结果不含内部路径或存储键。 */
export class AssetStore {
  constructor(private readonly db: Database.Database, private readonly root: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS asset_staging_publications (
      file_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, process_start TEXT NOT NULL, digest TEXT NOT NULL)`)
  }

  private processStart(pid:number):string {
    try{return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').pop()!.split(' ')[19]!}catch{return ''}
  }
  /** Only journal-owned dead-process copies; live writers and unrelated staging are untouched. */
  recoverPublications():void {
    const rows=this.db.prepare('SELECT * FROM asset_staging_publications').all() as {file_id:string;pid:number;process_start:string;digest:string}[]
    for(const row of rows) {
      const start=this.processStart(row.pid)
      if(start===row.process_start && start)continue
      if(!start || !row.process_start){try{process.kill(row.pid,0);continue}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')continue}}
      if(!/^[0-9a-f-]{36}$/.test(row.file_id)||!/^[a-f0-9]{64}$/.test(row.digest))throw Error('Invalid publication journal')
      const dir=join(this.root,'staging')
      if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())throw Error('Invalid staging directory')
      const filename=join(dir,row.file_id)
      try{const stat=lstatSync(filename);if(stat.isFile()&&!stat.isSymbolicLink())unlinkSync(filename)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      this.discardUnpublishedBlob(row.digest)
      this.db.prepare('DELETE FROM asset_staging_publications WHERE file_id=?').run(row.file_id)
    }
  }

  private blobPath(sha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('文件摘要无效')
    return join(this.root, 'blobs', sha256)
  }
  /** Startup source recovery may discard only an exact known unpublished digest. */
  discardUnpublishedBlob(sha256:string):void {
    this.db.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM asset_versions WHERE sha256=?').get(sha256))return
      const filename=this.blobPath(sha256)
      try{const stat=lstatSync(filename);if(stat.isFile()&&!stat.isSymbolicLink())unlinkSync(filename)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    }).immediate()
  }

  private row(assetId: string, versionId?: string): VersionRow | undefined {
    return this.db.prepare(`SELECT v.*, a.original_name, a.owner_id, a.source, a.availability
      FROM asset_versions v JOIN assets a ON a.id = v.asset_id
      WHERE a.id = ? AND ${versionId ? 'v.id = ?' : "v.variant = 'original'"}`)
      .get(...(versionId ? [assetId, versionId] : [assetId])) as VersionRow | undefined
  }

  private authorize(row: VersionRow | undefined, access: AssetAccess): VersionRow {
    if (!row || !access.ownerId || row.owner_id !== access.ownerId) unavailable()
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingress_image_sources'").get() &&
      this.db.prepare('SELECT 1 FROM ingress_image_sources WHERE asset_id=? AND permitted=0').get(row.asset_id)) unavailable()
    if (access.chatId && !this.db.prepare('SELECT 1 FROM asset_chat_grants WHERE asset_id = ? AND chat_id = ?')
      .get(row.asset_id, access.chatId)) unavailable()
    return row
  }

  private record(row: VersionRow, chatId?: string): AssetRecord {
    return {
      id: row.asset_id, versionId: row.id, originalName: row.original_name,
      mimeType: row.mime_type, kind: row.kind, sizeBytes: row.size_bytes,
      sha256: row.sha256, createdAt: row.created_at, source: row.source,
      ownerId: row.owner_id, ...(chatId ? { chatId } : {}),
      availability: row.availability,
      transform: JSON.parse(row.transform_json),
    }
  }

  get(assetId: string, access: AssetAccess, versionId?: string): AssetRecord {
    return this.record(this.authorize(this.row(assetId, versionId), access), access.chatId)
  }

  async read(assetId: string, access: AssetAccess, versionId?: string) {
    const row = this.authorize(this.row(assetId, versionId), access)
    if (row.availability !== 'available') unavailable()
    const data = await readFile(this.blobPath(row.sha256)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') unavailable()
      throw error
    })
    return { asset: this.record(row, access.chatId), data }
  }

  async readChunk(assetId: string, access: AssetAccess, versionId: string, offset: number) {
    const row = this.authorize(this.row(assetId, versionId), access)
    if (row.availability !== 'available') unavailable()
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.size_bytes) throw new Error('文件读取位置无效')
    const file = await open(this.blobPath(row.sha256), 'r')
    try {
      const size = Math.min(256 * 1024, row.size_bytes - offset)
      const data = Buffer.alloc(size)
      let total = 0
      while (total < size) {
        const { bytesRead } = await file.read(data, total, size - total, offset + total)
        if (!bytesRead) unavailable()
        total += bytesRead
      }
      this.authorize(this.row(assetId, versionId), access)
      return { asset: this.record(row, access.chatId), offset, dataBase64: data.toString('base64'), eof: offset + size === row.size_bytes }
    } finally { await file.close() }
  }

  async save(body: Buffer, options: {
    ownerId: string; originalName: string; mimeType: string; kind: AssetKind
    source: AssetSource; maxBytes?: number; migrationUnresolved?: boolean
  }): Promise<AssetRecord> {
    if (!options.ownerId) throw new Error('保存文件需要明确身份')
    if (!body.length || body.length > (options.maxBytes ?? 100 * 1024 * 1024))
      throw new Error('文件为空或超过上传大小限制')
    const id = randomUUID()
    return this.writeVersion(body, {
      assetId: id, variant: 'original', mimeType: options.mimeType,
      kind: options.kind, transform: { variant: 'original', ...(options.kind === 'image' ? imageDimensions(body) : {}) }, transformKey: 'original',
    }, () => {
      this.db.prepare(`INSERT INTO assets
        (id, owner_id, original_name, source, created_at, unreferenced_at, migration_unresolved)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, options.ownerId,
          options.originalName.replace(/[\x00-\x1f\x7f]/g, '').replace(/\\/g, '/').split('/').pop() || 'file',
          options.source, Date.now(), Date.now(), options.migrationUnresolved ? 1 : 0)
    })
  }

  /** 派生版本只增加记录，不修改原版。相同参数重试返回固定版本。 */
  async saveAdapted(body: Buffer, original: AssetRecord, access: AssetAccess,
    transform: NonNullable<AssetRecord['transform']>, mimeType: string): Promise<AssetRecord> {
    const parent = this.authorize(this.row(original.id, original.versionId), access)
    if (!body.length) throw new Error('不能保存空的适配版本')
    if (parent.variant !== 'original') throw new Error('适配版本必须从原版产生')
    const transformKey = JSON.stringify([transform.maxEdge, transform.quality, mimeType, createHash('sha256').update(body).digest('hex')])
    const existing = this.db.prepare("SELECT id FROM asset_versions WHERE asset_id = ? AND variant = 'adapted' AND transform_key = ?")
      .get(original.id, transformKey) as { id: string } | undefined
    if (existing) return this.get(original.id, access, existing.id)
    return this.writeVersion(body, {
      assetId: original.id, variant: 'adapted', parentVersionId: parent.id,
      mimeType, kind: parent.kind, transform: { ...transform, variant: 'adapted' }, transformKey,
    }, () => { this.authorize(this.row(original.id, parent.id), access) })
  }

  /** Asset, grant, reference and host source mapping share the same SQLite transaction. */
  async publishSource(body: Buffer, options: { ownerId: string; chatId: string; originalName: string; mimeType: string; kind: AssetKind;
    sourceKey: string; validate(): void; published(asset: AssetRecord): void }): Promise<AssetRecord> {
    const id = randomUUID()
    return this.writeVersion(body, { assetId: id, variant: 'original', mimeType: options.mimeType, kind: options.kind,
      transform: { variant: 'original', ...imageDimensions(body) }, transformKey: 'original' }, () => {
      options.validate()
      this.db.prepare(`INSERT INTO assets(id,owner_id,original_name,source,created_at,unreferenced_at,migration_unresolved)
        VALUES (?,?,?,'upload',?,?,0)`).run(id,options.ownerId,options.originalName,Date.now(),Date.now())
      this.db.prepare('UPDATE assets SET retain_original=1 WHERE id=?').run(id)
    }, asset => {
      const part = { type: 'asset' as const, partId: options.sourceKey, assetId: asset.id, assetVersionId: asset.versionId, variant: 'original' as const, usage: 'content' as const }
      this.attachOwned([part], {ownerId:options.ownerId,chatId:options.chatId}, 'branch', options.sourceKey)
      options.published(asset)
    })
  }

  private async writeVersion(body: Buffer, version: {
    assetId: string; variant: 'original' | 'adapted'; parentVersionId?: string
    mimeType: string; kind: AssetKind; transform: AssetRecord['transform']; transformKey: string
  }, beforeInsert: () => void, afterInsert?: (asset: AssetRecord) => void): Promise<AssetRecord> {
    const sha256 = createHash('sha256').update(body).digest('hex')
    const tempDir = join(this.root, 'staging')
    await mkdir(tempDir, { recursive: true })
    await mkdir(join(this.root, 'blobs'), { recursive: true })
    if(lstatSync(tempDir).isSymbolicLink())throw Error('Invalid staging directory')
    const fileId=randomUUID(),temp = join(tempDir, fileId)
    // Persist ownership before creating bytes, independently of the publication transaction.
    this.db.prepare('INSERT INTO asset_staging_publications(file_id,pid,process_start,digest) VALUES (?,?,?,?)')
      .run(fileId,process.pid,this.processStart(process.pid),sha256)
    const versionId = randomUUID()
    try {
      const file = await open(temp, constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW, 0o600)
      try {
        await file.writeFile(body)
        await file.sync()
      } finally { await file.close() }
      return this.db.transaction(() => {
        // 主库写锁覆盖发布和登记，清理不能在二者之间删除共享二进制文件。
        beforeInsert()
        const existing = this.db.prepare('SELECT id FROM asset_versions WHERE asset_id = ? AND variant = ? AND transform_key = ?')
          .get(version.assetId, version.variant, version.transformKey) as { id: string } | undefined
        if (existing) return this.record(this.row(version.assetId, existing.id)!)
        try { linkSync(temp, this.blobPath(sha256)) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        this.db.prepare(`INSERT INTO asset_versions
          (id, asset_id, variant, parent_version_id, sha256, mime_type, kind, size_bytes, created_at, transform_json, transform_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(versionId, version.assetId,
            version.variant, version.parentVersionId ?? null, sha256, version.mimeType,
            version.kind, body.length, Date.now(), JSON.stringify(version.transform), version.transformKey)
        const asset = this.record(this.row(version.assetId, versionId)!)
        afterInsert?.(asset)
        return asset
      }).immediate()
    } finally {
      await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error})
      this.discardUnpublishedBlob(sha256)
      this.db.prepare('DELETE FROM asset_staging_publications WHERE file_id=?').run(fileId)
    }
  }

  /** 仅用于已鉴权的用户提交，不用于子任务。会话权限必须由请求处理器预先验证。 */
  attachOwned(parts: readonly MessagePart[], access: AssetAccess, kind: 'message' | 'pending' | 'operation' | 'branch', refId: string): void {
    this.db.transaction(() => {
      for (const part of parts) {
        if (part.type !== 'asset') continue
        this.authorize(this.row(part.assetId, part.assetVersionId), { ownerId: access.ownerId })
        this.db.prepare('INSERT OR IGNORE INTO asset_chat_grants (asset_id, chat_id) VALUES (?, ?)').run(part.assetId, access.chatId ?? unavailable())
      }
      this.reference(parts, access, kind, refId)
    })()
  }

  /** 子任务只能接收源会话已获授权的明确文件；父子关系由调用方验证。 */
  grantToChat(parts: readonly MessagePart[], source: AssetAccess, targetChatId: string): void {
    if (!source.chatId) unavailable()
    this.db.transaction(() => {
      for (const part of parts) {
        if (part.type !== 'asset') continue
        this.authorize(this.row(part.assetId, part.assetVersionId), source)
        this.db.prepare('INSERT OR IGNORE INTO asset_chat_grants (asset_id, chat_id) VALUES (?, ?)').run(part.assetId, targetChatId)
      }
    })()
  }

  /** 仅登记已获授权的固定版本，不因调用者知道 ID 就新增会话访问权限。 */
  reference(parts: readonly MessagePart[], access: AssetAccess, kind: 'message' | 'pending' | 'operation' | 'branch', refId: string): void {
    if (!access.chatId || !this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(access.chatId)) unavailable()
    this.db.transaction(() => {
      for (const part of parts) {
        if (part.type !== 'asset') continue
        const row = this.authorize(this.row(part.assetId, part.assetVersionId), access)
        if (row.variant !== part.variant) throw new Error('文件版本与 variant 不一致')
        this.db.prepare(`INSERT OR IGNORE INTO asset_references
          (asset_version_id, chat_id, ref_kind, ref_id) VALUES (?, ?, ?, ?)`).run(row.id, access.chatId, kind, refId)
        this.db.prepare('UPDATE assets SET was_referenced = 1 WHERE id = ?').run(part.assetId)
      }
    })()
  }

  release(chatId: string, kind: string, refId: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE assets SET unreferenced_at = ? WHERE id IN (
        SELECT v.asset_id FROM asset_references r JOIN asset_versions v ON v.id = r.asset_version_id
        WHERE r.chat_id = ? AND r.ref_kind = ? AND r.ref_id = ?)`).run(now, chatId, kind, refId)
      this.db.prepare('DELETE FROM asset_references WHERE chat_id = ? AND ref_kind = ? AND ref_id = ?').run(chatId, kind, refId)
    })()
  }

  referenceOperation(refs: readonly { assetId: string; assetVersionId: string }[], access: AssetAccess, operationId: string): void {
    this.db.transaction(() => {
      for (const ref of refs) {
        const row = this.authorize(this.row(ref.assetId, ref.assetVersionId), access)
        this.db.prepare('INSERT OR IGNORE INTO asset_operation_references (asset_version_id, operation_id) VALUES (?, ?)').run(row.id, operationId)
        this.db.prepare('UPDATE assets SET was_referenced = 1 WHERE id = ?').run(row.asset_id)
      }
    })()
  }

  retainDraft(refs: readonly { assetId: string; assetVersionId: string }[], ownerId: string, draftId: string, now = Date.now()): void {
    this.db.transaction(() => {
      const rows = refs.map(ref => this.authorize(this.row(ref.assetId, ref.assetVersionId), { ownerId })).filter((row, index, all) => all.findIndex(item => item.id === row.id) === index)
      this.db.prepare(`UPDATE assets SET unreferenced_at = ? WHERE id IN (SELECT v.asset_id FROM asset_draft_references r JOIN asset_versions v ON r.asset_version_id = v.id WHERE r.owner_id = ? AND r.draft_id = ?)`).run(now, ownerId, draftId)
      this.db.prepare('DELETE FROM asset_draft_references WHERE owner_id = ? AND draft_id = ?').run(ownerId, draftId)
      for (const row of rows) this.db.prepare('INSERT INTO asset_draft_references (asset_version_id,draft_id,owner_id,expires_at) VALUES (?,?,?,?)').run(row.id, draftId, ownerId, now + 5 * 60_000)
    })()
  }

  cleanup(now = Date.now(), retentionHours = 24, uploadRetentionHours = retentionHours): number {
    if (!Number.isFinite(retentionHours) || retentionHours <= 0) throw new Error('保留时长必须为正数')
    if (!Number.isFinite(uploadRetentionHours) || uploadRetentionHours <= 0) throw new Error('上传保留时长必须为正数')
    const { count, hashes } = this.db.transaction(() => {
      this.db.prepare('UPDATE assets SET unreferenced_at = ? WHERE id IN (SELECT v.asset_id FROM asset_draft_references r JOIN asset_versions v ON v.id = r.asset_version_id WHERE r.expires_at <= ?)').run(now, now)
      this.db.prepare('DELETE FROM asset_draft_references WHERE expires_at <= ?').run(now)
      const expired = this.db.prepare(`SELECT id FROM assets a WHERE migration_unresolved = 0 AND retain_original = 0
        AND unreferenced_at <= CASE WHEN was_referenced = 0 AND source = 'upload' THEN ? ELSE ? END AND NOT EXISTS (
          SELECT 1 FROM asset_references r JOIN asset_versions v ON v.id = r.asset_version_id WHERE v.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM asset_operation_references r JOIN asset_versions v ON v.id = r.asset_version_id WHERE v.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM asset_draft_references r JOIN asset_versions v ON v.id = r.asset_version_id WHERE v.asset_id = a.id)`)
        .all(now - uploadRetentionHours * 3_600_000, now - retentionHours * 3_600_000) as { id: string }[]
      const hashes = new Set<string>()
      for (const { id } of expired) {
        const blobs = this.db.prepare('SELECT sha256 FROM asset_versions WHERE asset_id = ?').all(id) as { sha256: string }[]
        // 删除子版本后删除父版本，避免父版本外键阻止回收。
        this.db.prepare('DELETE FROM asset_versions WHERE asset_id = ? AND parent_version_id IS NOT NULL').run(id)
        this.db.prepare('DELETE FROM assets WHERE id = ?').run(id)
        for (const { sha256 } of blobs) hashes.add(sha256)
      }
      return { count: expired.length, hashes }
    }).immediate()
    // 元信息先提交。即使清理中断，也只留下无引用文件，不会留下指向已删除文件的版本。
    this.db.transaction(() => {
      for (const sha256 of hashes) {
        if (!this.db.prepare('SELECT 1 FROM asset_versions WHERE sha256 = ?').get(sha256)) {
          const path = this.blobPath(sha256)
          if (existsSync(path)) unlinkSync(path)
        }
      }
    }).immediate()
    return count
  }
}
