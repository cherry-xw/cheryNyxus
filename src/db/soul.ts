import { getDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";

export interface SoulRow {
  id: string;
  agent_name: string;
  provider: string;
  model: string;
  sense_group: string | null;
  created_at: number;
  updated_at: number;
}

export interface SoulData {
  agentName: string;
  provider: string;
  model: string;
  senseGroup?: string | string[];
}

export function createSoul(
  soulId: string,
  data: SoulData,
): SoulRow {
  const db = getDb();
  const now = Date.now();

  const senseGroupStr = typeof data.senseGroup === "string"
    ? data.senseGroup
    : data.senseGroup
      ? JSON.stringify(data.senseGroup)
      : null;

  const stmt = db.prepare(`
    INSERT INTO souls (id, agent_name, provider, model, sense_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(soulId, data.agentName, data.provider, data.model, senseGroupStr, now, now);

  return {
    id: soulId,
    agent_name: data.agentName,
    provider: data.provider,
    model: data.model,
    sense_group: senseGroupStr,
    created_at: now,
    updated_at: now,
  };
}

export function getSoul(soulId: string): SoulRow | undefined {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM souls WHERE id = ?");
  return stmt.get(soulId) as SoulRow | undefined;
}

export function listSouls(): SoulRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM souls ORDER BY updated_at DESC");
  return stmt.all() as SoulRow[];
}

export function updateSoul(soulId: string): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE souls SET updated_at = ? WHERE id = ?");
  stmt.run(Date.now(), soulId);
}

export function deleteSoul(soulId: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM souls WHERE id = ?");
  stmt.run(soulId);
}

export function parseSoulRow(row: SoulRow): SoulData & { id: string; createdAt: number } {
  return {
    id: row.id,
    agentName: row.agent_name,
    provider: row.provider,
    model: row.model,
    senseGroup: row.sense_group
      ? safeJsonParse(row.sense_group, row.sense_group)
      : undefined,
    createdAt: row.created_at,
  };
}