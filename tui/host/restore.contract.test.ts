import { afterAll, describe, expect, it } from "bun:test";
import { constants } from "node:os";
import { join } from "node:path";
import { runSupervised, stopAllPtyRuns, type SupervisedRun } from "../testing/pty.ts";

/**
 * `restore`: the real host (tui/host/unix.ts) in a fixture entry on a real pseudo-terminal that this
 * test creates (server/pty/session.ts: the Rust PTY host, else the Node sidecar). The entry runs
 * under the harness's supervisor, which started it and alone signals it, through its own handle.
 * After a normal exit, a thrown error and each signal, the terminal is cooked again and the last
 * bytes written are the exact undo of the setup, written once.
 */
const FIXTURE = join(import.meta.dir, "..", "testing", "host-fixture.ts");
const TEST_MS = 30_000;
const ESC = "\x1b";
const ST = `${ESC}\\`;
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1006h${ESC}[>1u`;
const LEAVE = `${ESC}[<u${ESC}[?1006l${ESC}[?1002l${ESC}[?2004l${ESC}[?1004l${ESC}[?25h${ESC}[?1049l`;
const AGAIN = `${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1006h${ESC}[=1;1u`;
const PROBE = `${ESC}[?u${ESC}[?2026$p${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}]12;?${ST}${ESC}[16t${ESC}[c`;
const ANSWER = `${ESC}[?1u${ESC}[?2026;2$y${ESC}]10;rgb:1111/2222/3333${ST}${ESC}]11;rgb:ffff/ffff/ffff${ST}${ESC}]12;rgb:0000/0000/0000${ST}${ESC}[6;18;9t${ESC}[?62;22c`;

const BASE_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: process.env["HOME"] ?? "/",
  TMPDIR: process.env["TMPDIR"] ?? "",
  TERM: "xterm-256color",
};

afterAll(() => stopAllPtyRuns(), TEST_MS);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
// the fixture ends its report lines with CR LF; the tty's output processing (left on by Bun's raw
// mode) may turn the LF into CR LF again, so the tests match a line up to its first CR

function start(mode: "exit" | "process-exit" | "throw" | "wait", env: Record<string, string> = {}): SupervisedRun {
  return runSupervised({ entry: [process.execPath, FIXTURE, mode], env: { ...BASE_ENV, ...env }, cols: 80, rows: 24 });
}

/** Starts the entry, answers its probe at once, and waits until it says READY. */
async function ready(mode: Parameters<typeof start>[0], env: Record<string, string> = {}): Promise<SupervisedRun> {
  const run = start(mode, env);
  await run.until(PROBE);
  run.type(ANSWER);
  await run.until("READY\r");
  return run;
}

function probeLine(output: string): { ms: number; result: Record<string, unknown> } {
  const match = output.match(/PROBE (\d+) (\{[^\r]*\})\r/);
  if (!match) throw new Error(`no PROBE line in ${JSON.stringify(output)}`);
  return { ms: Number(match[1]), result: JSON.parse(match[2]!) as Record<string, unknown> };
}

function inputLines(output: string): string[] {
  return [...output.matchAll(/INPUT ([^\r]*)\r/g)].map((match) => match[1]!);
}

/** The terminal after the entry ended: cooked again, and the leave sequence last and once. */
async function expectRestored(run: SupervisedRun, code: number | number[]) {
  const end = await run.ended;
  const output = run.output();
  const codes = Array.isArray(code) ? code : [code];
  expect({ code: codes.includes(end.code) ? codes[0] : end.code, before: [end.before.canonical, end.before.echo], after: [end.after?.canonical, end.after?.echo] })
    .toEqual({ code: codes[0], before: [true, true], after: [true, true] });
  expect(output.startsWith(ENTER + PROBE)).toBe(true);
  expect(count(output, ENTER)).toBe(1);
  expect(count(output, LEAVE)).toBe(1);
  expect(output.endsWith(LEAVE)).toBe(true);
  return end;
}

describe("restore", () => {
  it("after a normal exit (leave, then the loop runs dry)", async () => {
    const run = await ready("exit");
    const during = await run.stty();
    expect([during.canonical, during.echo, during.signals]).toEqual([false, false, false]);
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);

  it("after process.exit with no leave (the exit hook)", async () => {
    const run = await ready("process-exit");
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);

  it("after a thrown error", async () => {
    const run = await ready("throw");
    run.type("q");
    const end = await expectRestored(run, 1);
    expect(end.stderr).toContain("fixture: thrown on purpose");
  }, TEST_MS);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`after ${signal}`, async () => {
      const run = await ready("wait");
      run.signal(signal);
      await expectRestored(run, 128 + constants.signals[signal]);
    }, TEST_MS);
  }

  it("after the pseudo-terminal hangs up (the PTY host ends the session)", async () => {
    const run = await ready("wait");
    await run.stop();
    const end = await run.ended;
    expect(end.code).toBe(129);
    expect(count(run.output(), LEAVE)).toBeLessThanOrEqual(1);
    if (end.after) expect([end.after.canonical, end.after.echo]).toEqual([true, true]);
  }, TEST_MS);

  it("two signals in a row: restored once, and one of them decides the exit code", async () => {
    // both are pending before the handler runs, and Linux hands over the lower number first: which
    // one the host sees first is the kernel's choice (tui/host/host.test.ts pins first-wins in order)
    const run = await ready("wait");
    run.signal("SIGTERM");
    run.signal("SIGINT");
    await expectRestored(run, [143, 130]);
  }, TEST_MS);

  it("a signal while the probe waits for replies", async () => {
    const run = start("wait");
    await run.until(PROBE);
    run.signal("SIGTERM");
    await expectRestored(run, 143);
    expect(run.output()).not.toContain("PROBE ");
  }, TEST_MS);

  it("a signal as the entry starts: either nothing was entered, or all of it is undone once", async () => {
    const run = start("wait");
    await run.started;
    run.signal("SIGTERM");
    const end = await run.ended;
    const output = run.output();
    expect(end.code).toBe(143);
    expect([end.after?.canonical, end.after?.echo]).toEqual([true, true]);
    expect(count(output, LEAVE)).toBe(count(output, ENTER));
    if (output.includes(ENTER)) expect(output.endsWith(LEAVE)).toBe(true);
  }, TEST_MS);
});

describe("the start probe on a pseudo-terminal", () => {
  it("ends at 500 ms when the host answers nothing", async () => {
    const run = start("exit");
    await run.until("READY\r");
    const { ms, result } = probeLine(run.output());
    expect(ms).toBeGreaterThanOrEqual(490);
    expect(ms).toBeLessThan(2000);
    expect(result).toMatchObject({ answered: false, background: null, theme: null });
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);

  it("ends at the DA1 reply when the host answers everything, and reads light from OSC 11", async () => {
    const run = await ready("exit");
    const { ms, result } = probeLine(run.output());
    expect(ms).toBeLessThan(490);
    expect(result).toEqual({
      answered: true, kittyFlags: 1, syncOutput: true, foreground: [17, 34, 51], background: [255, 255, 255], cursorColor: [0, 0, 0],
      cellPixels: { width: 9, height: 18 }, deviceAttributes: [62, 22], theme: "light",
    });
    run.type("q");
    await expectRestored(run, 0);
    expect(inputLines(run.output())).toEqual(["1 71"]);
  }, TEST_MS);

  for (const [what, answer] of [
    ["late replies", ANSWER],
    ["garbage", `garbage${ESC}[?zz${ESC}]11;`],
    ["a partial reply", `${ESC}]11;rgb:ff`],
    ["1 MiB of bytes", "A".repeat(1024 * 1024)],
  ] as const) {
    it(`swallows ${what}: the probe ends at its limit and only the typed key is input`, async () => {
      const run = start("exit");
      await run.until(PROBE);
      if (what !== "late replies") run.type(answer);
      await run.until("READY\r");
      expect(probeLine(run.output()).result).toMatchObject({ answered: false });
      if (what === "late replies") run.type(answer);
      run.type("x");
      await run.until("INPUT 1 78\r");
      run.type("q");
      await expectRestored(run, 0);
      expect(inputLines(run.output())).toEqual(["1 78", "1 71"]);
    }, TEST_MS);
  }
});

describe("colour depth and modes on a pseudo-terminal", () => {
  for (const [colorterm, depth] of [["truecolor", "truecolor"], ["24bit", "truecolor"], [null, "256"]] as const) {
    it(`COLORTERM=${colorterm ?? "(unset)"} gives ${depth}`, async () => {
      const run = await ready("exit", colorterm ? { COLORTERM: colorterm } : {});
      expect(run.output()).toContain(`DEPTH ${depth}\r`);
      run.type("q");
      await expectRestored(run, 0);
    }, TEST_MS);
  }

  it("modes again after resize and focus-in", async () => {
    const run = await ready("exit");
    run.resize(100, 30);
    await run.until("RESIZE 100x30\r");
    const afterResize = run.output();
    expect(afterResize.slice(afterResize.indexOf("READY\r"))).toContain(`${AGAIN}RESIZE 100x30\r`);
    run.type(`${ESC}[I`);
    await run.until("INPUT 3 1b5b49\r");
    expect(count(run.output(), AGAIN)).toBe(2);
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);
});

describe("not a terminal", () => {
  it("nothing is entered when stdin or stdout is not a terminal", async () => {
    // a plain child with pipes: the fixture refuses before writing anything
    const child = Bun.spawn([process.execPath, FIXTURE, "exit"], { env: BASE_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, out, err }).toEqual({ code: 3, out: "", err: "host-fixture: not a terminal\n" });
  }, TEST_MS);
});
