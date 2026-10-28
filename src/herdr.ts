// Minimal client for the herdr socket API: newline-delimited JSON over a Unix socket.
// Herdr closes a connection after one request, so every request opens its own connection.
import { herdrSocket } from "./paths";

export class HerdrError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function lineReader(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let buf = "";
  return (chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

let seq = 0;

export function request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `bots:${++seq}`;
    let done = false;
    let sock: { end(): void } | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new HerdrError("timeout", `${method} timed out`))), timeoutMs);
    const feed = lineReader((line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        return finish(() => reject(e));
      }
      if (msg.id !== id) return;
      finish(() =>
        msg.error ? reject(new HerdrError(msg.error.code ?? "error", msg.error.message ?? "")) : resolve(msg.result),
      );
    });
    Bun.connect({
      unix: herdrSocket(),
      socket: {
        open(s) {
          s.write(JSON.stringify({ id, method, params }) + "\n");
        },
        data(_s, d) {
          feed(d);
        },
        close() {
          finish(() => reject(new HerdrError("closed", `${method}: connection closed without a response`)));
        },
        error(_s, e) {
          finish(() => reject(new HerdrError("socket_error", e.message)));
        },
        connectError(_s, e) {
          finish(() => reject(new HerdrError("connect_failed", e.message)));
        },
      },
    })
      .then((s) => {
        sock = s;
        if (done) s.end();
      })
      .catch((e) => finish(() => reject(new HerdrError("connect_failed", String(e?.message ?? e)))));
  });
}

export type Subscription = { close(): void };

/** Long-lived event stream. `onClose` runs once, unless the caller closed it. */
export function subscribe(
  subscriptions: unknown[],
  onEvent: (event: any) => void,
  onClose: (reason: string) => void,
): Subscription {
  let closedByCaller = false;
  let ended = false;
  let sock: { end(): void } | undefined;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    try {
      sock?.end();
    } catch {}
    if (!closedByCaller) onClose(reason);
  };
  const feed = lineReader((line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.error) return end(`${msg.error.code}: ${msg.error.message}`);
    if (msg.event) onEvent(msg);
  });
  Bun.connect({
    unix: herdrSocket(),
    socket: {
      open(s) {
        s.write(JSON.stringify({ id: "bots:sub", method: "events.subscribe", params: { subscriptions } }) + "\n");
      },
      data(_s, d) {
        feed(d);
      },
      close() {
        end("connection closed");
      },
      error(_s, e) {
        end(e.message);
      },
      connectError(_s, e) {
        end(e.message);
      },
    },
  })
    .then((s) => {
      sock = s;
      if (ended || closedByCaller) s.end();
    })
    .catch((e) => end(String(e?.message ?? e)));
  return {
    close() {
      closedByCaller = true;
      try {
        sock?.end();
      } catch {}
    },
  };
}

export type AgentInfo = {
  pane_id: string;
  agent?: string | null;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  focused?: boolean;
  state_change_seq?: number;
  workspace_id?: string;
  cwd?: string | null;
  [k: string]: unknown;
};

export async function agentList(): Promise<AgentInfo[]> {
  return (await request("agent.list")).agents ?? [];
}

export async function agentGet(target: string): Promise<AgentInfo> {
  return (await request("agent.get", { target })).agent;
}

/** Last lines of the visible screen of an agent pane. */
export async function readVisible(target: string, lines = 8): Promise<string> {
  const r = await request("agent.read", { target, source: "visible", lines });
  return String(r.read?.text ?? r.text ?? "");
}

/**
 * Type a one-line prompt into an agent and submit it.
 * Herdr's agent.prompt only accepts agents that `herdr agent start` launched (`agent_not_ready`:
 * "not an active named agent"). Harness is started by hand, so we fall back to typing the text
 * into the pane. The fallback has no built-in blocked guard, so it checks the status itself.
 * Throws HerdrError `agent_blocked` if the agent waits on a human.
 */
export async function prompt(target: string, text: string): Promise<AgentInfo> {
  try {
    return (await request("agent.prompt", { target, text })).agent;
  } catch (e) {
    if (!(e instanceof HerdrError) || e.code !== "agent_not_ready") throw e;
  }
  const agent = await agentGet(target);
  if (agent.agent_status === "blocked") throw new HerdrError("agent_blocked", `agent ${target} is blocked; nothing was sent`);
  await request("pane.send_input", { pane_id: agent.pane_id, text, keys: ["enter"] });
  return agent;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function notify(title: string, body?: string): Promise<void> {
  try {
    await request("notification.show", { title: clip(title.replace(/\s+/g, " "), 80), body: body ? clip(body.replace(/\s+/g, " "), 240) : null, sound: "request" });
  } catch (e) {
    console.error("notify failed:", (e as Error).message);
  }
}

export async function reportMetadata(pane: string, displayAgent: string, tokens: Record<string, string>): Promise<void> {
  try {
    await request("pane.report_metadata", { pane_id: pane, source: "bots", display_agent: displayAgent, tokens });
  } catch (e) {
    console.error("report_metadata failed:", (e as Error).message);
  }
}

export async function clearMetadata(pane: string): Promise<void> {
  try {
    await request("pane.report_metadata", {
      pane_id: pane,
      source: "bots",
      clear_display_agent: true,
      tokens: { bots_role: null, unread: null },
    });
  } catch {
    // The pane is often gone already.
  }
}
