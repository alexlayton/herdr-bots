// MCP stdio shim: one per agent. Forwards tool calls to the bots daemon, tagged with the pane id.
import { basename } from "node:path";
import { lineReader } from "./herdr";
import { botsSocket } from "./paths";
import { TOOLS } from "./tools";

const pane = process.env.HERDR_PANE_ID;
const identity = {
  name: process.env.BOTS_NAME,
  role: process.env.BOTS_ROLE,
  project: process.env.BOTS_PROJECT || basename(process.cwd()),
  context: process.env.BOTS_CONTEXT,
  cwd: process.cwd(),
};

function daemonCall(method: string, args: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => finish(() => reject(new Error("bots daemon timed out"))), 15_000);
    const feed = lineReader((line) => {
      const msg = JSON.parse(line);
      finish(() => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error))));
    });
    Bun.connect({
      unix: botsSocket(),
      socket: {
        open(s) {
          s.write(JSON.stringify({ id: 1, method, pane_id: pane, identity, args }) + "\n");
        },
        data(_s, d) {
          feed(d);
        },
        close() {
          finish(() => reject(new Error("bots daemon closed the connection")));
        },
        error(_s, e) {
          finish(() => reject(new Error(e.message)));
        },
        connectError() {
          finish(() => reject(new Error("bots daemon is not running (start it with `bun src/cli.ts daemon` or the herdr plugin)")));
        },
      },
    }).catch(() => finish(() => reject(new Error("bots daemon is not running"))));
  });
}

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

async function onMessage(msg: any) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        // Register in the background so the pane shows up in the sidebar at startup.
        if (pane) daemonCall("hello").catch(() => {});
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "bots", version: "0.1.0" },
          },
        });
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        // Outside a herdr pane there is no identity, so expose nothing and cost no context.
        return send({ jsonrpc: "2.0", id, result: { tools: pane ? TOOLS : [] } });
      case "tools/call": {
        const name: string = params?.name;
        if (!pane || !TOOLS.some((t) => t.name === name)) {
          return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] } });
        }
        try {
          const result = await daemonCall(name, params?.arguments ?? {});
          return send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result },
          });
        } catch (e) {
          return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: (e as Error).message }] } });
        }
      }
      default:
        if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: (e as Error).message } });
  }
}

export async function runShim() {
  const feed = lineReader((line) => {
    try {
      void onMessage(JSON.parse(line));
    } catch {}
  });
  for await (const chunk of Bun.stdin.stream()) feed(chunk);
}
