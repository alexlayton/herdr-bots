// Bots daemon: owns the database, serves the shim RPC socket, watches herdr and knocks idle agents.
import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Store, type Agent, type Task } from "./db";
import {
  HerdrError,
  agentGet,
  agentList,
  clearMetadata,
  lineReader,
  notify,
  prompt,
  readVisible,
  reportMetadata,
  subscribe,
  type AgentInfo,
  type Subscription,
} from "./herdr";
import { botsSocket, stateDir } from "./paths";
import { GUIDE } from "./tools";

const num = (name: string, dflt: number) => Number(process.env[name] ?? dflt);
const cfg = {
  maxHops: num("BOTS_MAX_HOPS", 3),
  msgLimit: num("BOTS_MSG_LIMIT", 20),
  msgWindowMs: 10 * 60_000,
  idleDelayMs: num("BOTS_IDLE_DELAY_MS", 3000),
  minGapMs: num("BOTS_MIN_GAP_MS", 10_000),
  focusNotifyMs: num("BOTS_FOCUS_NOTIFY_MS", 60_000),
  focusRetryMs: 5000,
  blockedNotifyMs: 5 * 60_000,
  tickMs: num("BOTS_TICK_MS", 30_000),
  maxNudges: 2,
  pruneMs: num("BOTS_PRUNE_MS", 120_000),
  repeatKnockMs: 120_000,
  roleOfferMs: 60_000,
  // "empty-input": knock a focused pane when its input box is empty. "wait": never knock a focused pane.
  focusPolicy: process.env.BOTS_FOCUS_POLICY || "empty-input",
  emptyInputMarker: process.env.BOTS_EMPTY_INPUT_MARKER || "Type your message",
  clearCommand: process.env.BOTS_CLEAR_COMMAND || "/new",
  clearWaitMs: num("BOTS_CLEAR_WAIT_MS", 1500),
};

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

class BotsError extends Error {}
const fail = (msg: string): never => {
  throw new BotsError(msg);
};

const store = new Store(join(stateDir(), "bots.db"));

// ---------------------------------------------------------------- in-memory dispatch state

const timers = new Map<string, { at: number; handle: ReturnType<typeof setTimeout> }>();
const lastStatus = new Map<string, string>();
const lastKnock = new Map<string, { at: number; key: string }>();
const focusedSince = new Map<string, number>();
const focusNotified = new Set<string>();
const blockedSince = new Map<string, number>();
const blockedNotified = new Set<string>();
const stalledNotified = new Set<number>();
const optedOut = new Set<string>(); // panes whose bot called unregister: no auto-register until register
const missingSince = new Map<string, number>();
const knockErrorNotified = new Set<string>();
const offered = new Map<number, { pane: string; at: number }>();

function scheduleCheck(pane: string, delayMs: number, reset = false) {
  const at = Date.now() + delayMs;
  const existing = timers.get(pane);
  if (existing) {
    if (!reset && existing.at <= at) return;
    clearTimeout(existing.handle);
  }
  const handle = setTimeout(() => {
    timers.delete(pane);
    check(pane).catch((e) => log(`[check ${pane}] error:`, (e as Error).message));
  }, delayMs);
  timers.set(pane, { at, handle });
}

const label = (pane: string) => store.agentByPane(pane)?.name ?? pane;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function logKnock(pane: string, reason: string, outcome: string, detail = "") {
  store.addKnock(pane, reason, outcome);
  log(`[knock] ${label(pane)} (${pane}) ${reason} -> ${outcome}${detail ? " " + detail : ""}`);
}

// ---------------------------------------------------------------- doorbell

type Plan =
  | { kind: "stalled"; task: Task }
  | { kind: "nudge"; task: Task; text: string }
  | { kind: "mail"; text: string }
  | { kind: "task"; task: Task; text: string };

