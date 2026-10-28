import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function herdrSocket(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

/** The bots socket sits next to the herdr socket, so named sessions get their own daemon. */
export function botsSocket(): string {
  return process.env.BOTS_SOCKET || join(dirname(herdrSocket()), "bots.sock");
}

/** Herdr's config directory. Named sessions live in `sessions/<name>/` inside it. */
export function herdrConfigDir(): string {
  return process.env.HERDR_CONFIG_DIR || join(homedir(), ".config", "herdr");
}

/** Session name taken from the herdr socket path: `.../sessions/<name>/herdr.sock`, else "default". */
export function sessionName(): string {
  return dirname(herdrSocket()).match(/[\\/]sessions[\\/]([^\\/]+)$/)?.[1] ?? "default";
}

/**
 * Where the daemon keeps its database: one folder per herdr session, so sessions never share state.
 * The location does not depend on how the daemon was started (plugin or by hand).
 */
export function stateDir(): string {
  const base =
    process.env.BOTS_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-bots");
  return join(base, sessionName());
}
