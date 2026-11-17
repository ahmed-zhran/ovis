/**
 * What the entry decides before anything else runs: its arguments, which core it joins, whether it may join it from
 * where it runs, and where it keeps its records. Pure: the environment and the arguments come in as values, and nothing
 * here imports the screen's heavy modules, so `-h`, `-V` and a bad argument are answered at once.
 */

import { join } from "node:path";
import { plainSession } from "../server/herdr-core/core-socket.ts";

export const USAGE = "usage: ovis tui [--session NAME] | -h | -V";

type Args =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; session: string | null }
  | { kind: "bad"; message: string };

export function parseArgs(argv: readonly string[]): Args {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) return { kind: "help" };
  if (argv.length === 1 && (argv[0] === "-V" || argv[0] === "--version")) return { kind: "version" };
  let session: string | null = null;
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const [flag, inline] = word.startsWith("--session=") ? ["--session", word.slice("--session=".length)] : [word, undefined];
    if (flag !== "--session") return { kind: "bad", message: `unknown argument ${JSON.stringify(word)}` };
    if (session !== null) return { kind: "bad", message: "--session is given twice" };
    const value = inline ?? argv[++at];
    if (value === undefined) return { kind: "bad", message: "--session needs a name" };
    if (plainSession(value) === null) return { kind: "bad", message: `--session ${JSON.stringify(value)} is not a session name (letters, digits, _ . -)` };
    session = value;
  }
  return { kind: "run", session };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The environment the core's socket is worked out from: the session is the flag, else HC_SESSION, else `default`; a
 * `--session` flag clears an inherited HC_SOCKET, so the flag names the core.
 */
export function targetEnv(env: Env, session: string | null): Record<string, string | undefined> {
  if (session === null) return { ...env };
  return { ...env, HC_SESSION: session, HC_SOCKET: undefined };
}

/**
 * Whether the screen would run inside a pane of the very core it joins (its picture would show itself): it runs in a
 * terminal of a core (HC_TERMINAL_ID) and the socket it would join is that core's (HC_TERMINAL_SOCKET, else the socket
 * its own environment names). `same` compares two socket paths (test-session.ts `sameSocket`).
 */
export function insideOwnCore(env: Env, target: string, envCore: string, same: (path: string) => string): boolean {
  if (!env["HC_TERMINAL_ID"]) return false;
  return same(env["HC_TERMINAL_SOCKET"] || envCore) === same(target);
}

/** The screen's state folder: OVIS_TUI_STATE_DIR, else `ovis-tui` under XDG_STATE_HOME, else under `~/.local/state`. */
export function stateFolder(env: Env, home: string): string {
  if (env["OVIS_TUI_STATE_DIR"]) return env["OVIS_TUI_STATE_DIR"];
  return join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "ovis-tui");
}
