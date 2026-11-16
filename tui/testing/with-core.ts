/**
 * Runs one command against a herdr-core of its own, and always cleans up:
 *
 *   bun tui/testing/with-core.ts [--no-core | --core-env <file>] [--limit <seconds>] -- <command...>
 *
 * Default: a real core (the hc OVIS_TEST_HC_BIN names, run by that absolute path) in a fresh folder
 * under TMPDIR, stopped afterwards. `--no-core`: the same environment, no core. `--core-env <file>`:
 * no core started; the command reaches the core the file's HC_SOCKET, HC_SESSION and XDG_* lines
 * name, which must lie under ~/.cache/ovis-tmp/ (a trial's demo core, never someone's own).
 *
 * The command gets the caller's environment without any HC_*, XDG_*, OVIS_* or HERDR_WEB_* name,
 * then the isolated core's (HC_SOCKET, HC_SESSION, XDG_*), a scratch HOME and HERDR_TEST_SESSION.
 * It runs in a process group of its own, which a signal or the time limit ends as a whole.
 *
 * Exit code: the command's (128 + n when a signal n ended it); 128 + n when the helper got signal
 * n; 124 when `--limit` (default 600 s) ran out; 2 for a wrong call; 125 when the core could not
 * be started or the cleanup had to kill or left something. Every path waits for the one cleanup.
 * stderr carries `root=<folder>` once the folder exists and `stopped pids=<a,b> killed=<..>` at the end.
 */

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { coreFolder, IsolatedCore, stoppedCleanly } from "./isolated-core.ts";

const USAGE = "usage: bun tui/testing/with-core.ts [--no-core | --core-env <file>] [--limit <seconds>] -- <command...>";
/** options a later row builds; named now so a call with them fails clearly */
const LATER = new Set(["--pty", "--size", "--keys", "--answer", "--dump"]);
const COMMAND_GRACE_MS = 5000;
const EXIT_USAGE = 2;
const EXIT_LIMIT = 124;
const EXIT_FAILED = 125;

class Refused extends Error {}

interface Options { mode: "core" | "no-core" | "core-env"; coreEnv: string | null; limitSeconds: number; command: string[] }

/**
 * Options come first; the first `--`, or the first word that is not an option, starts the command.
 * Bun itself drops a `--` that comes right after the script, so `-- sh -c x` arrives as `sh -c x`.
 */
function parse(args: string[]): Options {
  const options: Options = { mode: "core", coreEnv: null, limitSeconds: 600, command: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--" || !flag.startsWith("-")) {
      options.command = args.slice(flag === "--" ? i + 1 : i);
      break;
    }
    if (flag === "--no-core") options.mode = "no-core";
    else if (flag === "--core-env") {
      const file = args[++i];
      if (!file) throw new Refused("--core-env needs a file");
      options.mode = "core-env";
      options.coreEnv = file;
    } else if (flag === "--limit") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Refused("--limit needs a number of seconds above 0");
      options.limitSeconds = seconds;
    } else if (LATER.has(flag)) throw new Refused(`${flag} is not available yet`);
    else throw new Refused(`unknown option ${flag}; ${USAGE}`);
  }
  if (options.command.length === 0) throw new Refused(`no command after --; ${USAGE}`);
  return options;
}

/** The caller's environment without anything that names a core, a session folder or an Ovis server. */
function cleanedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !/^(HC_|XDG_|OVIS_|HERDR_WEB_)/.test(entry[0])));
}

/** HC_SOCKET, HC_SESSION and XDG_* from a `KEY=value` (or `export KEY='value'`) file, refused unless the socket is a trial's. */
function readCoreEnv(file: string): Record<string, string> {
  const named: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.trim().match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || !/^(HC_SOCKET|HC_SESSION|XDG_[A-Z_]+)$/.test(match[1]!)) continue;
    named[match[1]!] = match[2]!.replace(/^'(.*)'$|^"(.*)"$/, "$1$2");
  }
  const home = process.env["HOME"];
  const socket = named["HC_SOCKET"];
  if (!home || !socket) throw new Refused(`${file} names no HC_SOCKET`);
  // the folder through its links: a link under ovis-tmp to someone's core is not a trial's socket
  let folder = resolve(dirname(socket));
  try { folder = realpathSync(folder); } catch { /* not there: judged by its name */ }
  if (!`${folder}/`.startsWith(`${home}/.cache/ovis-tmp/`)) throw new Refused(`refused: ${socket} is not under ${home}/.cache/ovis-tmp/`);
  if (!named["HC_SESSION"] || named["HC_SESSION"] === "default") throw new Refused(`refused: ${file} names HC_SESSION ${named["HC_SESSION"] ?? "(none)"}`);
  return named;
}

