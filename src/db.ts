import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Agent = {
  pane_id: string;
  name: string;
  role: string;
  project: string;
  context_mode: "keep" | "clear";
  registered_at: number;
  last_status: string | null;
};

export type Message = {
  id: number;
  from_agent: string;
  to_agent: string;
  task_id: number | null;
  body: string;
  created_at: number;
  read_at: number | null;
};

export type TaskStatus = "open" | "claimed" | "done" | "failed" | "blocked" | "cancelled";

export type Task = {
  id: number;
  parent_id: number | null;
  project: string;
  created_by: string;
  target_role: string | null;
  target_agent: string | null;
  assignee: string | null;
  title: string;
  brief: string;
  status: TaskStatus;
  result: string | null;
  block_reason: string | null;
  hop_count: number;
  nudge_count: number;
  created_at: number;
  updated_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  pane_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  project TEXT NOT NULL,
  context_mode TEXT NOT NULL DEFAULT 'keep',
  registered_at INTEGER NOT NULL,
  last_status TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES tasks(id),
  project TEXT NOT NULL,
  created_by TEXT NOT NULL,
  target_role TEXT,
  target_agent TEXT,
  assignee TEXT,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT,
  block_reason TEXT,
  hop_count INTEGER NOT NULL DEFAULT 0,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS knocks (
  id INTEGER PRIMARY KEY,
  pane_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(to_agent, read_at);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
`;

export class Store {
  db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
  }

  // agents
  agentByPane(pane: string): Agent | null {
    return this.db.query("SELECT * FROM agents WHERE pane_id = ?").get(pane) as Agent | null;
  }
  agentByName(name: string): Agent | null {
    return this.db.query("SELECT * FROM agents WHERE name = ?").get(name) as Agent | null;
  }
  agents(filter: { project?: string; role?: string } = {}): Agent[] {
    return this.db
      .query("SELECT * FROM agents WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR role = ?2) ORDER BY name")
      .all(filter.project ?? null, filter.role ?? null) as Agent[];
  }
  upsertAgent(a: Pick<Agent, "pane_id" | "name" | "role" | "project" | "context_mode">): Agent {
    this.db
      .query(
        `INSERT INTO agents (pane_id, name, role, project, context_mode, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET name = excluded.name, role = excluded.role,
           project = excluded.project, context_mode = excluded.context_mode`,
      )
      .run(a.pane_id, a.name, a.role, a.project, a.context_mode, Date.now());
    return this.agentByPane(a.pane_id)!;
  }
  deleteAgent(pane: string) {
    this.db.query("DELETE FROM agents WHERE pane_id = ?").run(pane);
  }
  setLastStatus(pane: string, status: string) {
    this.db.query("UPDATE agents SET last_status = ? WHERE pane_id = ?").run(status, pane);
  }

  // messages
  addMessage(from: string, to: string, body: string, taskId: number | null, read = false): number {
    const now = Date.now();
    return Number(
      this.db
        .query("INSERT INTO messages (from_agent, to_agent, task_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(from, to, taskId, body, now, read ? now : null).lastInsertRowid,
    );
  }
  unread(name: string, limit = 1000): Message[] {
    return this.db
      .query("SELECT * FROM messages WHERE to_agent = ? AND read_at IS NULL ORDER BY id LIMIT ?")
      .all(name, limit) as Message[];
  }
  unreadCount(name: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND read_at IS NULL").get(name) as any).n;
  }
  markRead(ids: number[]) {
    const stmt = this.db.query("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL");
    const now = Date.now();
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }
  sentSince(name: string, since: number): number {
    return (
      this.db.query("SELECT COUNT(*) AS n FROM messages WHERE from_agent = ? AND created_at >= ?").get(name, since) as any
    ).n;
  }

  // tasks
  addTask(t: {
    parent_id: number | null;
    project: string;
    created_by: string;
    target_role: string | null;
    target_agent: string | null;
    title: string;
    brief: string;
    hop_count: number;
  }): Task {
    const now = Date.now();
    const id = Number(
      this.db
        .query(
          `INSERT INTO tasks (parent_id, project, created_by, target_role, target_agent, title, brief, hop_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(t.parent_id, t.project, t.created_by, t.target_role, t.target_agent, t.title, t.brief, t.hop_count, now, now)
        .lastInsertRowid,
    );
    return this.task(id)!;
  }
  task(id: number): Task | null {
    return this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
  }
  /** The oldest task this agent has claimed and not finished. */
  currentTask(name: string): Task | null {
    return this.db
      .query("SELECT * FROM tasks WHERE assignee = ? AND status = 'claimed' ORDER BY id LIMIT 1")
      .get(name) as Task | null;
  }
  claimedTasks(name: string): Task[] {
    return this.db.query("SELECT * FROM tasks WHERE assignee = ? AND status = 'claimed' ORDER BY id").all(name) as Task[];
  }
  openTasksFor(a: Agent): Task[] {
    return this.db
      .query(
        `SELECT * FROM tasks WHERE status = 'open'
           AND (target_agent = ?1 OR (target_role = ?2 AND project = ?3)) ORDER BY id`,
      )
      .all(a.name, a.role, a.project) as Task[];
  }
  /** Atomic claim: only one caller can move a task from open to claimed. */
  claim(id: number, assignee: string): boolean {
    const r = this.db
      .query(
        "UPDATE tasks SET status = 'claimed', assignee = ?, nudge_count = 0, updated_at = ? WHERE id = ? AND status = 'open'",
      )
      .run(assignee, Date.now(), id);
    return r.changes === 1;
  }
  finishTask(id: number, status: TaskStatus, result: string | null, blockReason: string | null) {
    this.db
      .query("UPDATE tasks SET status = ?, result = ?, block_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, result, blockReason, Date.now(), id);
  }
  bumpNudge(id: number): number {
    this.db.query("UPDATE tasks SET nudge_count = nudge_count + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
    return this.task(id)!.nudge_count;
  }
  pendingChildren(id: number): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status IN ('open', 'claimed')")
        .get(id) as any
    ).n;
  }
  openTaskCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('open', 'claimed', 'blocked')").get() as any).n;
  }
  recentTasks(n: number): Task[] {
    return this.db.query("SELECT * FROM tasks ORDER BY id DESC LIMIT ?").all(n) as Task[];
  }

  // knocks
  addKnock(pane: string, reason: string, outcome: string) {
    this.db.query("INSERT INTO knocks (pane_id, reason, sent_at, outcome) VALUES (?, ?, ?, ?)").run(pane, reason, Date.now(), outcome);
  }
  recentKnocks(n: number) {
    return this.db.query("SELECT * FROM knocks ORDER BY id DESC LIMIT ?").all(n) as {
      pane_id: string;
      reason: string;
      sent_at: number;
      outcome: string;
    }[];
  }
}
