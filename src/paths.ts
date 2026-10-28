import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function herdrSocket(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

/** The bots socket sits next to the herdr socket, so named sessions get their own daemon. */
export function botsSocket(): string {
  return process.env.BOTS_SOCKET || join(dirname(herdrSocket()), "bots.sock");
}

export function stateDir(): string {
  return (
    process.env.BOTS_STATE_DIR ||
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), ".local", "state", "herdr-bots")
  );
}
