/** Synthetic data only; each stage terminates this child without shutdown hooks. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AssetStore } from '../../src/service/media/assetStore.js'
import { SourcePublicationStore } from '../../src/service/media/sourcePublication.js'
import { QQImagePolicyDefault } from '../../../../packages/protocol/src/qq.js'

const [root, stage] = process.argv.slice(2)
if (!root || !['reserve', 'chunk', 'assetcopy', 'asset', 'source', 'ack'].includes(stage!)) throw new Error('Invalid crash fixture arguments')
const db = new Database(path.join(root, 'db'))
db.pragma('foreign_keys=ON')
const assets = new AssetStore(db, path.join(root, 'assets'))
const store = new SourcePublicationStore(db, path.join(root, 'staging'), assets)
const body = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217])
const sha256 = createHash('sha256').update(body).digest('hex')
const crash = () => {
  fs.writeFileSync(path.join(root, 'reached'), stage!)
  process.kill(process.pid, 'SIGKILL')
}
const context = { ownerId: 'owner', chatId: 'chat', sourceKey: 'source', sourceIdentity: 'identity',
  targetKey: 'group:1', limits: QQImagePolicyDefault, validate() {} }
const begun = store.begin(context, { size: body.length, sha256, mimeType: 'image/jpeg' })
if (stage === 'reserve') crash()
store.chunk(context, { uploadId: begun.uploadId!, offset: 0, dataBase64: body.toString('base64') })
if (stage === 'chunk') crash()

// Validation runs after the durable staging copy and before the asset INSERT.
if (stage === 'assetcopy') {
  const publish = assets.publishSource.bind(assets)
  assets.publishSource = (bytes, options) => publish(bytes, { ...options, validate() { options.validate(); crash() } })
}
// SQLite invokes these inside the same transaction as asset/grant/source writes.
db.function('fixture_crash', crash)
if (stage === 'asset') db.exec('CREATE TEMP TRIGGER fixture_stage AFTER INSERT ON asset_versions BEGIN SELECT fixture_crash(); END')
if (stage === 'source') db.exec("CREATE TEMP TRIGGER fixture_stage AFTER UPDATE OF state ON ingress_image_sources WHEN NEW.state='committed' BEGIN SELECT fixture_crash(); END")
await store.commit(context, { uploadId: begun.uploadId!, size: body.length, sha256 })
if (stage === 'ack') crash()
throw new Error('Crash stage was not reached')
