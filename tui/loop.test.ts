import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA } from "../server/herdr-core/connection.ts";
import { CREDIT_WINDOW, FakeHcCore } from "../server/herdr-core/core.fake.ts";
import { OVIS_LAYOUT_DOC } from "../server/herdr-core/layout-doc.ts";
import { startLoop } from "./loop.ts";
import { FRAME_PASS_MS, HOLD_RELEASE_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, PASTE_LIMIT_BYTES, QUIT_BOUND_MS } from "./model/deadlines.ts";
import { demo } from "./testing/fixtures/demo.ts";
import { place } from "./testing/fixtures/fixture.ts";
import { SCALE_LARGEST_TAB, SCALE_TERMINALS, SCALE_WORKSPACES, scale } from "./testing/fixtures/scale.ts";
import { HeadlessHost } from "./testing/headless-host.ts";
import { ManualClock, Run, type RunOptions } from "./testing/run.ts";

/** every test drives the loop on the injected clock; only the socket's own turns are real */
const TEST_MS = 120_000;
const SOAK_MS = 600_000;
/** the most the screen's own heap may grow over the soak's last 480 simulated seconds (measured: well under 1 MB) */
const OWN_HEAP_GROWTH_BYTES = 2 * 1024 * 1024;
/** the link's code once its line was cut and a retry found no core listening (tui/core/link.ts) */
const OFFLINE_CODE = "no_core";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function start(options: RunOptions): Promise<Run> {
  const run = await Run.start(options);
  runs.push(run);
  return run;
}

/** A core with `count` terminals in one tab (split side by side), the first zoomed when `zoomed`. */
function oneTab(count: number, zoomed = false): FakeHcCore {
  const core = new FakeHcCore();
  const panes: string[] = [];
  for (let n = 0; n < count; n++) panes.push(place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, `pane ${n}\r\n`));
  if (zoomed) {
    const root = panes.slice(1).reduce<unknown>((tree, leaf) => ({ split: "right", ratio: 0.5, first: tree, second: { leaf } }), { leaf: panes[0] });
    core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: panes[0] }] }] }, version: 1 });
  }
  return core;
}

const channelOf = (run: Run, terminal: string): number => run.core.viewers(terminal).at(-1)!.channel;
const framesOf = (run: Run, kind: number, from = 0) => run.sent.slice(from).filter((frame) => frame.kind === kind && frame.channel !== 0);
const megabyte = (fill: string) => fill.repeat(1024 * 1024 / fill.length);