function decide(agent: Agent, pane: string): Plan | null {
  const cur = store.currentTask(agent.name);
  let waitingOnChildren = false;
  if (cur) {
    waitingOnChildren = store.pendingChildren(cur.id) > 0;
    if (!waitingOnChildren) {
      if (cur.nudge_count >= cfg.maxNudges) return { kind: "stalled", task: cur };
      return {
        kind: "nudge",
        task: cur,
        text: `Task #${cur.id} is still open. Finish it, then call update_task with done, failed or blocked.`,
      };
    }
  }
  const mail = store.unread(agent.name);
  if (mail.length) {
    const from = [...new Set(mail.map((m) => m.from_agent))].join(", ");
    return { kind: "mail", text: `${mail.length} unread from ${from}. Call read_inbox.` };
  }
  if (!cur) {
    const now = Date.now();
    for (const t of store.openTasksFor(agent)) {
      const o = offered.get(t.id);
      if (o && o.pane !== pane && now - o.at < cfg.roleOfferMs) continue; // another agent was offered this role task
      return { kind: "task", task: t, text: `New task #${t.id}: ${oneLine(t.title)}. Call read_task.` };
    }
  }
  return null;
}

async function inputIsEmpty(pane: string): Promise<boolean> {
  if (cfg.focusPolicy !== "empty-input") return false;
  try {
    return (await readVisible(pane, 6)).includes(cfg.emptyInputMarker);
  } catch {
    return false;
  }
}

async function check(pane: string) {
  const agent = store.agentByPane(pane);
  if (!agent) return;
  let info: AgentInfo;
  try {
    info = await agentGet(pane);
  } catch (e) {
    log(`[check] ${agent.name}: agent.get failed: ${(e as Error).message}`);
    return;
  }
  const status = info.agent_status;
  store.setLastStatus(pane, status);

  if (status === "blocked") {
    const since = blockedSince.get(pane) ?? Date.now();
    blockedSince.set(pane, since);
    const waiting = store.unreadCount(agent.name) > 0 || store.openTasksFor(agent).length > 0;
    if (waiting && Date.now() - since > cfg.blockedNotifyMs && !blockedNotified.has(pane)) {
      blockedNotified.add(pane);
      await notify(`${agent.name} is blocked`, `${agent.name} has waited on you for over 5 min and has pending work.`);
      logKnock(pane, "mail", "notified_human_blocked");
    }
    return;
  }
  blockedSince.delete(pane);
  blockedNotified.delete(pane);
  if (status !== "idle" && status !== "done") return;

  const plan = decide(agent, pane);
  if (!plan) {
    focusedSince.delete(pane);
    return;
  }

  if (plan.kind === "stalled") {
    if (!stalledNotified.has(plan.task.id)) {
      stalledNotified.add(plan.task.id);
      await notify(`${agent.name} stalled on #${plan.task.id}`, oneLine(plan.task.title, 200));
      logKnock(pane, "nudge", "notified_human_stalled", `task #${plan.task.id}`);
    }
    return;
  }

  const reason = plan.kind;
  const key = `${reason}:${plan.kind === "mail" ? "" : plan.task.id}:${info.state_change_seq ?? ""}`;
  const prev = lastKnock.get(pane);
  if (prev && prev.key === key && Date.now() - prev.at < cfg.repeatKnockMs) return; // already knocked for this state

  const gap = Date.now() - (lastKnock.get(pane)?.at ?? 0);
  if (gap < cfg.minGapMs) return scheduleCheck(pane, cfg.minGapMs - gap + 50);

  // Never type over the human. A focused pane is still safe when nothing is typed in its input box.
  if (info.focused && !(await inputIsEmpty(pane))) {
    const since = focusedSince.get(pane) ?? Date.now();
    if (!focusedSince.has(pane)) {
      focusedSince.set(pane, since);
      logKnock(pane, reason, "skipped_focus");
    }
    if (Date.now() - since >= cfg.focusNotifyMs && !focusNotified.has(pane)) {
      focusNotified.add(pane);
      await notify(`${agent.name} has pending work`, `Bots is waiting for you to leave pane ${pane} before it knocks.`);
    }
    return scheduleCheck(pane, cfg.focusRetryMs);
  }
  focusedSince.delete(pane);
  focusNotified.delete(pane);

  let cleared = false;
  if (plan.kind === "task" && agent.context_mode === "clear") {
    cleared = true;
    try {
      await prompt(pane, cfg.clearCommand);
    } catch (e) {
      log(`[knock] ${agent.name}: ${cfg.clearCommand} failed: ${(e as Error).message}`);
    }
    await sleep(cfg.clearWaitMs);
  }

  // Re-check status right before sending. After a clear command, give the agent time to settle.
  const settleUntil = Date.now() + (cleared ? 8000 : 0);
  for (;;) {
    try {
      info = await agentGet(pane);
    } catch {
      return;
    }
    if (info.agent_status === "idle" || info.agent_status === "done") break;
    if (Date.now() >= settleUntil) return scheduleCheck(pane, cfg.idleDelayMs);
    await sleep(300);
  }

  try {
    await prompt(pane, plan.text);
  } catch (e) {
    const code = e instanceof HerdrError ? e.code : "error";
    lastKnock.set(pane, { at: Date.now(), key });
    logKnock(pane, reason, code === "agent_blocked" ? "blocked" : `error:${code}`, (e as Error).message);
    if (code !== "agent_blocked" && !knockErrorNotified.has(`${pane}:${code}`)) {
      knockErrorNotified.add(`${pane}:${code}`);
      await notify(`Bots cannot knock ${agent.name}`, (e as Error).message);
    }
    return;
  }
  lastKnock.set(pane, { at: Date.now(), key });
  if (plan.kind === "nudge") store.bumpNudge(plan.task.id);
  if (plan.kind === "task") offered.set(plan.task.id, { pane, at: Date.now() });
  logKnock(pane, reason, "sent", `"${plan.text}"`);
}

