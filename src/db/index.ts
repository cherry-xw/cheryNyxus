import '@/utils/config' // 确保 dotenv 先加载
import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import config from '@/utils/config.js'

// 缓存管理
const dbCache = {
  soulDb: null as Database.Database | null,
  monthlyDbs: new Map<string, Database.Database>(),
}

/**
 * 获取 soul.db 实例（单例）
 * 包含 souls + chats 表
 */
export function getSoulDb(): Database.Database {
  if (!dbCache.soulDb) {
    const dbDir = config.global.db_dir
    const dbPath = join(dbDir, 'soul.db')

    // 确保目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    // 确保文件存在
    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, '')
    }

    dbCache.soulDb = new Database(dbPath)
    dbCache.soulDb.pragma('busy_timeout = 5000')
    dbCache.soulDb.pragma('foreign_keys = ON')
    dbCache.soulDb.pragma('journal_mode = WAL')
    initSoulTables(dbCache.soulDb)
  }
  return dbCache.soulDb
}

/**
 * 获取 YYYY-MM.db 实例（动态，缓存）
 * 包含 messages 表
 * 注：messages_month 在 createChat 时按 chat 创建月固定分片，跨月不迁移（见 db/chat.ts）
 */
export function getMonthlyDb(yearMonth: string): Database.Database {
  if (!dbCache.monthlyDbs.has(yearMonth)) {
    const dbDir = config.global.db_dir
    const dbPath = join(dbDir, `${yearMonth}.db`)

    // 确保目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    // 确保文件存在
    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, '')
    }

    const db = new Database(dbPath)
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_mode = WAL')
    initMonthlyTables(db)
    dbCache.monthlyDbs.set(yearMonth, db)
  }
  return dbCache.monthlyDbs.get(yearMonth)!
}

/**
 * 初始化 chats 表（soul.db）
 * 仅保留 chats 表，souls 表已废弃
 */
function initSoulTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      messages_month TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      parent_chat_id TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_tasks (
      task_id TEXT PRIMARY KEY,
      original_chat_id TEXT NOT NULL UNIQUE,
      active_branch_id TEXT,
      delivery_generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_branches (
      branch_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      chat_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      source_branch_id TEXT,
      anchor_root_chat_id TEXT,
      anchor_node_id TEXT,
      context_snapshot_json TEXT,
      runtime_snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(task_id) REFERENCES conversation_tasks(task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_branches_task
      ON conversation_branches(task_id, created_at);

    CREATE TABLE IF NOT EXISTS request_journal (
      request_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_journal_updated ON request_journal(updated_at);

    CREATE TABLE IF NOT EXISTS tree_control_operations (
      pause_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tree_control_root_updated
      ON tree_control_operations(root_chat_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS tree_control_targets (
      pause_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      paused_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resume_run_id TEXT,
      detail TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (pause_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tree_control_targets_status
      ON tree_control_targets(pause_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS pending_inputs (
      input_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      client_message_id TEXT,
      command_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      queue_sequence INTEGER NOT NULL,
      state TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pending_inputs_chat_state
      ON pending_inputs(chat_id, state, queue_sequence);

    /* Durable user-facing interaction inbox. Runtime approval promises are
       deliberately not authoritative: this row survives disconnects/restarts. */
    CREATE TABLE IF NOT EXISTS interactions (
      interaction_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      root_chat_id TEXT NOT NULL,
      preset_id TEXT,
      anchor_node_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      deadline_at INTEGER,
      result_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_interactions_status_updated
      ON interactions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interactions_preset_status
      ON interactions(preset_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS spawn_tasks (
      task_id TEXT PRIMARY KEY,
      child_chat_id TEXT NOT NULL UNIQUE,
      parent_chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      brain TEXT NOT NULL,
      sense_group TEXT NOT NULL,
      wait INTEGER NOT NULL DEFAULT 0,
      spawn_call_id TEXT,
      owning_batch_id TEXT,
      delivery_chat_id TEXT,
      delivery_branch_id TEXT,
      delivery_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_spawn_tasks_parent_status ON spawn_tasks(parent_chat_id, status);

    /* Cross-chat causality.  This deliberately lives in soul.db (rather than
       the month-sharded message DB) so a root timeline can join messages from
       chats created in different months without cross-database SQL. */
    CREATE TABLE IF NOT EXISTS message_links (
      message_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      source_chat_id TEXT NOT NULL,
      parent_chat_id TEXT,
      spawn_id TEXT,
      spawn_call_id TEXT,
      related_message_id TEXT,
      causation_node_id TEXT,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_links_root_time
      ON message_links(root_chat_id, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_message_links_spawn
      ON message_links(spawn_id, relation);

    /* Root subscriptions need one monotonic sequence across every descendant
       chat. Keep this journal in soul.db so a root tree can span monthly
       message shards without client-side event merging. */
    CREATE TABLE IF NOT EXISTS root_events (
      root_chat_id TEXT NOT NULL,
      root_seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (root_chat_id, root_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_root_events_retention
      ON root_events(root_chat_id, created_at);

    /* CP2 canonical execution graph facts. Payload JSON keeps the protocol
       extensible while indexed identity/order columns make snapshots auditable. */
    CREATE TABLE IF NOT EXISTS execution_graph_counters (
      root_chat_id TEXT PRIMARY KEY,
      next_order_key INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_nodes (
      node_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      source_chat_id TEXT NOT NULL,
      source_message_id TEXT,
      kind TEXT NOT NULL,
      order_key INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(root_chat_id, order_key)
    );

    CREATE INDEX IF NOT EXISTS idx_execution_nodes_root_order
      ON execution_nodes(root_chat_id, order_key);
    CREATE INDEX IF NOT EXISTS idx_execution_nodes_source_message
      ON execution_nodes(root_chat_id, source_message_id);

    CREATE TABLE IF NOT EXISTS execution_edges (
      edge_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      order_key INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(root_chat_id, order_key),
      UNIQUE(root_chat_id, from_node_id, to_node_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_execution_edges_root_order
      ON execution_edges(root_chat_id, order_key);

    CREATE TABLE IF NOT EXISTS tool_call_owners (
      call_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      owning_node_id TEXT,
      batch_id TEXT,
      call_index INTEGER,
      resolution TEXT NOT NULL,
      detail TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_call_owners_root
      ON tool_call_owners(root_chat_id, resolution, call_index);

    CREATE TABLE IF NOT EXISTS execution_active_runs (
      chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      root_chat_id TEXT NOT NULL,
      status TEXT NOT NULL,
      turn_id TEXT,
      node_id TEXT,
      batch_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_execution_active_runs_root_status
      ON execution_active_runs(root_chat_id, status, updated_at);

    /* Immutable semantic configuration revisions. Secret values are never
       stored in snapshot_json; callers persist only a redacted projection. */
    CREATE TABLE IF NOT EXISTS config_revisions (
      revision_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      validation_error TEXT,
      created_at INTEGER NOT NULL,
      activated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_config_revisions_status_created
      ON config_revisions(status, created_at DESC);

    /* A root conversation may have many immutable context epochs, but only
       one may be executable. Historical epochs remain available for audit. */
    CREATE TABLE IF NOT EXISTS chat_epochs (
      epoch_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      revision_id TEXT,
      status TEXT NOT NULL,
      snapshot_quality TEXT NOT NULL,
      transition_reason TEXT NOT NULL,
      handoff_summary TEXT,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      closed_at INTEGER,
      UNIQUE(root_chat_id, ordinal)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_epochs_one_active
      ON chat_epochs(root_chat_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_chat_epochs_root_ordinal
      ON chat_epochs(root_chat_id, ordinal DESC);

    /* Per-chat materialization inside an epoch. This is deliberately data,
       not executable code: prompt text and tool contracts are auditable while
       implementations continue to come from the validated deployment. */
    CREATE TABLE IF NOT EXISTS chat_epoch_snapshots (
      epoch_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      role_id TEXT,
      role_name TEXT,
      lifecycle TEXT NOT NULL,
      prompt_snapshot_json TEXT,
      runtime_snapshot_json TEXT,
      resource_manifest_json TEXT NOT NULL,
      invalidation_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(epoch_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_epoch_snapshots_chat
      ON chat_epoch_snapshots(chat_id, created_at DESC);
  `)
  // P1-8：旧库 chats 表无 message_count，CREATE IF NOT EXISTS 跳过建表，按列检查补 ALTER。
  ensureChatColumn(db, 'message_count', 'INTEGER NOT NULL DEFAULT 0')
  // V2 timeline monotonic revision. A revision is advanced whenever a
  // persisted message projection changes; old databases are upgraded lazily.
  ensureChatColumn(db, 'timeline_revision', 'INTEGER NOT NULL DEFAULT 0')
  // CP1 主从 Agent：旧库缺 parent_chat_id 列，按列检查补 ALTER（TEXT 缺省 NULL，无需回填）。
  ensureChatColumn(db, 'parent_chat_id', 'TEXT')
  ensureChatColumn(db, 'active_epoch_id', 'TEXT')
  ensureChatColumn(db, 'lifecycle', "TEXT NOT NULL DEFAULT 'active'")
  ensureTableColumn(db, 'spawn_tasks', 'spawn_call_id', 'TEXT')
  ensureTableColumn(db, 'spawn_tasks', 'owning_batch_id', 'TEXT')
  ensureTableColumn(db, 'spawn_tasks', 'delivery_chat_id', 'TEXT')
  ensureTableColumn(db, 'spawn_tasks', 'delivery_branch_id', 'TEXT')
  ensureTableColumn(db, 'spawn_tasks', 'delivery_generation', 'INTEGER NOT NULL DEFAULT 0')
  ensureTableColumn(db, 'spawn_tasks', 'epoch_id', 'TEXT')
  ensureTableColumn(db, 'spawn_tasks', 'role_id', 'TEXT')
  ensureTableColumn(db, 'conversation_tasks', 'active_branch_id', 'TEXT')
  ensureTableColumn(db, 'conversation_tasks', 'delivery_generation', 'INTEGER NOT NULL DEFAULT 0')
  db.exec(`UPDATE spawn_tasks SET delivery_chat_id = parent_chat_id WHERE delivery_chat_id IS NULL`)
  db.exec(`UPDATE conversation_tasks
    SET active_branch_id = (
      SELECT branch_id FROM conversation_branches
      WHERE conversation_branches.task_id = conversation_tasks.task_id
      ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, created_at, branch_id LIMIT 1
    )
    WHERE active_branch_id IS NULL`)
  ensureTableColumn(db, 'message_links', 'causation_node_id', 'TEXT')
  ensureTableColumn(db, 'pending_inputs', 'epoch_id', 'TEXT')
  ensureTableColumn(db, 'execution_active_runs', 'epoch_id', 'TEXT')
}

function ensureTableColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * chats 列存在性检查 + 缺失补列（P1-8 冗余计数列迁移）。
 * message_count 加列时一次性回填已有 chat 的消息数（按各自 messages_month 路由 COUNT）。
 */
function ensureChatColumn(db: Database.Database, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return

  db.exec(`ALTER TABLE chats ADD COLUMN ${column} ${definition}`)

  if (column === 'message_count') {
    const chats = db.prepare('SELECT id, messages_month FROM chats').all() as {
      id: string
      messages_month: string
    }[]
    for (const c of chats) {
      const monthlyDb = getMonthlyDb(c.messages_month)
      const row = monthlyDb
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
        .get(c.id) as { n: number }
      db.prepare('UPDATE chats SET message_count = ? WHERE id = ?').run(row.n, c.id)
    }
  }
}

/**
 * 初始化 messages 表（YYYY-MM.db）
 *
 * schema migration：旧 db 文件（revoked 列加入前创建）messages 表缺列，
 * CREATE TABLE IF NOT EXISTS 对已存在表跳过建表 → 列永久缺失。
 * 建表后按列检查补 ALTER TABLE ADD COLUMN，保证旧库自动升级。
 */
function initMonthlyTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      thinking_blocks TEXT,
      sense_calls TEXT,
      hash TEXT,
      replace_state INTEGER DEFAULT 0,
      replace_by TEXT,
      replace_content TEXT,
      original_content TEXT,
      revoked INTEGER DEFAULT 0,
      runtime TEXT,
      context_compaction INTEGER DEFAULT 0,
      context_compaction_tokens INTEGER,
      epoch_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

    CREATE TABLE IF NOT EXISTS chat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      chat_seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, chat_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_events_created ON chat_events(created_at);

    CREATE TABLE IF NOT EXISTS question_batches (
      batch_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(chat_id, assistant_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_question_batches_chat_status
      ON question_batches(chat_id, status, created_at);

    CREATE TABLE IF NOT EXISTS question_items (
      question_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      question TEXT NOT NULL,
      header TEXT,
      options_json TEXT NOT NULL,
      multi_select INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      answer_json TEXT,
      answer_text TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      UNIQUE(batch_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_question_items_batch_position
      ON question_items(batch_id, position);

    CREATE TABLE IF NOT EXISTS question_projection_meta (
      chat_id TEXT PRIMARY KEY,
      legacy_backfill_version INTEGER NOT NULL
    );
  `)

  ensureMessageColumn(db, 'thinking_blocks', 'TEXT')
  ensureMessageColumn(db, 'revoked', 'INTEGER DEFAULT 0')
  ensureMessageColumn(db, 'runtime', 'TEXT')
  ensureMessageColumn(db, 'context_compaction', 'INTEGER DEFAULT 0')
  ensureMessageColumn(db, 'context_compaction_tokens', 'INTEGER')
  ensureMessageColumn(db, 'epoch_id', 'TEXT')
  ensureChatEventColumn(db, 'chat_seq', 'INTEGER')
  // Development builds created before per-chat sequence migration used the
  // global row id as `seq`. Backfill deterministic per-chat cursors so those
  // databases can upgrade without a destructive table rebuild.
  db.exec(`
    WITH numbered AS (
      SELECT rowid AS event_id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY rowid) AS n
      FROM chat_events
      WHERE chat_seq IS NULL
    )
    UPDATE chat_events
    SET chat_seq = (SELECT n FROM numbered WHERE numbered.event_id = chat_events.rowid)
    WHERE rowid IN (SELECT event_id FROM numbered)
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_events_chat_seq_v2 ON chat_events(chat_id, chat_seq)',
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_events_chat_seq_unique ON chat_events(chat_id, chat_seq)',
  )
}

/**
 * 列存在性检查 + 缺失补列。
 * PRAGMA table_info 返回行无该列名时 ALTER TABLE ADD COLUMN。
 */
function ensureMessageColumn(db: Database.Database, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
  const exists = cols.some((c) => c.name === column)
  if (!exists) {
    db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`)
  }
}

/** chat_events 独立演进，不能复用 messages 的列检查。 */
function ensureChatEventColumn(db: Database.Database, column: string, definition: string): void {
  const cols = db.prepare('PRAGMA table_info(chat_events)').all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE chat_events ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * 关闭所有数据库实例
 */
export function closeAllDbs(): void {
  if (dbCache.soulDb) {
    dbCache.soulDb.close()
    dbCache.soulDb = null
  }
  for (const db of dbCache.monthlyDbs.values()) {
    db.close()
  }
  dbCache.monthlyDbs.clear()
}