async function main(): Promise<number> {
  let options: Options;
  let bin = "";
  let coreEnv: Record<string, string> = {};
  try {
    options = parse(process.argv.slice(2));
    if (options.mode === "core") {
      bin = process.env["OVIS_TEST_HC_BIN"] ?? "";
      if (!bin) throw new Refused("OVIS_TEST_HC_BIN is not set: name the hc to start, e.g. OVIS_TEST_HC_BIN=$HOME/.local/bin/hc");
    }
    if (options.mode === "core-env") coreEnv = readCoreEnv(options.coreEnv!);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    console.error(`with-core: ${error.message}`);
    return EXIT_USAGE;
  }

  /** the exit code: the first signal or the time limit decides it, else the command's end */
  let forced: number | null = null;
  let interrupted = false;
  let finishing: Promise<number> | null = null;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let core: IsolatedCore | null = null;
  let folder: { root: string; env: Record<string, string> } | null = null;

  const stopCommand = async (signal: NodeJS.Signals) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const group = (name: NodeJS.Signals) => { try { process.kill(-child!.pid, name); } catch { /* the group is gone */ } };
    group(signal);
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(COMMAND_GRACE_MS).then(() => false)])) return;
    group("SIGKILL");
    await child.exited;
  };

  /** The one cleanup: the command, then the core, then the folder. Every exit path awaits this promise. */
  const finish = (why: string, code: number, signal: NodeJS.Signals = "SIGTERM", interrupting = false): Promise<number> => {
    if (interrupting && !interrupted) {
      interrupted = true;
      forced = code;
    }
    forced ??= code;
    finishing ??= (async () => {
      console.error(`with-core: stopping (${why})`);
      await stopCommand(signal);
      if (!folder) return forced!;
      let failed = false;
      if (core) {
        const report = await core.stop();
        failed = !stoppedCleanly(report);
        console.error(`with-core: stopped pids=${report.pids.join(",")} killed=${report.killed.join(",")} alive=${report.alive.join(",")} socket=${report.socketGone ? "gone" : "left"} root=${report.rootGone ? "gone" : "left"}`);
        return failed ? EXIT_FAILED : forced!;
      }
      // no core of ours: a socket in our folder means the command started one there
      const socket = folder.env["HC_SOCKET"]!;
      if (existsSync(socket)) {
        failed = true;
        const named = process.env["OVIS_TEST_HC_BIN"];
        console.error(`with-core: the command left a core at ${socket}${named ? "" : " and no hc is named to stop it"}`);
        if (named) {
          const stray = new IsolatedCore(named, folder);
          await stray.adopt();
          await stray.stop();
        }
      } else rmSync(folder.root, { recursive: true, force: true });
      console.error(`with-core: stopped pids= killed= alive= socket=${existsSync(socket) ? "left" : "gone"} root=${existsSync(folder.root) ? "left" : "gone"}`);
      return failed ? EXIT_FAILED : forced!;
    })();
    return finishing;
  };

  // before anything exists to clean up, so no signal can end the helper around its cleanup
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(name, () => { void finish(name, 128 + constants.signals[name], name, true).then((code) => process.exit(code)); });
  }
  const limit = setTimeout(() => { void finish("time limit", EXIT_LIMIT, "SIGTERM", true).then((code) => process.exit(code)); }, options.limitSeconds * 1000);

  try {
    folder = coreFolder();
  } catch (error) {
    console.error(`with-core: ${error instanceof Error ? error.message : String(error)}`);
    clearTimeout(limit);
    return EXIT_USAGE;
  }
  console.error(`with-core: root=${folder.root}`);

  const env: Record<string, string> = { ...cleanedEnv(), ...folder.env, HERDR_TEST_SESSION: `with-core-${process.pid}` };
  if (options.mode === "core" && !finishing) {
    core = new IsolatedCore(bin, folder);
    try {
      await core.start();
      console.error(`with-core: started pids=${core.pids.join(",")}`);
    } catch (error) {
      if (!finishing) {
        console.error(`with-core: ${error instanceof Error ? error.message : String(error)}`);
        forced ??= EXIT_FAILED;
      }
    }
  } else if (options.mode === "core-env") {
    for (const name of Object.keys(env)) if (/^(HC_|XDG_)/.test(name)) delete env[name];
    Object.assign(env, coreEnv);
  }

  if (!finishing && forced === null) {
    try {
      child = Bun.spawn(options.command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true });
    } catch (error) {
      console.error(`with-core: cannot run ${options.command[0]}: ${error instanceof Error ? error.message : String(error)}`);
      forced ??= 127;
    }
    if (child) {
      await child.exited;
      const signal = child.signalCode as NodeJS.Signals | null;
      forced ??= signal ? 128 + (constants.signals[signal] ?? 0) : child.exitCode ?? 1;
    }
  }
  clearTimeout(limit);
  return finish("the command ended", forced ?? EXIT_FAILED);
}

process.exit(await main());