describe("the loop", () => {
  it("nothing in, nothing out: an idle screen writes nothing and keeps only the line's silence watch", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1_000);
    const written = run.host.bytes().length;
    // the event stream credits hc's heartbeats back (the link's flow control): the panes' channels carry nothing
    const panes = new Set(run.core.viewers().map((viewer) => viewer.channel));
    const frames = run.sent.filter((frame) => panes.has(frame.channel)).length;
    await run.advance(10 * 60_000);
    expect(run.host.bytes().length).toBe(written);
    expect(run.sent.filter((frame) => panes.has(frame.channel)).length).toBe(frames);
    expect(run.clock.armed()).toBe(1);
    expect(run.loop.report().due).toEqual(["link:silence"]);
    expect(run.clock.maxArmed).toBe(1);
  }, TEST_MS);

  it("nothing in, nothing out: with no core it ends at once, with no timer and nothing written", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-"));
    try {
      const host = new HeadlessHost();
      const clock = new ManualClock();
      const loop = startLoop({ host, clock, socket: join(folder, "none.sock"), keys: undefined });
      const end = await loop.done;
      expect(end).toMatchObject({ kind: "no_core", code: "no_core" });
      expect(clock.armed()).toBe(0);
      expect(clock.maxArmed).toBe(0);
      expect(host.log()).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("rate: a pane that never stops writing gets a frame pass at most every 8 ms", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const from = run.writeTimes.length;
    const passes = run.loop.report().passes;
    for (let n = 0; n < 200; n++) {
      run.core.program("t1").output(`line ${n}\r\n`);
      await run.advance(1);
    }
    const times = run.writeTimes.slice(from);
    expect(times.length).toBeGreaterThan(10);
    for (let at = 1; at < times.length; at++) expect(times[at]! - times[at - 1]!).toBeGreaterThanOrEqual(FRAME_PASS_MS);
    expect(run.loop.report().passes - passes).toBeLessThanOrEqual(Math.ceil(200 / FRAME_PASS_MS) + 1);
    expect(run.clock.maxArmed).toBe(1);
    // the row's numbers: a pass at most every 8 ms, 512 KiB of credit a pass, quit within 2 s
    expect([FRAME_PASS_MS, PASS_CREDIT_BYTES, QUIT_BOUND_MS]).toEqual([8, 512 * 1024, 2_000]);
  }, TEST_MS);

  it("credit follows passes: none between passes, none past the window, then at most 512 KiB a pass", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const credited = run.core.credited("t1");
    const received = run.core.dataTo("t1").join("").length;
    run.core.program("t1").output(megabyte("abcdefgh\r\n"));
    await run.settle();
    expect(run.core.credited("t1")).toBe(credited);
    expect(run.core.dataTo("t1").join("").length - received).toBeLessThanOrEqual(CREDIT_WINDOW);
    for (let pass = 0; pass < 8; pass++) {
      const before = run.core.credited("t1");
      const sent = run.sent.length;
      await run.advance(FRAME_PASS_MS);
      expect(framesOf(run, FRAME_CREDIT, sent).length).toBeLessThanOrEqual(1);
      expect(run.core.credited("t1") - before).toBeLessThanOrEqual(PASS_CREDIT_BYTES);
    }
    expect(run.core.credited("t1")).toBeGreaterThan(credited);
  }, TEST_MS);

  it("credit follows passes: the focused pane first, and no pass hands out more than 512 KiB", async () => {
    const run = await start({ core: oneTab(3) });
    await run.live();
    // the LAST pane in tree order has focus, so tree order alone would credit another first
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t3" }, at: run.clock.current });
    await run.advance(1);
    for (const terminal of ["t1", "t2", "t3"]) run.core.program(terminal).output(megabyte("0123456789abcde\n"));
    await run.settle();
    const focused = channelOf(run, "t3");
    const sent = run.sent.length;
    await run.advance(FRAME_PASS_MS);
    const credits = framesOf(run, FRAME_CREDIT, sent);
    expect(credits[0]?.channel).toBe(focused);
    expect(credits.reduce((sum, frame) => sum + Buffer.from(frame.payload).readUInt32LE(0), 0)).toBeLessThanOrEqual(PASS_CREDIT_BYTES);
    expect(credits.length).toBeLessThan(3);
  }, TEST_MS);

  it("credit follows passes: a pane covered by a zoom gets none, and none leaves while the frame's write is in progress", async () => {
    const run = await start({ core: oneTab(2, true) });
    await run.live();
    expect(run.loop.panes.view("t2")?.covered).toBe(true);
    run.core.program("t2").output(megabyte("covered!\r\n"));
    run.core.program("t1").output("shown\r\n");
    await run.advance(100);
    expect(run.core.credited("t2")).toBe(0);
    let during = -1;
    const before = run.core.credited("t1");
    run.host.duringNextWrite(() => { during = framesOf(run, FRAME_CREDIT).length; });
    const credits = framesOf(run, FRAME_CREDIT).length;
    run.core.program("t1").output("more\r\n");
    await run.advance(FRAME_PASS_MS * 2);
    expect(during).toBe(credits);
    expect(run.core.credited("t1")).toBeGreaterThan(before);
  }, TEST_MS);

  it("hold: a pane inside its program's synchronized update keeps its picture until the hold ends or 1 s passed; others draw; credit flows", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const credited = run.core.credited("t1");
    run.core.program("t1").output("\x1b[?2026hHELD-A");
    run.core.program("t2").output("FREE-B");
    await run.advance(50);
    expect(run.grid().join("\n")).toContain("FREE-B");
    expect(run.grid().join("\n")).not.toContain("HELD-A");
    expect(run.core.credited("t1")).toBeGreaterThan(credited);
    await run.advance(HOLD_RELEASE_MS);
    expect(run.grid().join("\n")).toContain("HELD-A");
    run.core.program("t2").output("\x1b[?2026hHELD-B");
    await run.advance(50);
    expect(run.grid().join("\n")).not.toContain("HELD-B");
    run.core.program("t2").output("\x1b[?2026l");
    await run.advance(50);
    expect(run.grid().join("\n")).toContain("HELD-B");
  }, TEST_MS);

  it("a paste over the limit is refused; the input layer is reset only once no read brought an event for the named wait", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.settle();
    expect(run.loop.model().notices.map((notice) => notice.code)).toContain("paste_refused");
    // a slow paste keeps arriving, each piece within the wait: none of it is typed as keys
    for (let piece = 0; piece < 3; piece++) {
      await run.advance(PASTE_ABANDON_MS - 500);
      run.type("bbbb");
      await run.settle();
    }
    await run.advance(PASTE_ABANDON_MS - 1);
    expect(run.loop.report().actions).not.toContain("paste_reset");
    expect(run.core.program("t1").receivedHex()).toBe("");
    await run.advance(1);
    expect(run.loop.report().actions).toContain("paste_reset");
    await run.keys("k");
    await run.advance(20);
    expect(run.core.program("t1").receivedHex()).toBe(Buffer.from("k").toString("hex"));
  }, TEST_MS);

  it("the loop draws for the host's colour depth: an RGB cell leaves as RGB on a truecolour host, as a palette colour on a 256-colour one", async () => {
    for (const [colorTerm, written, never] of [["truecolor", "38;2;95;135;175", "38;5;67"], ["", "38;5;67", "38;2;"]] as const) {
      const run = await start({ fixture: demo, colorTerm });
      await run.live();
      const from = run.host.output().length;
      run.core.program("t1").output("\x1b[38;2;95;135;175mRGB-CELL\x1b[0m\r\n");
      await run.advance(50);
      const frame = run.host.output().slice(from);
      expect([colorTerm, frame.includes("RGB-CELL"), frame.includes(written), frame.includes(never)]).toEqual([colorTerm, true, true, false]);
    }
  }, TEST_MS);

  it("quit detaches: CLOSE on every channel, no terminal killed or removed, the terminal given back", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,q");
    await run.advance(100);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    const closes = run.core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE);
    // both panes of the shown tab and the event stream
    expect(closes.length).toBe(3);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
    for (const terminal of ["t1", "t2", "t3", "t4"]) expect(run.core.terminal(terminal).state).toBe("live");
    expect(run.host.log().at(-1)).toBe("raw off");
  }, TEST_MS);

  it("quit detaches within its bound when the core never answers", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    await run.keys("ctrl+b,q");
    await run.advance(QUIT_BOUND_MS - 100);
    expect(ended).toBe(false);
    await run.advance(200);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBeGreaterThanOrEqual(3);
  }, TEST_MS);

  it("hang-up exits: CLOSE on every channel, the process ends within its bound, nothing is written after", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    // a frame pass is owed at the hang-up, and the core answers no CLOSE: the end comes by the bound, still drawing nothing
    run.core.program("t1").output("drawn\r\n");
    await run.settle();
    run.core.program("t1").output("owed\r\n");
    await run.settle();
    run.muted = true;
    run.host.hangUp();
    const attempts = run.host.writeAttempts();
    const writes = run.loop.report().writes;
    await run.advance(3_000);
    expect(await run.loop.done).toEqual({ kind: "gone", why: "hangup" });
    expect(run.host.exitCode).toBe(129);
    expect(run.host.writeAttempts()).toBe(attempts);
    expect(run.loop.report().writes).toBe(writes);
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBe(3);
  }, TEST_MS);

  it("flood does not delay input: a key typed into one pane leaves in its read's turn while another pane floods", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    run.core.program("t1").output(megabyte("flooding\r\n"));
    await run.advance(1);
    const passes = run.loop.report().passes;
    const sent = run.sent.length;
    run.type("k");
    const data = framesOf(run, FRAME_DATA, sent);
    expect(data.map((frame) => [frame.channel, Buffer.from(frame.payload).toString()])).toEqual([[channelOf(run, "t2"), "k"]]);
    expect(run.loop.report().passes).toBe(passes);
  }, TEST_MS);

  it("directional focus: the prefix and l move to the pane on that side of the drawn tree, and the next key goes there", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,l");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
    await run.keys("ctrl+b,l");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
    await run.keys("z");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("z").toString("hex")]);
    await run.keys("ctrl+b,h");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
  }, TEST_MS);

  it("scale: 200 terminals in 50 workspaces draw a frame, and only the shown tab's 16 panes are attached", async () => {
    const run = await start({ fixture: scale });
    await run.live(20_000);
    expect(run.loop.model().world.workspaces.length).toBe(SCALE_WORKSPACES);
    expect(run.loop.model().world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).length).toBe(SCALE_TERMINALS);
    const viewers = run.core.viewers();
    expect(viewers.length).toBe(SCALE_LARGEST_TAB);
    expect(new Set(viewers.map((viewer) => viewer.terminal)).size).toBe(SCALE_LARGEST_TAB);
    expect(run.loop.report().writes).toBeGreaterThan(0);
    expect(run.grid().join("\n")).toContain("|pane 0 ");
  }, TEST_MS);
});

