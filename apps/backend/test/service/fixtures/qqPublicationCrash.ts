import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AssetStore } from '../../../src/service/media/assetStore.js'
import { SourcePublicationStore } from '../../../src/service/media/sourcePublication.js'

// Disposable process only: triggers stop inside the publication transaction;
// reserve, chunk and acknowledgement stop after their respective commits.
const [root, stage] = process.argv.slice(2)
if (!root || !stage) throw new Error('CRASH_FIXTURE_ARGUMENTS_REQUIRED')
const db = new Database(path.join(root, 'db'), { fileMustExist: true })
db.pragma('journal_mode=WAL')
db.pragma('foreign_keys=ON')
const assets = new AssetStore(db, path.join(root, 'assets'))
const store = new SourcePublicationStore(db, path.join(root, 'staging'), assets)
const stop = (): never => {
  fs.writeFileSync(path.join(root, 'reached'), stage)
  process.kill(process.pid, 'SIGKILL')
  throw new Error('SIGKILL_FAILED')
}
db.function('stop_publication', stop)
if (stage === 'assetcopy') db.exec('CREATE TEMP TRIGGER crash_copy BEFORE INSERT ON asset_versions BEGIN SELECT stop_publication(); END')
if (stage === 'asset') db.exec('CREATE TEMP TRIGGER crash_asset AFTER INSERT ON asset_versions BEGIN SELECT stop_publication(); END')
if (stage === 'source') db.exec("CREATE TEMP TRIGGER crash_source AFTER UPDATE ON ingress_image_sources WHEN NEW.state='committed' BEGIN SELECT stop_publication(); END")
const body = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217])
const sha256 = createHash('sha256').update(body).digest('hex')
const context = { ownerId: 'owner', chatId: 'chat', sourceKey: 'source', sourceIdentity: 'identity', targetKey: 'group:1',
  limits: { singleBytes: 1024, totalBytes: 2048, perTargetBytes: 1024 }, validate() {} }
const upload = store.reserve(context, body.length)
if (stage === 'reserve') stop()
store.begin(context, { size: body.length, sha256, mimeType: 'image/jpeg' })
store.chunk(context, { uploadId: upload.uploadId!, offset: 0, dataBase64: body.toString('base64') })
if (stage === 'chunk') stop()
await store.commit(context, { uploadId: upload.uploadId!, size: body.length, sha256 })
if (stage === 'ack') stop()
throw new Error('UNKNOWN_CRASH_STAGE')
