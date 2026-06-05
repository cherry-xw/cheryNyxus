import { getDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";

export interface SessionRow {
  id: string;
  agent_name: string;
  provider: string;
  model: string;
  tool_group: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionData {
  agentName: string;
  provider: string;
  model: string;
  toolGroup?: string | string[];
}

export function createSession(
  sessionId: string,
  data: SessionData,
): SessionRow {
  const db = getDb();
  const now = Date.now();

  const toolGroupStr = typeof data.toolGroup === "string"
    ? data.toolGroup
    : data.toolGroup
      ? JSON.stringify(data.toolGroup)
      : null;

  const stmt = db.prepare(`
    INSERT INTO agent_sessions (id, agent_name, provider, model, tool_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(sessionId, data.agentName, data.provider, data.model, toolGroupStr, now, now);

  return {
    id: sessionId,
    agent_name: data.agentName,
    provider: data.provider,
    model: data.model,
    tool_group: toolGroupStr,
    created_at: now,
    updated_at: now,
  };
}

export function getSession(sessionId: string): SessionRow | undefined {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
  return stmt.get(sessionId) as SessionRow | undefined;
}

export function listSessions(): SessionRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC");
  return stmt.all() as SessionRow[];
}

export function updateSession(sessionId: string): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?");
  stmt.run(Date.now(), sessionId);
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM agent_sessions WHERE id = ?");
  stmt.run(sessionId);
}

export function parseSessionRow(row: SessionRow): SessionData & { id: string; createdAt: number } {
  return {
    id: row.id,
    agentName: row.agent_name,
    provider: row.provider,
    model: row.model,
    toolGroup: row.tool_group
      ? safeJsonParse(row.tool_group, row.tool_group)
      : undefined,
    createdAt: row.created_at,
  };
}