// ---------------------------------------------------------------- herdr events

let sub: Subscription | null = null;
let subPanes = "";
let resubTimer: ReturnType<typeof setTimeout> | null = null;

function handleStatus(pane: string, status: string) {
  const prev = lastStatus.get(pane);
  lastStatus.set(pane, status);
  if (prev !== status) log(`[status] ${label(pane)} (${pane}): ${prev ?? "?"} -> ${status}`);
  const agent = store.agentByPane(pane);
  if (!agent) return;
  store.setLastStatus(pane, status);
  if (status === "blocked") blockedSince.set(pane, blockedSince.get(pane) ?? Date.now());
  else blockedSince.delete(pane);
  if (status === "idle" || status === "done") scheduleCheck(pane, cfg.idleDelayMs, true);
}

function onEvent(ev: any) {
  const name: string = ev.event ?? ev.type;
  if (name === "pane.agent_status_changed") {
    const d = ev.data ?? {};
    if (d.pane_id && d.agent_status) handleStatus(d.pane_id, d.agent_status);
  } else if (name === "events_lost") {
    log("[events] events_lost: resubscribing and reconciling");
    void startSubscription();
  } else if (name === "pane.created" || name === "pane.agent_detected" || name === "pane.closed") {
    if (resubTimer) clearTimeout(resubTimer);
    resubTimer = setTimeout(() => void startSubscription(), 1000);
  }
}

async function startSubscription() {
  sub?.close();
  sub = null;
  let panes: string[];
  try {
    panes = (await agentList()).map((a) => a.pane_id).sort();
  } catch (e) {
    log("[events] agent.list failed, retrying:", (e as Error).message);
    setTimeout(() => void startSubscription(), 3000);
    return;
  }
  subPanes = panes.join(",");
  const subs = [
    ...panes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    { type: "pane.created" },
    { type: "pane.agent_detected" },
    { type: "pane.closed" },
  ];
  const me: Subscription = subscribe(subs, onEvent, (reason) => {
    if (sub !== me) return;
    sub = null;
    log("[events] subscription closed:", reason);
    setTimeout(() => void startSubscription(), 2000);
  });
  sub = me;
  log(`[events] watching ${panes.length} agent pane(s)`);
  for (const a of store.agents()) scheduleCheck(a.pane_id, cfg.idleDelayMs); // reconcile
}