describe("the whole screen", () => {
  it("shows the demo's panes with their Korean text, and typed keys reach the focused pane once and in order while another floods", async () => {
    const run = await start({ fixture: demo, cols: 120, rows: 40 });
    await run.live();
    const grid = run.grid();
    expect(grid.some((row) => row.includes("안녕하세요, 헤르더 세계"))).toBe(true);
    expect(grid.some((row) => row.includes("README.md  한글.txt"))).toBe(true);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    const typed = "echo 한글 ok\r";
    for (const char of typed) {
      run.core.program("t1").output(`flood ${char}\r\n`.repeat(200));
      await run.keys(char);
    }
    await run.advance(50);
    expect(Buffer.from(run.core.program("t2").receivedHex(), "hex").toString("utf8")).toBe(typed);
    expect(run.core.program("t1").receivedHex()).toBe("");
  }, TEST_MS);

  it("after the core's line is cut: offline, nothing typed is sent, and it recovers by itself with nothing replayed", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("a");
    await run.advance(20);
    const before = run.core.program("t1").receivedHex();
    await run.cutLine();
    await run.advance(1_000);
    expect(run.loop.link.state.kind).toBe("Offline");
    // the offline state as data, for the chrome (row 26): the link's kind and stable code
    expect(run.loop.report().link).toEqual({ kind: "Offline", code: OFFLINE_CODE });
    expect(run.loop.panes.views().map((view) => view.state.kind)).toEqual(["Waiting", "Waiting"]);
    await run.keys("l,o,s,t,enter");
    const lines = run.core.viewers().length;
    expect(lines).toBe(0);
    await run.listen();
    await run.advance(10_000);
    expect(run.loop.link.state).toMatchObject({ kind: "Online", epoch: 2 });
    await run.live();
    expect(run.core.program("t1").receivedHex()).toBe(before);
    const viewers = run.core.viewers();
    expect(viewers.map((viewer) => viewer.terminal).sort()).toEqual(["t1", "t2"]);
    expect(new Set(viewers.map((viewer) => viewer.line)).size).toBe(1);
    expect(run.clock.armed()).toBeLessThanOrEqual(1);
    expect(run.clock.maxArmed).toBe(1);
  }, TEST_MS);

  it("soak: 10 simulated minutes of output, input, resizes, tab switches and two reconnects", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    /** the heap after GC with the test tooling's kept lists emptied: what the screen itself holds */
    const ownHeap = () => {
      run.forget();
      Bun.gc(true);
      return process.memoryUsage().heapUsed;
    };
    const memory = { start: process.memoryUsage().rss, middle: 0, end: 0, heapMiddle: 0, heapEnd: 0 };
    const sizes = [[120, 40], [100, 30], [80, 24], [140, 45]] as const;
    for (let second = 0; second < 600; second++) {
      for (const terminal of ["t1", "t2", "t3", "t4"]) run.core.program(terminal).output(`s${second} ${terminal} 안녕 ${"x".repeat(second % 50)}\r\n`);
      if (second % 7 === 0) await run.keys(`k${second % 10}`);
      if (second % 50 === 25) {
        const [cols, rows] = sizes[(second / 50 | 0) % sizes.length]!;
        run.host.resize(cols, rows);
      }
      if (second % 30 === 15) run.loop.dispatch({ type: "action", action: "next_tab", at: run.clock.current });
      if (second % 90 === 45) run.loop.dispatch({ type: "action", action: "next_workspace", at: run.clock.current });
      if (second === 200 || second === 400) {
        await run.cutLine();
        await run.advance(2_000);
        await run.listen();
      }
      await run.advance(1_000);
      if (second === 120) {
        memory.heapMiddle = ownHeap();
        memory.middle = process.memoryUsage().rss;
      }
    }
    memory.heapEnd = ownHeap();
    memory.end = process.memoryUsage().rss;
    // the same place a fresh screen opens: the first workspace's first tab, at the first size
    run.loop.dispatch({ type: "select", target: { kind: "tab", id: "t-main" }, at: run.clock.current });
    run.host.resize(120, 40);
    await run.advance(5_000);
    await run.live();
    await run.advance(60_000);
    process.stderr.write(`soak memory: ${JSON.stringify(memory)} passes=${run.loop.report().passes} maxArmed=${run.clock.maxArmed}\n`);
    expect(run.clock.maxArmed).toBe(1);
    expect(run.clock.armed()).toBe(1);
    expect(run.loop.report().due).toEqual(["link:silence"]);
    expect(run.loop.report().actions.some((code) => code.startsWith("end:") || code === "crash")).toBe(false);
    // the screen's own heap over the last 480 simulated seconds of output, input, resizes and a reconnect
    expect(memory.heapEnd - memory.heapMiddle).toBeLessThan(OWN_HEAP_GROWTH_BYTES);
    const fresh = await start({ core: run.core, cols: 120, rows: 40 });
    await fresh.live();
    expect(run.grid()).toEqual(fresh.grid());
  }, SOAK_MS);
});
