#!/usr/bin/env bun
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { HerdrError, agentGet, agentList, lineReader, prompt, request, subscribe } from "./herdr";
import { botsSocket, herdrConfigDir } from "./paths";

class UsageError extends Error {}

// ---------------------------------------------------------------- helpers

function daemonRpc(method: string, args: unknown): Promise<any> {
  const down = () => new Error(`bots daemon is not running (${botsSocket()}). Start it with \`bots daemon\` or the herdr plugin.`);
  return new Promise((resolve, reject) => {
    const feed = lineReader((line) => {
      const msg = JSON.parse(line);
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
    });
    Bun.connect({
      unix: botsSocket(),
      socket: {
        open(s) {
          s.write(JSON.stringify({ id: 1, method, args }) + "\n");
        },
        data(_s, d) {
          feed(d);
        },
        close() {},
        error(_s, e) {
          reject(e);
        },
        connectError() {
          reject(down());
        },
      },
    }).catch(() => reject(down()));
  });
}

function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

const printJson = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/** Point the CLI at a named herdr session: ~/.config/herdr/sessions/<name>/herdr.sock */
function applySession(name: string | undefined) {
  name ??= process.env.BOTS_SESSION;
  if (!name) return;
  const root = herdrConfigDir();
  const sock = name === "default" ? join(root, "herdr.sock") : join(root, "sessions", name, "herdr.sock");
  if (!existsSync(sock)) {
    const dir = join(root, "sessions");
    const found = existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "herdr.sock"))) : [];
    throw new UsageError(`no herdr session '${name}' (no socket at ${sock}). Sessions: ${["default", ...found].join(", ")}`);
  }
  process.env.HERDR_SOCKET_PATH = sock;
}

// ---------------------------------------------------------------- commands

type Opt = { type: "string" | "boolean"; description: string; value?: string };
type Cmd = {
  name: string;
  args: string;
  summary: string;
  options?: Record<string, Opt>;
  run(values: Record<string, any>, pos: string[]): Promise<void>;
};

const need = (pos: string[], n: number, cmd: Cmd) => {
  if (pos.length < n) throw new UsageError(`missing argument\nUsage: bots ${cmd.name} ${cmd.args}`);
};

