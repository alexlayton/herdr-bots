#!/usr/bin/env bun
import { botsSocket } from "./paths";
import { HerdrError, agentGet, agentList, lineReader, prompt, request, subscribe } from "./herdr";

const [cmd, ...rest] = process.argv.slice(2);

const USAGE = `bots <command>

  daemon                          run the bots daemon (normally started by the herdr plugin)
  mcp                             run the MCP stdio shim (configure this in harness)
  agents                          ping herdr and list agents
  watch                           log agent status transitions (Ctrl+C to stop)
  knock <pane> <text>             type a one-line prompt into an idle agent
  status                          show bots, tasks and recent knocks (needs the daemon)
  unregister <name>               remove a bot from the roster (its claimed tasks fail)
  send <agent> <text...>          send a message as "human"
  task <@agent|role> <title> [brief]   create a task as "human" [--project P]
  spawn <name> --role R [--cwd D] [--project P] [--context keep|clear] [--cmd "harness ..."] [--no-intro]
                                  open a workspace, start harness in it, register it as a bot
`;

function parseFlags(args: string[], boolean: string[] = []) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (boolean.includes(k)) flags[k] = true;
      else flags[k] = args[++i] ?? "";
    } else pos.push(a);
  }
  return { flags, pos };
}

function daemonRpc(method: string, args: unknown): Promise<any> {
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
          reject(new Error(`bots daemon is not running (${botsSocket()})`));
        },
      },
    }).catch(() => reject(new Error(`bots daemon is not running (${botsSocket()})`)));
  });
}

async function agents() {
  const pong = await request("ping");
  console.log(`herdr ${pong.version} protocol ${pong.protocol}`);
  for (const a of await agentList()) {
    console.log(`${a.pane_id.padEnd(8)} ${String(a.agent_status).padEnd(8)} ${String(a.agent ?? "-").padEnd(10)} ${a.focused ? "focused " : "        "}${a.cwd ?? ""}`);
  }
}

async function watch() {
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
}

async function spawn(args: string[]) {
  const { flags, pos } = parseFlags(args, ["no-intro"]);
  const name = pos[0];
  const role = flags.role as string | undefined;
  if (!name || !/^[A-Za-z0-9._-]{1,40}$/.test(name) || !role) {
    console.error("usage: bots spawn <name> --role <role> [--cwd D] [--project P] [--context keep|clear] [--cmd 'harness ...']");
    process.exit(2);
  }
  const cwd = (flags.cwd as string) || process.cwd();
  const project = (flags.project as string) || cwd.split("/").filter(Boolean).pop() || "default";
  const env = { BOTS_NAME: name, BOTS_ROLE: role, BOTS_PROJECT: project, BOTS_CONTEXT: (flags.context as string) || "keep" };
  const ws = await request("workspace.create", { cwd, label: name, env, focus: false });
  const pane: string = ws.root_pane.pane_id;
  console.log(`workspace ${ws.workspace.workspace_id ?? ""} pane ${pane}`);
  await request("pane.send_input", { pane_id: pane, text: (flags.cmd as string) || "harness", keys: ["enter"] });

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const a = await agentGet(pane);
      if (a.agent && a.agent_status === "idle") {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) {
    console.error(`agent in ${pane} did not become idle within 90 s; check the pane`);
    process.exit(1);
  }
  console.log(`${name} is up (${pane})`);
  if (!flags["no-intro"]) {
    await prompt(pane, `You are bot ${name} (role ${role}). Call the bots whoami tool, then wait for work.`);
    console.log("intro prompt sent");
  }
}

try {
  switch (cmd) {
    case "daemon":
      await (await import("./daemon")).runDaemon();
      break;
    case "mcp":
      await (await import("./shim")).runShim();
      break;
    case "agents":
      await agents();
      break;
    case "watch":
      await watch();
      break;
    case "knock": {
      const [pane, ...text] = rest;
      if (!pane || !text.length) {
        console.error("usage: bots knock <pane> <text>");
        process.exit(2);
      }
      const a = await prompt(pane, text.join(" "));
      console.log(`sent to ${a.pane_id} (status ${a.agent_status})`);
      break;
    }
    case "status": {
      const s = await daemonRpc("admin.status", {});
      console.log("AGENTS");
      for (const a of s.agents) console.log(`  ${a.name.padEnd(14)} ${a.role.padEnd(12)} ${a.project.padEnd(14)} ${a.pane.padEnd(7)} ${a.status.padEnd(8)} unread=${a.unread} task=${a.current_task ?? "-"}`);
      console.log(`TASKS (${s.open_tasks} unfinished)`);
      for (const t of s.recent_tasks) console.log(`  #${t.id} ${t.status.padEnd(9)} ${t.from} -> ${t.to}${t.assignee ? ` [${t.assignee}]` : ""} nudges=${t.nudges} ${t.title}`);
      console.log("KNOCKS");
      for (const k of s.recent_knocks) console.log(`  ${k.at} ${k.pane} ${k.reason} ${k.outcome}`);
      break;
    }
    case "unregister": {
      if (!rest[0]) {
        console.error("usage: bots unregister <name>");
        process.exit(2);
      }
      console.log(await daemonRpc("admin.unregister", { name: rest[0] }));
      break;
    }
    case "send": {
      const [to, ...body] = rest;
      if (!to || !body.length) {
        console.error("usage: bots send <agent> <text...>");
        process.exit(2);
      }
      console.log(await daemonRpc("admin.send", { to, body: body.join(" ") }));
      break;
    }
    case "task": {
      const { flags, pos } = parseFlags(rest);
      const [to, title, brief] = pos;
      if (!to || !title) {
        console.error("usage: bots task <@agent|role> <title> [brief] [--project P]");
        process.exit(2);
      }
      const args: Record<string, unknown> = { title, brief: brief ?? title, project: flags.project };
      if (to.startsWith("@")) args.to_agent = to.slice(1);
      else args.to_role = to;
      console.log(await daemonRpc("admin.task", args));
      break;
    }
    case "spawn":
      await spawn(rest);
      break;
    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  console.error(e instanceof HerdrError ? `herdr error ${e.message}` : (e as Error).message);
  process.exit(1);
}