async function tick() {
  try {
    const livePanes = (await agentList()).map((a) => a.pane_id);
    const live = [...livePanes].sort().join(",");
    if (live !== subPanes) {
      log("[tick] pane set changed, resubscribing");
      await startSubscription();
    }
    // Drop bots whose pane has been gone for a while. Only done after a successful agent.list.
    for (const a of store.agents()) {
      if (livePanes.includes(a.pane_id)) {
        missingSince.delete(a.pane_id);
        continue;
      }
      const since = missingSince.get(a.pane_id) ?? Date.now();
      missingSince.set(a.pane_id, since);
      if (Date.now() - since >= cfg.pruneMs) removeAgent(a, "pane is gone");
    }
  } catch (e) {
    log("[tick] herdr unreachable:", (e as Error).message);
  }
  for (const a of store.agents()) scheduleCheck(a.pane_id, 0);
}

// ---------------------------------------------------------------- helpers for tools

async function liveMap(): Promise<Map<string, AgentInfo>> {
  try {
    return new Map((await agentList()).map((a) => [a.pane_id, a]));
  } catch {
    return new Map();
  }
}

function refreshMeta(a: Agent) {
  void reportMetadata(a.pane_id, a.name, { bots_role: a.role, unread: String(store.unreadCount(a.name)) });
}

function wake(a: Agent | null) {
  if (!a) return;
  scheduleCheck(a.pane_id, cfg.idleDelayMs);
  refreshMeta(a);
}

function dispatchTask(t: Task) {
  if (t.target_agent) return wake(store.agentByName(t.target_agent));
  for (const a of store.agents({ project: t.project, role: t.target_role ?? undefined })) wake(a);
}

/** Drop an agent. Its claimed tasks fail, so the people waiting on them are told. */
function removeAgent(a: Agent, why: string) {
  for (const t of store.claimedTasks(a.name)) {
    const text = `${a.name} left the roster (${why}) before finishing.`;
    store.finishTask(t.id, "failed", text, null);
    log(`[task] #${t.id} claimed -> failed (${why})`);
    const body = `Task #${t.id} "${oneLine(t.title)}" failed:\n${text}`;
    if (t.created_by === "human") void notify(`Task #${t.id} failed`, text);
    else if (store.agentByName(t.created_by)) sendMessage(a.name, t.created_by, body, t.id, false);
  }
  store.deleteAgent(a.pane_id);
  const timer = timers.get(a.pane_id);
  if (timer) clearTimeout(timer.handle);
  for (const m of [timers, lastStatus, lastKnock, focusedSince, blockedSince, missingSince] as Map<string, unknown>[]) m.delete(a.pane_id);
  for (const set of [focusNotified, blockedNotified]) set.delete(a.pane_id);
  log(`[unregister] ${a.name} (${a.pane_id}): ${why}`);
  void clearMetadata(a.pane_id);
}

const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;

async function registerAgent(
  pane: string,
  p: { name: string; role: string; project: string; context_mode?: string },
): Promise<Agent> {
  if (!NAME_RE.test(p.name) || p.name === "human") fail("invalid name: use 1-40 letters, digits, dot, dash or underscore (not 'human')");
  if (!NAME_RE.test(p.role)) fail("invalid role");
  if (!p.project.trim()) fail("project is empty");
  const mode = p.context_mode === "clear" ? "clear" : "keep";
  const other = store.agentByName(p.name);
  if (other && other.pane_id !== pane) {
    if ((await liveMap()).has(other.pane_id)) fail(`name '${p.name}' is already used by live pane ${other.pane_id}`);
    store.deleteAgent(other.pane_id);
  }
  optedOut.delete(pane);
  const existing = store.agentByPane(pane);
  const a = store.upsertAgent({ pane_id: pane, name: p.name, role: p.role, project: p.project, context_mode: mode });
  if (!existing || existing.name !== a.name || existing.role !== a.role) {
    log(`[register] ${a.name} role=${a.role} project=${a.project} pane=${pane}`);
  }
  wake(a);
  return a;
}

type Identity = { name?: string; role?: string; project?: string; context?: string; cwd?: string };

async function ensureAgent(pane: string, id?: Identity): Promise<Agent | null> {
  const known = store.agentByPane(pane);
  if (known) return known;
  if (optedOut.has(pane)) return null;
  if (id?.name && id?.role) {
    return registerAgent(pane, {
      name: id.name,
      role: id.role,
      project: id.project || (id.cwd ? basename(id.cwd) : "default"),
      context_mode: id.context,
    });
  }
  return null;
}

