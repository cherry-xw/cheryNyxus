import type Database from 'better-sqlite3'
import type { MessagePart, FileOperationRecord } from '@chery/protocol'

export function persistAssetReferences(db: Database.Database, chatId: string, kind: string, refId: string,
  parts: readonly MessagePart[], operations: readonly FileOperationRecord[] = []): void {
  const refs = [...parts, ...operations.flatMap((operation) => operation.outputParts ?? [])]
    .filter((part) => part.type === 'asset')
    .map((part) => ({ assetId: part.assetId, versionId: part.assetVersionId }))
  refs.push(...operations.flatMap((operation) => operation.inputAssets.map((asset) => ({ assetId: asset.assetId, versionId: asset.assetVersionId }))))
  if (!refs.length) return
  db.transaction(() => {
    for (const ref of refs) {
      const valid = db.prepare(`SELECT 1 FROM asset_versions v JOIN asset_chat_grants g ON g.asset_id = v.asset_id
        WHERE v.id = ? AND v.asset_id = ? AND g.chat_id = ?`).get(ref.versionId, ref.assetId, chatId)
      if (!valid) throw new Error('文件版本不存在或未授权给当前会话')
      db.prepare('INSERT OR IGNORE INTO asset_references (asset_version_id, chat_id, ref_kind, ref_id) VALUES (?, ?, ?, ?)')
        .run(ref.versionId, chatId, kind, refId)
      db.prepare('UPDATE assets SET was_referenced = 1 WHERE id = ?').run(ref.assetId)
    }
  })()
}

export function initAssetTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      unreferenced_at INTEGER NOT NULL,
      migration_unresolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS asset_versions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      variant TEXT NOT NULL CHECK (variant IN ('original', 'adapted')),
      parent_version_id TEXT REFERENCES asset_versions(id),
      sha256 TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      transform_json TEXT NOT NULL,
      transform_key TEXT NOT NULL,
      UNIQUE(asset_id, variant, transform_key)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_versions_sha ON asset_versions(sha256);
    CREATE TABLE IF NOT EXISTS asset_draft_references (
      asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
      draft_id TEXT NOT NULL, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(asset_version_id, draft_id, owner_id)
    );
    CREATE TABLE IF NOT EXISTS asset_chat_grants (
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      PRIMARY KEY(asset_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS asset_references (
      asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      PRIMARY KEY(asset_version_id, chat_id, ref_kind, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_references_ref ON asset_references(chat_id, ref_kind, ref_id);
    CREATE TABLE IF NOT EXISTS file_operations (
      operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      data_json TEXT NOT NULL, request_json TEXT NOT NULL,
      UNIQUE(owner_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_file_operations_chat ON file_operations(chat_id);
    CREATE TABLE IF NOT EXISTS asset_operation_references (
      asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES file_operations(operation_id) ON DELETE CASCADE,
      PRIMARY KEY(asset_version_id, operation_id)
    );
    CREATE TRIGGER IF NOT EXISTS asset_operation_reference_released
    AFTER DELETE ON asset_operation_references
    BEGIN
      UPDATE assets SET unreferenced_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE id = (SELECT asset_id FROM asset_versions WHERE id = OLD.asset_version_id);
    END;
    CREATE TRIGGER IF NOT EXISTS asset_reference_released
    AFTER DELETE ON asset_references
    BEGIN
      UPDATE assets SET unreferenced_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE id = (SELECT asset_id FROM asset_versions WHERE id = OLD.asset_version_id)
        AND NOT EXISTS (
          SELECT 1 FROM asset_references r JOIN asset_versions v ON v.id = r.asset_version_id
          WHERE v.asset_id = assets.id
        );
    END;
    CREATE TABLE IF NOT EXISTS file_migration_records (
      record_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      details_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  const columns = new Set((db.prepare('PRAGMA table_info(assets)').all() as { name: string }[]).map((row) => row.name))
  if (!columns.has('availability')) db.exec("ALTER TABLE assets ADD COLUMN availability TEXT NOT NULL DEFAULT 'available'")
  if (!columns.has('was_referenced')) db.exec('ALTER TABLE assets ADD COLUMN was_referenced INTEGER NOT NULL DEFAULT 0')
  if (!columns.has('retain_original')) db.exec('ALTER TABLE assets ADD COLUMN retain_original INTEGER NOT NULL DEFAULT 0')
}