const COMMANDS: Cmd[] = [
  {
    name: "daemon",
    args: "",
    summary: "Run the bots daemon (the herdr plugin normally starts it)",
    async run() {
      await (await import("./daemon")).runDaemon();
    },
  },
  {
    name: "mcp",
    args: "",
    summary: "Run the MCP stdio server that agents connect to",
    async run() {
      await (await import("./shim")).runShim();
    },
  },
  {
    name: "harness-setup",
    args: "[--dry-run] [--no-instructions]",
    summary: "Add the bots MCP server and agent instructions to the Harness coding agent",
    options: {
      "dry-run": { type: "boolean", description: "Show what would change; change nothing" },
      "no-instructions": { type: "boolean", description: "Only add the MCP server, not the AGENTS.md block" },
    },
    async run(v) {
      await (await import("./harness-setup")).harnessSetup({ dryRun: !!v["dry-run"], instructions: !v["no-instructions"] });
    },
  },
  {
    name: "status",
    args: "[--json]",
    summary: "Show bots, tasks and recent knocks (needs the daemon)",
    options: { json: { type: "boolean", description: "Print JSON" } },
    async run(v) {
      const s = await daemonRpc("admin.status", {});
      if (v.json) return printJson(s);
      console.log("BOTS");
      console.log(
        table(
          ["NAME", "ROLE", "PROJECT", "PANE", "STATUS", "UNREAD", "TASK"],
          s.agents.map((a: any) => [a.name, a.role, a.project, a.pane, a.status, String(a.unread), a.current_task ? `#${a.current_task}` : "-"]),
        ),
      );
      console.log(`\nTASKS (${s.open_tasks} unfinished)`);
      console.log(
        table(
          ["ID", "STATUS", "FROM", "TO", "ASSIGNEE", "NUDGES", "TITLE"],
          s.recent_tasks.map((t: any) => [`#${t.id}`, t.status, t.from, t.to, t.assignee ?? "-", String(t.nudges), t.title]),
        ),
      );
      console.log("\nKNOCKS");
      console.log(table(["TIME", "PANE", "REASON", "OUTCOME"], s.recent_knocks.map((k: any) => [k.at.slice(11, 19), k.pane, k.reason, k.outcome])));
    },
  },
  {
    name: "agents",
    args: "[--json]",
    summary: "Check herdr is reachable and list the agents it detects",
    options: { json: { type: "boolean", description: "Print JSON" } },
    async run(v) {
      const pong = await request("ping");
      const list = await agentList();
      if (v.json) return printJson({ herdr: pong, agents: list });
      console.log(`herdr ${pong.version} (protocol ${pong.protocol})\n`);
      console.log(
        table(
          ["PANE", "STATUS", "AGENT", "FOCUS", "CWD"],
          list.map((a) => [a.pane_id, a.agent_status, String(a.agent ?? "-"), a.focused ? "yes" : "", String(a.cwd ?? "")]),
        ),
      );
    },
  },
  {
    name: "watch",
    args: "",
    summary: "Log agent status changes as they happen (Ctrl+C to stop)",
    async run() {
      const panes = (await agentList()).map((a) => a.pane_id);
      console.log(`watching ${panes.length} pane(s)`);
      const start = () =>
        subscribe(
          panes.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
          (ev) => console.log(new Date().toISOString().slice(11, 23), ev.event, JSON.stringify(ev.data)),
          (reason) => {
            console.log("closed:", reason);
            setTimeout(start, 2000);
          },
        );
      start();
      await new Promise(() => {});
    },
  },
  {
    name: "knock",
    args: "<pane> <text...>",
    summary: "Type a one-line prompt into an idle agent (refused if it is blocked)",
    async run(_v, pos) {
      need(pos, 2, this);
      const a = await prompt(pos[0], pos.slice(1).join(" "));
      console.log(`sent to ${a.pane_id} (status ${a.agent_status})`);
    },
  },
  {
    name: "send",
    args: "<bot> <text...>",
    summary: 'Send a message to a bot as "human"',
    async run(_v, pos) {
      need(pos, 2, this);
      const r = await daemonRpc("admin.send", { to: pos[0], body: pos.slice(1).join(" ") });
      console.log(`message #${r.message_id} sent to ${pos[0]}`);
    },
  },
  {
    name: "task",
    args: "<@bot|role> <title> [brief]",
    summary: 'Create a task as "human" for a bot (@name) or for a role',
    options: { project: { type: "string", value: "name", description: "Project of the target role (default: inferred)" } },
    async run(v, pos) {
      need(pos, 2, this);
      const [to, title, brief] = pos;
      const args: Record<string, unknown> = { title, brief: brief ?? title, project: v.project };
      if (to.startsWith("@")) args.to_agent = to.slice(1);
      else args.to_role = to;
      const r = await daemonRpc("admin.task", args);
      console.log(`task #${r.task_id} created`);
    },
  },
  {
    name: "unregister",
    args: "<bot>",
    summary: "Remove a bot from the roster (its claimed tasks fail)",
    async run(_v, pos) {
      need(pos, 1, this);
      await daemonRpc("admin.unregister", { name: pos[0] });
      console.log(`${pos[0]} removed`);
    },
  },
  {
    name: "spawn",
    args: "<name> --role <role> [options]",
    summary: "Open a workspace, start an agent in it and register it as a bot",
    options: {
      role: { type: "string", value: "role", description: "Role of the bot (required)" },
      cwd: { type: "string", value: "dir", description: "Working directory (default: current directory)" },
      project: { type: "string", value: "name", description: "Project label (default: name of the directory)" },
      context: { type: "string", value: "keep|clear", description: "clear: start each new task with a fresh conversation" },
      cmd: { type: "string", value: "command", description: 'Command that starts the agent (default: "harness")' },
      "no-intro": { type: "boolean", description: "Do not send the intro prompt" },
    },
    async run(v, pos) {
      need(pos, 1, this);
      const name = pos[0];
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new UsageError("name must be 1-40 letters, digits, dot, dash or underscore");
      if (!v.role) throw new UsageError(`--role is required\nUsage: bots spawn ${this.args}`);
      if (v.context && v.context !== "keep" && v.context !== "clear") throw new UsageError("--context must be keep or clear");
      const cwd = v.cwd || process.cwd();
      const project = v.project || cwd.split("/").filter(Boolean).pop() || "default";
      const env = { BOTS_NAME: name, BOTS_ROLE: v.role, BOTS_PROJECT: project, BOTS_CONTEXT: v.context || "keep" };
      const ws = await request("workspace.create", { cwd, label: name, env, focus: false });
      const pane: string = ws.root_pane.pane_id;
      console.log(`workspace ${ws.workspace.workspace_id ?? ""} pane ${pane}`);
      await request("pane.send_input", { pane_id: pane, text: v.cmd || "harness", keys: ["enter"] });
      const deadline = Date.now() + 90_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const a = await agentGet(pane);
          ready = !!a.agent && a.agent_status === "idle";
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) throw new Error(`the agent in ${pane} did not become idle within 90 s; check the pane`);
      console.log(`${name} is up (${pane})`);
      if (!v["no-intro"]) {
        await prompt(pane, `You are bot ${name} (role ${v.role}). Call the bots whoami tool, then wait for work.`);
        console.log("intro prompt sent");
      }
    },
  },
];