const taskView = (t: Task) => ({
  id: t.id,
  title: t.title,
  brief: t.brief,
  status: t.status,
  created_by: t.created_by,
  assignee: t.assignee,
  target_role: t.target_role,
  target_agent: t.target_agent,
  project: t.project,
  parent_id: t.parent_id,
  parent_title: t.parent_id ? (store.task(t.parent_id)?.title ?? null) : null,
  result: t.result,
  block_reason: t.block_reason,
  hop_count: t.hop_count,
});

function sendMessage(from: string, to: string, body: string, taskId: number | null, limited = true): number {
  if (!body.trim()) fail("body is empty");
  if (to === "human") {
    const id = store.addMessage(from, "human", body, taskId, true);
    void notify(`Message from ${from}`, body);
    log(`[message] #${id} ${from} -> human`);
    return id;
  }
  const dest = store.agentByName(to) ?? fail(`unknown agent '${to}'. Use list_agents.`);
  if (from !== "human" && limited) {
    const sent = store.sentSince(from, Date.now() - cfg.msgWindowMs);
    if (sent >= cfg.msgLimit) fail(`rate limit: ${cfg.msgLimit} messages per 10 minutes`);
  }
  if (taskId != null && !store.task(taskId)) fail(`unknown task #${taskId}`);
  const id = store.addMessage(from, to, body, taskId);
  log(`[message] #${id} ${from} -> ${to}`);
  wake(dest);
  return id;
}

function createTask(
  creator: string,
  project: string,
  target: { role?: string; agent?: string },
  title: string,
  brief: string,
  parent: Task | null,
): Task {
  if (!title.trim() || !brief.trim()) fail("title and brief are required");
  if (!!target.role === !!target.agent) fail("set exactly one of to_role or to_agent");
  const hop = parent ? parent.hop_count + 1 : 0;
  if (hop > cfg.maxHops) fail(`delegation depth limit (${cfg.maxHops} hops) reached. Do the work yourself or report back as blocked.`);
  if (target.agent) {
    if (target.agent === creator) fail("cannot delegate to yourself");
    if (!store.agentByName(target.agent)) fail(`unknown agent '${target.agent}'. Use list_agents.`);
  } else if (!store.agents({ project, role: target.role }).filter((a) => a.name !== creator).length) {
    fail(`no agent with role '${target.role}' in project '${project}'`);
  }
  const t = store.addTask({
    parent_id: parent?.id ?? null,
    project,
    created_by: creator,
    target_role: target.role ?? null,
    target_agent: target.agent ?? null,
    title,
    brief,
    hop_count: hop,
  });
  log(`[task] #${t.id} created by ${creator} -> ${target.agent ? "@" + target.agent : "role:" + target.role} "${oneLine(title)}" hop=${hop}`);
  dispatchTask(t);
  return t;
}

// ---------------------------------------------------------------- tools

