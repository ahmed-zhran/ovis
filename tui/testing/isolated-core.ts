/**
 * A real herdr-core of a test's own: started in a fresh folder with `isolatedHcEnv`, its core and
 * holder pids recorded, and stopped so that a leak is reported, never hidden. Only pids recorded
 * here are ever signalled, so another run's core under the same TMPDIR is never touched.
 *
 * hc is always run by the absolute path it was given: the installed `hc` may be a guard script
 * that finds the real program beside itself, which still works under the scratch HOME.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedHcEnv, stopIsolatedCore } from "../../scripts/test-hc.ts";

/** the longest unix socket path the OS takes (sun_path less its terminating NUL) */
const SOCKET_PATH_MAX = 107;
/** how long a stopped core's processes may take to go before they are killed */
const STOP_WAIT_MS = 10_000;

/** What a stop found: whether anything had to be killed, and what is left. */
export interface StopReport {
  /** every core and holder pid recorded for this core */
  pids: number[];
  /** pids still alive after `hc server stop` and the wait, then killed */
  killed: number[];
  /** pids alive even after the kill */
  alive: number[];
  socketGone: boolean;
  rootGone: boolean;
}

/** A clean stop: nothing killed, nothing left. */
export const stoppedCleanly = (report: StopReport): boolean => report.killed.length === 0 && report.alive.length === 0 && report.socketGone && report.rootGone;

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fresh folder for one core, directly under `base` (TMPDIR, or the system's temp folder), and the
 * environment hc runs in there. Throws before anything runs when the environment could name another core.
 */
export function coreFolder(base = process.env["TMPDIR"] || tmpdir()): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(base, "ovis-hc-"));
  for (const sub of ["home", "state", "config", "run"]) mkdirSync(join(root, sub), { mode: 0o700 });
  const env = isolatedHcEnv(root);
  const inside = (name: string) => env[name]?.startsWith(`${root}/`) === true;
  const problem = !inside("HC_SOCKET") ? `HC_SOCKET ${env["HC_SOCKET"]} is outside ${root}`
    : !env["HC_SESSION"] || env["HC_SESSION"] === "default" ? `HC_SESSION is ${env["HC_SESSION"] ?? "unset"}`
    : !["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"].every(inside) ? `HOME or an XDG folder is outside ${root}`
    : Buffer.byteLength(env["HC_SOCKET"]!) > SOCKET_PATH_MAX ? `the socket path ${env["HC_SOCKET"]} is longer than ${SOCKET_PATH_MAX} bytes: use a shorter TMPDIR`
    : null;
  if (problem) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`not an isolated core: ${problem}`);
  }
  return { root, env };
}

export class IsolatedCore {
  readonly bin: string;
  readonly root: string;
  readonly env: Record<string, string>;
  /** the core's and every holder's pid, as `hc server status` named them */
  pids: number[] = [];
  /** `hc server start` succeeded: from then on a core runs here until the stop */
  private started = false;
  /** the start in flight, which a stop awaits before it judges whether a core runs */
  private starting: Promise<unknown> = Promise.resolve();
  /** hc commands still running: the stop waits for them, so none can start a core after it */
  private readonly running = new Set<Promise<unknown>>();
  private stopping: Promise<StopReport> | null = null;

  constructor(bin: string, folder = coreFolder()) {
    this.bin = resolve(bin);
    this.root = folder.root;
    this.env = folder.env;
  }

  get socket(): string {
    return this.env["HC_SOCKET"]!;
  }

  /** `hc server start`, then the pids it reports. Refused once the stop began. */
  async start(): Promise<void> {
    const starting = this.hc(["server", "start"]).then((started) => {
      if (started.exit === 0) this.started = true;
      return started;
    });
    this.starting = starting.catch(() => {});
    const started = await starting;
    if (started.exit !== 0) throw new Error(`hc server start exited ${started.exit}: ${started.err.trim()}`);
    await this.readPids();
  }

  /** A core something else started in this folder (its socket is there): its pids are read, so `stop` stops it. */
  async adopt(): Promise<void> {
    this.started = existsSync(this.socket);
    await this.readPids();
  }

  /**
   * Adds the pids `hc server status` names now. Asked only while this core is known to run (started,
   * and none of its recorded pids gone): in an environment with no core, `status` starts one.
   */
  async readPids(fromStop = false): Promise<void> {
    if (!this.started || !existsSync(this.socket) || (this.pids.length > 0 && !this.pids.every(pidAlive))) return;
    const status = await this.hc(["server", "status", "--json"], fromStop);
    if (status.exit !== 0) return;
    const parsed = JSON.parse(status.out) as { pid: number; holder?: { pid: number } | null; holders?: { pid: number }[] };
    this.pids = [...new Set([...this.pids, parsed.pid, ...(parsed.holder ? [parsed.holder.pid] : []), ...(parsed.holders ?? []).map((holder) => holder.pid)])];
  }

  /**
   * Stops the core, once: every caller (a signal, a time limit, the normal end) awaits the same
   * stop. The holder's pid is read again first (right after start hc names none), then
   * `hc server stop`, which returns while the core still runs, so the recorded pids are awaited;
   * what outlives the wait is killed by its pid and reported. The folder goes only once no pid is left.
   */
  stop(): Promise<StopReport> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<StopReport> {
    await this.starting;
    await Promise.allSettled([...this.running]);
    await this.readPids(true).catch(() => {});
    // `hc server stop` only for a core that runs: gone pids and the socket file are what tell it went
    if (this.pids.some(pidAlive)) await stopIsolatedCore(this.bin, this.env);
    await settle(() => !this.pids.some(pidAlive) && !existsSync(this.socket));
    const killed = this.pids.filter(pidAlive);
    for (const pid of killed) process.kill(pid, "SIGKILL");
    await settle(() => !killed.some(pidAlive));
    const alive = this.pids.filter(pidAlive);
    // a late hc child in a deleted folder would run whatever hc is first on PATH: the folder outlives every pid
    if (alive.length === 0) rmSync(this.root, { recursive: true, force: true });
    return { pids: this.pids, killed, alive, socketGone: !existsSync(this.socket), rootGone: !existsSync(this.root) };
  }

  /** an hc command in this core's environment alone */
  hc(args: string[], fromStop = false): Promise<{ exit: number; out: string; err: string }> {
    if (this.stopping && !fromStop) return Promise.reject(new Error(`no hc ${args.join(" ")} once the core is being stopped`));
    const child = Bun.spawn([this.bin, ...args], { env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, exit]) => ({ exit, out, err }));
    this.running.add(done);
    void done.finally(() => this.running.delete(done)).catch(() => {});
    return done;
  }
}

/** until `done()` holds or STOP_WAIT_MS passed: hc's core and holder are daemons, whose exit no event announces */
async function settle(done: () => boolean): Promise<void> {
  const deadline = Date.now() + STOP_WAIT_MS;
  while (!done() && Date.now() < deadline) await Bun.sleep(25);
}