// ---------------------------------------------------------------- help

function mainHelp(): string {
  return `bots ${pkg.version} - let agents in herdr panes message each other and delegate tasks

Usage: bots [--session <name>] <command> [options]

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n")}

Global options:
  -s, --session <name>   herdr session to use (default: the session of this pane, else "default")
  -h, --help             Show help (also: bots <command> --help)
  -v, --version          Show version

Environment: BOTS_SESSION, BOTS_SOCKET, BOTS_STATE_DIR. Run \`bots <command> --help\` for details.`;
}

function commandHelp(c: Cmd): string {
  const opts = Object.entries(c.options ?? {});
  const lines = [`Usage: bots ${c.name}${c.args ? " " + c.args : ""}`, "", c.summary];
  if (opts.length) {
    lines.push("", "Options:");
    for (const [k, o] of opts) lines.push(`  --${k}${o.type === "string" ? ` <${o.value ?? "value"}>` : ""}`.padEnd(26) + o.description);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- main

async function main(argv: string[]) {
  let session: string | undefined;
  let help = false;
  let version = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === "-s" || a === "--session") session = argv[++i];
    else if (a.startsWith("--session=")) session = a.slice("--session=".length);
    else if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else rest.push(a);
  }
  if (version) return console.log(pkg.version);
  const [name, ...args] = rest;
  if (!name) return console.log(mainHelp());
  if (name === "help") {
    const c = COMMANDS.find((x) => x.name === args[0]);
    return console.log(c ? commandHelp(c) : mainHelp());
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new UsageError(`unknown command '${name}'\n\n${mainHelp()}`);
  if (help) return console.log(commandHelp(cmd));

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: Object.fromEntries(Object.entries(cmd.options ?? {}).map(([k, o]) => [k, { type: o.type }])),
    });
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n\n${commandHelp(cmd)}`);
  }
  applySession(session);
  await cmd.run.call(cmd, parsed.values, parsed.positionals);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`bots: ${e.message}`);
    process.exit(2);
  }
  console.error(`bots: ${e instanceof HerdrError ? `herdr error ${e.message}` : (e as Error).message}`);
  process.exit(1);
}