async function callTool(pane: string, id: Identity | undefined, tool: string, a: Record<string, any>): Promise<unknown> {
  if (tool === "register") {
    const name = String(a.name ?? id?.name ?? "");
    const role = String(a.role ?? id?.role ?? "");
    if (!name || !role) fail("name and role are required");
    const project = String(a.project ?? id?.project ?? (id?.cwd ? basename(id.cwd) : "default"));
    const me = await registerAgent(pane, { name, role, project, context_mode: a.context_mode ?? id?.context });
    return { agent: me };
  }

  if (tool === "unregister") {
    const mine = store.agentByPane(pane);
    if (!mine) return { unregistered: false, note: "you were not registered" };
    const claimed = store.claimedTasks(mine.name);
    if (claimed.length) {
      fail(`finish your claimed task(s) first: ${claimed.map((t) => "#" + t.id).join(", ")}. Call update_task with done, failed or blocked.`);
    }
    removeAgent(mine, "unregistered by the bot");
    optedOut.add(pane);
    return { unregistered: true, name: mine.name };
  }

  const me = await ensureAgent(pane, id);
  if (tool === "whoami") {
    if (!me) return { registered: false, pane_id: pane, hint: "Call register with name, role and project." };
    const cur = store.currentTask(me.name);
    return {
      registered: true,
      agent: { name: me.name, role: me.role, project: me.project, context_mode: me.context_mode, pane_id: me.pane_id },
      unread: store.unreadCount(me.name),
      current_task: cur ? { id: cur.id, title: cur.title, status: cur.status } : null,
      open_tasks: cur ? [] : store.openTasksFor(me).map((t) => ({ id: t.id, title: t.title })),
      guide: GUIDE,
    };
  }
  if (!me) return fail("not registered. Call register with name, role and project.");

  switch (tool) {
    case "list_agents": {
      const live = await liveMap();
      return {
        agents: store
          .agents({ project: a.project, role: a.role })
          .map((x) => ({
            name: x.name,
            role: x.role,
            project: x.project,
            status: live.get(x.pane_id)?.agent_status ?? "offline",
            you: x.name === me.name,
          })),
      };
    }
    case "send_message": {
      const mid = sendMessage(me.name, String(a.to ?? ""), String(a.body ?? ""), a.task_id ?? null);
      return { message_id: mid };
    }
    case "read_inbox": {
      const limit = Math.max(1, Math.min(50, Number(a.limit ?? 10)));
      const msgs = store.unread(me.name, limit);
      store.markRead(msgs.map((m) => m.id));
      refreshMeta(me);
      return {
        messages: msgs.map((m) => ({ id: m.id, from: m.from_agent, task_id: m.task_id, body: m.body, at: new Date(m.created_at).toISOString() })),
        remaining_unread: store.unreadCount(me.name),
      };
    }
    case "delegate": {
      const parentId = a.parent_task_id ?? store.currentTask(me.name)?.id ?? null;
      const parent = parentId != null ? (store.task(Number(parentId)) ?? fail(`unknown task #${parentId}`)) : null;
      const t = createTask(me.name, me.project, { role: a.to_role, agent: a.to_agent }, String(a.title ?? ""), String(a.brief ?? ""), parent);
      return { task_id: t.id, hop_count: t.hop_count };
    }
    case "read_task": {
      let t: Task | null;
      if (a.task_id != null) t = store.task(Number(a.task_id)) ?? fail(`unknown task #${a.task_id}`);
      else t = store.currentTask(me.name) ?? store.openTasksFor(me)[0] ?? fail("no current or open task for you");
      const addressed = t.target_agent === me.name || (t.target_role === me.role && t.project === me.project);
      if (t.status === "open" && addressed) {
        if (store.claim(t.id, me.name)) log(`[task] #${t.id} claimed by ${me.name}`);
        t = store.task(t.id)!;
        if (t.assignee !== me.name) fail(`task #${t.id} was claimed by ${t.assignee}`);
      } else if (!addressed && t.assignee !== me.name && t.created_by !== me.name) {
        fail(`task #${t.id} is not yours`);
      }
      return { task: taskView(t) };
    }
    case "update_task": {
      const t = store.task(Number(a.task_id)) ?? fail(`unknown task #${a.task_id}`);
      if (t.status === "open") fail(`task #${t.id} is not claimed yet. Call read_task first.`);
      if (t.assignee !== me.name) fail(`task #${t.id} is not assigned to you`);
      if (t.status !== "claimed" && t.status !== "blocked") fail(`task #${t.id} is already ${t.status}`);
      const status = a.status;
      const text = String(a.result ?? a.reason ?? "").trim();
      if (status !== "done" && status !== "failed" && status !== "blocked") fail("status must be done, failed or blocked");
      if (!text) fail(status === "done" ? "result is required" : "reason is required");
      store.finishTask(t.id, status, status === "blocked" ? t.result : text, status === "blocked" ? text : t.block_reason);
      log(`[task] #${t.id} ${t.status} -> ${status} by ${me.name}`);
      const verb = status === "done" ? "is done" : status === "failed" ? "failed" : "is blocked";
      const body = `Task #${t.id} "${oneLine(t.title)}" ${verb}:\n${text}`;
      if (t.created_by === "human") {
        void notify(`Task #${t.id} ${status}`, `${me.name}: ${oneLine(text, 200)}`);
      } else if (store.agentByName(t.created_by)) {
        sendMessage(me.name, t.created_by, body, t.id, false);
      }
      // The agent that just finished may have more queued work.
      wake(me);
      return { task: taskView(store.task(t.id)!) };
    }
  }
  return fail(`unknown tool '${tool}'`);
}

