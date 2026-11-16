import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parseStty, runOnPty, runSupervised, stopAllPtyRuns } from "./pty.ts";

const TEST_MS = 30_000;
const ENV = { PATH: "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/", TMPDIR: process.env["TMPDIR"] ?? "", TERM: "xterm-256color" };

afterAll(() => stopAllPtyRuns(), TEST_MS);

/** A mark only the runs of one case carry in their environment. */
const mark = () => ({ PTY_TEST_MARK: crypto.randomUUID() });

/** Processes whose environment holds the mark: listed, never signalled. */
function marked(value: string): number[] {
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "latin1").includes(`PTY_TEST_MARK=${value}`) ? [Number(pid)] : [];
    } catch {
      return [];
    }
  });
}

describe("parseStty", () => {
  it("reads canonical mode, echo and signals from `stty -a`", () => {
    expect(parseStty("speed 38400 baud; rows 24; columns 80;\n-ignbrk brkint\nisig icanon iexten echo echoe").canonical).toBe(true);
    const raw = parseStty("isig -icanon iexten -echo echoe");
    expect([raw.canonical, raw.echo, raw.signals]).toEqual([false, false, true]);
  });
});

describe("runOnPty", () => {
  it("runs the command on a terminal of the asked size and reports its exit", async () => {
    const run = runOnPty({ command: ["sh", "-c", "test -t 0 && test -t 1 && stty size && exit 7"], env: ENV, cols: 33, rows: 7 });
    await run.until("7 33");
    expect(await run.exited).toBe(7);
  }, TEST_MS);

  it("ends a command at the deadline through the PTY host, rejects the wait and leaves nothing", async () => {
    const env = { ...ENV, ...mark() };
    const run = runOnPty({ command: ["sh", "-c", "printf started; exec sleep 30"], env, deadlineMs: 1500 });
    await run.until("started");
    await expect(run.until("never printed")).rejects.toThrow("deadline of 1500 ms");
    expect(await run.exited).toBeNull();
    expect(marked(env.PTY_TEST_MARK)).toEqual([]);
  }, TEST_MS);

  it("stop hangs the command up and leaves nothing", async () => {
    const env = { ...ENV, ...mark() };
    const run = runOnPty({ command: ["sh", "-c", "printf started; exec sleep 30"], env });
    await run.until("started");
    await run.stop();
    expect(marked(env.PTY_TEST_MARK)).toEqual([]);
  }, TEST_MS);

  it("a wait for output that never comes rejects when the command ends", async () => {
    const run = runOnPty({ command: ["sh", "-c", "printf done"], env: ENV });
    await expect(run.until("other")).rejects.toThrow("the command ended");
    expect(await run.exited).toBe(0);
  }, TEST_MS);
});

describe("runSupervised", () => {
  it("signals the entry through the supervisor and reports its end with the termios around it", async () => {
    const env = { ...ENV, ...mark() };
    const script = 'process.on("SIGTERM", () => { process.stdout.write("TERM\\n"); process.exit(5); }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);';
    const run = runSupervised({ entry: [process.execPath, "-e", script], env });
    await run.until("ready");
    run.signal("SIGTERM");
    const end = await run.ended;
    expect({ code: end.code, signal: end.signal, before: end.before.canonical, after: end.after?.canonical }).toEqual({ code: 5, signal: null, before: true, after: true });
    expect(run.output()).toContain("TERM");
    await run.exited;
    expect(marked(env.PTY_TEST_MARK)).toEqual([]);
  }, TEST_MS);

  it("reads the termios while the entry runs, and names a signal that ended it", async () => {
    const run = runSupervised({ entry: ["sh", "-c", "stty -icanon -echo; printf ready; exec sleep 30"], env: ENV });
    await run.until("ready");
    const during = await run.stty();
    expect([during.canonical, during.echo]).toEqual([false, false]);
    run.signal("SIGINT");
    const end = await run.ended;
    expect([end.code, end.signal]).toEqual([130, "SIGINT"]);
  }, TEST_MS);
});