// ---------------------------------------------------------------- admin (used by the CLI as "human")

async function admin(method: string, a: Record<string, any>): Promise<unknown> {
  switch (method) {
    case "status": {
      const live = await liveMap();
      return {
        agents: store.agents().map((x) => ({
          name: x.name,
          role: x.role,
          project: x.project,
          pane: x.pane_id,
          status: live.get(x.pane_id)?.agent_status ?? "offline",
          unread: store.unreadCount(x.name),
          current_task: store.currentTask(x.name)?.id ?? null,
        })),
        open_tasks: store.openTaskCount(),
        recent_tasks: store.recentTasks(10).map((t) => ({ id: t.id, status: t.status, from: t.created_by, to: t.target_agent ?? `role:${t.target_role}`, assignee: t.assignee, nudges: t.nudge_count, title: oneLine(t.title, 60) })),
        recent_knocks: store.recentKnocks(10).map((k) => ({ pane: k.pane_id, reason: k.reason, outcome: k.outcome, at: new Date(k.sent_at).toISOString() })),
      };
    }
    case "unregister": {
      const target = store.agentByName(String(a.name)) ?? fail(`unknown bot '${a.name}'`);
      removeAgent(target, "removed by the human");
      return { unregistered: true, name: target.name };
    }
    case "send":
      return { message_id: sendMessage("human", String(a.to), String(a.body), null) };
    case "task": {
      const target = a.to_agent ? { agent: String(a.to_agent) } : { role: String(a.to_role) };
      const project =
        a.project ??
        (target.agent ? store.agentByName(target.agent)?.project : store.agents({ role: target.role })[0]?.project) ??
        fail("cannot infer project; pass --project");
      const t = createTask("human", String(project), target, String(a.title), String(a.brief ?? a.title), null);
      return { task_id: t.id };
    }
  }
  return fail(`unknown admin method '${method}'`);
}

// ---------------------------------------------------------------- RPC socket

async function handle(req: any): Promise<unknown> {
  const method: string = req.method;
  if (method === "ping") return { pong: true };
  if (method.startsWith("admin.")) return admin(method.slice(6), req.args ?? {});
  if (method === "hello") {
    const me = await ensureAgent(req.pane_id, req.identity);
    if (me) wake(me);
    return { registered: !!me };
  }
  if (!req.pane_id) fail("pane_id is required");
  return callTool(req.pane_id, req.identity, method, req.args ?? {});
}

async function onLine(socket: { write(s: string): number; end(): void }, line: string) {
  let req: any;
  let res: any;
  try {
    req = JSON.parse(line);
    res = { id: req.id, ok: true, result: await handle(req) };
  } catch (e) {
    const err = e as Error;
    if (!(err instanceof BotsError)) log("[rpc] error:", err.stack ?? err.message);
    res = { id: req?.id, ok: false, error: err.message };
  }
  socket.write(JSON.stringify(res) + "\n");
  socket.end();
}

async function alreadyRunning(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 500);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          clearTimeout(t);
          s.end();
          resolve(true);
        },
        data() {},
        connectError() {
          clearTimeout(t);
          resolve(false);
        },
        error() {},
      },
    }).catch(() => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

export async function runDaemon() {
  const path = botsSocket();
  if (await alreadyRunning(path)) {
    console.log(`bots daemon already running on ${path}`);
    return;
  }
  rmSync(path, { force: true });
  Bun.listen<{ feed: (c: Uint8Array) => void }>({
    unix: path,
    socket: {
      open(s) {
        s.data = { feed: lineReader((line) => void onLine(s, line)) };
      },
      data(s, d) {
        s.data.feed(d);
      },
      close() {},
      error() {},
    },
  });
  const quit = () => {
    rmSync(path, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  log(`bots daemon listening on ${path}; db ${join(stateDir(), "bots.db")}`);
  await startSubscription();
  setInterval(() => void tick(), cfg.tickMs);
}
