import { afterEach, describe, expect, it } from "bun:test";
import { FRAME_CLOSE, FRAME_DATA, FRAME_FACTS, FRAME_FOCUS, FRAME_RESIZE } from "../../server/herdr-core/connection.ts";
import { type FakeCoreOptions, FakeHcCore, FEATURES_0_1_17, HEADLESS } from "../../server/herdr-core/core.fake.ts";
import { REATTACH_SETTLE_MS } from "../model/deadlines.ts";
import { type Screen, Stage } from "../testing/pane-harness.ts";
import { attachSent, attachSize, clipTop, detached, newPaneSize, type PaneSize, reattachDue, rectangleChanged, replied, sizedBy, sizeTold, took } from "./size.ts";

// The size rules of the pane machine on the fake core, which carries herdr-core's own size rule as
// probe c measured it: the eleven cases of the design (UB Q3) as row 23 narrows them (only the
// user's input in a pane sends a RESIZE or a FOCUS), and the cases row 23 adds.

const stages: Stage[] = [];
afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.close();
});

async function scene(options: FakeCoreOptions & { terminals?: number } = {}) {
  const core = new FakeHcCore(options);
  const stage = new Stage(core);
  stages.push(stage);
  const terminals = Array.from({ length: options.terminals ?? 1 }, () => core.spawn().address);
  const screen = await stage.screen();
  screen.panes.focus(terminals[0]!);
  return { core, stage, screen, t: terminals[0]!, terminals };
}

const OLD = { version: "0.1.17", features: FEATURES_0_1_17 } as const;
const SIZE_FRAMES = [FRAME_RESIZE, FRAME_FOCUS, FRAME_FACTS, FRAME_DATA];
/** the attaches, CLOSE frames, RESIZE frames and `size` events the core has seen so far */
const traffic = (core: FakeHcCore) => ({
  attaches: core.calls().filter((call) => call.method === "terminal.attach").length,
  closes: core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE).length,
  resizes: core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_RESIZE).length,
  sizes: core.log.filter((entry) => entry.what === "event" && entry.type === "size").length,
});

describe("the size rules of a pane", () => {
  it("attach never stamps", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 3 });
    await stage.live(screen, [terminals[0]!, 80, 24], [terminals[1]!, 60, 20], [terminals[2]!, 40, 10]);
    screen.show([terminals[0]!, 90, 30], [terminals[1]!, 60, 20], [terminals[2]!, 40, 10]);
    await stage.advance(REATTACH_SETTLE_MS);
    const attaches = core.calls().filter((call) => call.method === "terminal.attach").map((call) => call.params);
    expect(attaches.length).toBe(4);
    expect(attaches.map((params) => [params["resumed"], "observe" in params, "resize_notifications" in params])).toEqual(Array(4).fill([true, false, false]));
    expect(core.viewers().map((viewer) => [viewer.stamped, viewer.observe])).toEqual(Array(3).fill([false, false]));
  });

  it("alone fits", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 3 });
    await stage.live(screen, [terminals[0]!, 100, 50], [terminals[1]!, 50, 25], [terminals[2]!, 49, 24]);
    expect(terminals.map((terminal) => core.size(terminal))).toEqual(["100x50", "50x25", "49x24"]);
    expect(terminals.map((terminal) => screen.sent(terminal))).toEqual([[], [], []]);
    expect(terminals.map((terminal) => screen.view(terminal).sizedBy)).toEqual([null, null, null]);
  });

  it("beside an active viewer", async () => {
    const { core, stage, screen, terminals: [, t2] } = await scene({ terminals: 3 });
    const browser = stage.rival();
    await browser.attach(t2!, 120, 40);
    browser.type("x");
    await stage.live(screen, [t2!, 80, 24]);
    core.program(t2!).output("\x1b[?1004h");
    await stage.settle();
    // the screen is resized and the focus passes over the pane: the terminal is still the browser's
    screen.show([t2!, 70, 20]);
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    screen.panes.focus(t2!);
    screen.panes.focus(null);
    await stage.advance(10_000);
    expect(core.size(t2!)).toBe("120x40");
    expect(screen.sent(t2!, SIZE_FRAMES)).toEqual([]);
    // drawn clipped, from the real grid, with the notice
    expect([screen.state(t2!), screen.view(t2!).sizedBy, screen.view(t2!).actual]).toEqual(["Live", { cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);
    expect([screen.emulators.at(-1)!.cols, screen.emulators.at(-1)!.rows]).toEqual([120, 40]);
    expect(core.program(t2!).sizes).toEqual(["200x120", "120x40"]);
  });

  it("host resize of a pane", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    // the window is dragged: five rectangles in 100 ms
    for (let step = 1; step <= 5; step++) {
      screen.show([t, 80 + step, 24]);
      await stage.advance(25);
    }
    expect([screen.attaches.length, screen.sent(t), core.size(t)]).toEqual([1, [], "80x24"]);
    await stage.advance(REATTACH_SETTLE_MS - 26);
    expect(screen.attaches.length).toBe(1);
    await stage.advance(1);
    await stage.pass();
    // zero RESIZE and one reattach, with the last rectangle
    expect([screen.state(t), screen.did(t), screen.sent(t), core.size(t)]).toEqual(["Live", ["CLOSE"], [], "85x24"]);
    expect(screen.asked(t).map((params) => `${String(params["cols"])}x${String(params["rows"])}`)).toEqual(["80x24", "85x24"]);
    await stage.advance(10_000);
    expect(screen.attaches.length).toBe(2);
  });

  it("take order", async () => {
    // a core without automatic input: the focus-in travels with the user's first input
    const old = await scene({ ...OLD, terminals: 2 });
    const [, p2] = old.terminals;
    await old.stage.live(old.screen, [old.t, 80, 24], [p2!, 80, 24]);
    // another viewer takes the terminal; the pane repaints at that size and advertises it
    const browser = old.stage.rival();
    await browser.attach(p2!, 120, 40);
    browser.type("x");
    await old.stage.advance(REATTACH_SETTLE_MS);
    await old.stage.pass();
    expect([old.core.size(p2!), old.screen.view(p2!).advertised]).toEqual(["120x40", { cols: 120, rows: 40 }]);
    old.screen.panes.focus(p2!);
    expect(old.screen.type("a")).toEqual([{ sent: true }]);
    await old.stage.settle();
    expect([old.screen.sent(p2!), old.core.size(p2!)]).toEqual([["RESIZE 80x24", "FOCUS 1", "DATA 61"], "80x24"]);
    expect(old.screen.type("b")).toEqual([{ sent: true }]);
    expect(old.screen.sent(p2!)).toEqual(["RESIZE 80x24", "FOCUS 1", "DATA 61", "DATA 62"]);

    // automatic input confirmed: no FOCUS frame at all
    const { core, stage, screen, terminals: [, q2] } = await scene({ terminals: 2 });
    await stage.live(screen, [q2!, 80, 24]);
    const other = stage.rival();
    await other.attach(q2!, 120, 40);
    other.type("x");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    screen.panes.focus(q2!);
    expect(screen.type("a")).toEqual([{ sent: true }]);
    await stage.settle();
    expect([screen.sent(q2!), core.size(q2!)]).toEqual([["RESIZE 80x24", "DATA 61"], "80x24"]);
  });

  it("no idle RESIZE", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 2 });
    await stage.live(screen, [terminals[0]!, 80, 24], [terminals[1]!, 60, 20]);
    const before = traffic(core);
    for (let pass = 0; pass < 100; pass++) {
      screen.show([terminals[0]!, 80, 24], [terminals[1]!, 60, 20]);
      screen.pass();
      await stage.advance(REATTACH_SETTLE_MS);
    }
    expect(traffic(core)).toEqual(before);
    expect(terminals.map((terminal) => screen.sent(terminal))).toEqual([[], []]);
  });

  it("focus reports on a pane switch", async () => {
    const { core, stage, screen, terminals: [p1, p2] } = await scene({ terminals: 2 });
    await stage.live(screen, [p1!, 80, 24], [p2!, 80, 24]);
    core.program(p1!).output("\x1b[?1004h");
    core.program(p2!).output("\x1b[?1004h");
    await stage.settle();
    const before = traffic(core);
    screen.panes.focus(p2!);
    screen.panes.focus(p2!);
    // the old pane's program hears focus-out and the new one's focus-in, once each, as automatic input
    expect([screen.sent(p1!), screen.sent(p2!)]).toEqual([["AUTOMATIC_INPUT 1b5b4f"], ["AUTOMATIC_INPUT 1b5b49"]]);
    expect([core.program(p1!).receivedHex(), core.program(p2!).receivedHex()]).toEqual(["1b5b4f", "1b5b49"]);
    await stage.advance(10_000);
    expect(traffic(core)).toEqual(before);
    expect([core.size(p1!), core.size(p2!)]).toEqual(["80x24", "80x24"]);
    // a program that did not ask for focus reports gets none
    core.program(p1!).output("\x1b[?1004l");
    await stage.settle();
    screen.panes.focus(p1!);
    expect([screen.sent(p1!), screen.sent(p2!)]).toEqual([["AUTOMATIC_INPUT 1b5b4f"], ["AUTOMATIC_INPUT 1b5b49", "AUTOMATIC_INPUT 1b5b4f"]]);

    // a core without automatic input: the switch sends no bytes, and the focus-in comes with the first key, once
    const old = await scene({ ...OLD, terminals: 2 });
    const [o1, o2] = old.terminals;
    await old.stage.live(old.screen, [o1!, 80, 24], [o2!, 80, 24]);
    old.core.program(o1!).output("\x1b[?1004h");
    old.core.program(o2!).output("\x1b[?1004h");
    await old.stage.settle();
    old.screen.panes.focus(o2!);
    old.screen.panes.focus(o1!);
    old.screen.panes.focus(o2!);
    await old.stage.advance(10_000);
    expect([old.screen.sent(o1!), old.screen.sent(o2!)]).toEqual([[], []]);
    old.screen.type("ab");
    expect([old.screen.sent(o1!), old.screen.sent(o2!)]).toEqual([[], ["FOCUS 1", "DATA 61", "DATA 62"]]);
    expect(old.core.program(o2!).receivedHex()).toBe("1b5b496162");
    // FOCUS 0 goes only to a channel that got FOCUS 1, when its pane leaves the screen
    old.screen.show();
    await old.stage.settle();
    expect([old.screen.sent(o1!), old.screen.sent(o2!)]).toEqual([[], ["FOCUS 1", "DATA 61", "DATA 62", "FOCUS 0"]]);
  });

  it("foreign resize resyncs once", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const browser = stage.rival();
    await browser.attach(t, 120, 40);
    // five `size` events in 100 ms that this screen did not cause
    for (let step = 1; step <= 4; step++) {
      await stage.advance(25);
      browser.resize(120 + step, 40);
      await stage.settle();
    }
    expect([core.events(t, "size").length, screen.attaches.length]).toEqual([6, 1]);
    await stage.advance(REATTACH_SETTLE_MS - 1);
    expect(screen.attaches.length).toBe(1);
    await stage.advance(1);
    await stage.pass();
    // one CLOSE and one attach, 150 ms after the last, advertising the terminal's own size: nothing changes for the other viewer
    expect([screen.state(t), screen.did(t), core.size(t), core.events(t, "size").length]).toEqual(["Live", ["CLOSE"], "124x40", 6]);
    expect(screen.asked(t).at(-1)).toMatchObject({ cols: 124, rows: 40, resumed: true });
    expect([screen.view(t).advertised, screen.view(t).sizedBy]).toEqual([{ cols: 124, rows: 40 }, { cols: 124, rows: 40 }]);
    await stage.advance(10_000);
    expect(screen.attaches.length).toBe(2);
    // the pane's own take: its `size` event is confirmed, and no attach follows
    expect(screen.type("a")).toEqual([{ sent: true }]);
    await stage.advance(10_000);
    expect([core.size(t), screen.attaches.length, screen.view(t).sizedBy]).toEqual(["80x24", 2, null]);
  });

  it("shown tab only", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 5 });
    const [a, b, c, d, e] = terminals as [string, string, string, string, string];
    await stage.live(screen, [a, 80, 24], [b, 40, 12], [c, 40, 12]);
    // only what the shown tab gives a rectangle is attached
    expect(core.viewers().map((viewer) => viewer.terminal)).toEqual([a, b, c]);
    // a zoom covers two panes: none is closed, and neither sends a frame, not even credit
    screen.show([a, 80, 24], [b, 40, 12, true], [c, 40, 12, true]);
    const covered = screen.calls.length;
    core.program(b).output("\x1b[5n hidden output\r\n");
    await stage.advance(10_000);
    await stage.pass();
    expect(screen.calls.slice(covered).filter((call) => call.attach.terminal !== a)).toEqual([]);
    expect(core.viewers().length).toBe(3);
    expect(screen.type("x")).toEqual([{ sent: true }]);
    // uncovered, the pane takes up where it stopped
    screen.show([a, 80, 24], [b, 40, 12], [c, 40, 12]);
    await stage.pass();
    expect(screen.calls.slice(covered).filter((call) => call.attach.terminal === b).map((call) => call.op)).toEqual(["credit"]);
    // a tab change closes the three channels and attaches the other tab's panes
    screen.show([d, 80, 24], [e, 80, 24]);
    await stage.settle();
    await stage.pass();
    expect([screen.did(a), screen.did(b), screen.did(c)]).toEqual([["DATA 78", "CLOSE"], ["CLOSE"], ["CLOSE"]]);
    expect(core.viewers().map((viewer) => viewer.terminal)).toEqual([d, e]);
    expect([a, b, c, d, e].map((terminal) => screen.state(terminal))).toEqual(["gone", "gone", "gone", "Live", "Live"]);
    expect(screen.emulators.map((record) => record.disposed)).toEqual([true, true, true, false, false]);
    expect([core.size(a), core.size(d)]).toEqual([`${HEADLESS.cols}x${HEADLESS.rows}`, "80x24"]);
  });

  it("two screens", async () => {
    const { core, stage, screen, t } = await scene();
    const second = await stage.screen();
    second.panes.focus(t);
    await stage.live(screen, [t, 80, 24]);
    await stage.live(second, [t, 120, 40]);
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    const before = traffic(core);
    // both idle for ten simulated seconds: zero frames from either
    for (let elapsed = 0; elapsed < 10; elapsed++) {
      await stage.advance(1_000);
      await stage.pass();
    }
    expect(traffic(core)).toEqual(before);
    expect([screen.sent(t), second.sent(t)]).toEqual([[], []]);
    // the one typed into last holds the size
    screen.type("a");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    expect(core.size(t)).toBe("80x24");
    second.type("b");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    expect(core.size(t)).toBe("120x40");
    expect([screen.view(t).sizedBy, second.view(t).sizedBy]).toEqual([{ cols: 120, rows: 40 }, null]);
  });

  it("grid follows the record", async () => {
    const { core, stage, screen, terminals } = await scene({ terminals: 2 });
    const [a, b] = terminals as [string, string];
    await stage.live(screen, [a, 80, 24], [b, 60, 20]);
    const browser = stage.rival();
    await browser.attach(a, 100, 30);
    const follows = async () => {
      await stage.settle();
      return terminals.every((terminal) => {
        const record = screen.emulators.filter((made) => !made.disposed).find((made) => made.emulator === screen.view(terminal).emulator)!;
        return `${record.cols}x${record.rows}` === core.size(terminal) && `${screen.view(terminal).actual!.cols}x${screen.view(terminal).actual!.rows}` === core.size(terminal);
      });
    };
    const held: boolean[] = [await follows()];
    for (const [cols, rows] of [[101, 30], [90, 31], [132, 43], [20, 5], [100, 30]] as const) {
      browser.resize(cols, rows);
      // the emulator has the new size at once, before the next bytes are fed
      core.program(a).output(`after ${cols}x${rows}\r\n`);
      held.push(await follows());
    }
    await browser.detach();
    held.push(await follows());
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    held.push(await follows());
    expect(held).toEqual(Array(8).fill(true));
    expect([screen.state(a), screen.state(b)]).toEqual(["Live", "Live"]);
  });

  it("two idle screens settle", async () => {
    const { core, stage, screen: first, t } = await scene();
    const second = await stage.screen();
    second.panes.focus(t);
    await stage.live(first, [t, 80, 24]);
    await stage.live(second, [t, 120, 40]);
    const after: ReturnType<typeof traffic>[] = [];
    for (let step = 0; step < 10; step++) {
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      after.push(traffic(core));
    }
    // after the first step nothing more happens: no attach, CLOSE, RESIZE or size change
    expect(after.slice(1)).toEqual(Array(9).fill(after[0]));
    expect(after[0]).toEqual({ attaches: 3, closes: 1, resizes: 0, sizes: 2 });
    expect(core.size(t)).toBe("120x40");
    expect([first.view(t).advertised, first.view(t).sizedBy, first.state(t)]).toEqual([{ cols: 120, rows: 40 }, { cols: 120, rows: 40 }, "Live"]);
    expect([second.view(t).advertised, second.view(t).sizedBy]).toEqual([{ cols: 120, rows: 40 }, null]);
    // a key in the first screen takes the terminal for its rectangle; the second repaints once, asking for nothing
    expect(first.type("k")).toEqual([{ sent: true }]);
    expect(first.sent(t)).toEqual(["RESIZE 80x24", "DATA 6b"]);
    for (let step = 0; step < 10; step++) {
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
    }
    expect(second.asked(t).map((params) => `${String(params["cols"])}x${String(params["rows"])}`)).toEqual(["120x40", "80x24"]);
    expect([core.size(t), traffic(core).attaches, first.attaches.length, second.sent(t)]).toEqual(["80x24", 4, 2, []]);
  });

  it("take during a waiting reattach advertises first", async () => {
    const { core, stage, screen, t } = await scene(OLD);
    await stage.live(screen, [t, 80, 24]);
    const driver = stage.rival();
    await driver.attach(t, 120, 40);
    driver.type("x");
    await stage.settle();
    // the pane's rectangle becomes 120x40, and a key arrives inside the 150 ms, on the channel that still advertises 80x24
    screen.show([t, 120, 40]);
    await stage.advance(REATTACH_SETTLE_MS - 50);
    expect([screen.view(t).advertised, screen.panes.deadlines().has("reattach")]).toEqual([{ cols: 80, rows: 24 }, true]);
    expect(screen.type("k")).toEqual([{ sent: true }]);
    await stage.settle();
    expect(screen.sent(t)).toEqual(["RESIZE 120x40", "FOCUS 1", "DATA 6b"]);
    // the terminal was never 80x24 again after the driver took it, and the waiting reattach is off
    expect(core.program(t).sizes).toEqual(["200x120", "80x24", "120x40"]);
    expect(screen.panes.deadlines().has("reattach")).toBe(false);
    await stage.advance(10_000);
    expect([screen.attaches.length, core.size(t), screen.view(t).sizedBy]).toEqual([1, "120x40", null]);
  });

  it("same size is not ownership", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, terminals: [t, elsewhere] } = await scene({ ...options, terminals: 2 });
      // a second viewer drives the terminal at exactly the pane's rectangle
      const browser = stage.rival();
      await browser.attach(t!, 80, 24);
      browser.type("x");
      await stage.live(screen, [t!, 80, 24], [elsewhere!, 40, 10]);
      core.program(t!).output("\x1b[?1004h");
      await stage.settle();
      // the host is resized twice, and focus moves away and back
      screen.show([t!, 100, 30], [elsewhere!, 40, 10]);
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      screen.show([t!, 90, 28], [elsewhere!, 40, 10]);
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      screen.panes.focus(elsewhere!);
      screen.panes.focus(t!);
      await stage.advance(10_000);
      expect(screen.sent(t!, [FRAME_RESIZE, FRAME_FOCUS])).toEqual([]);
      expect([core.size(t!), core.program(t!).sizes]).toEqual(["80x24", ["200x120", "80x24"]]);
      expect([screen.state(t!), screen.view(t!).sizedBy]).toEqual(["Live", { cols: 80, rows: 24 }]);
    }
  });

  it("focus pass-through takes nothing", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, terminals } = await scene({ ...options, terminals: 3 });
      // another viewer drives the middle terminal
      const browser = stage.rival();
      await browser.attach(terminals[1]!, 120, 40);
      browser.type("x");
      await stage.live(screen, [terminals[0]!, 60, 20], [terminals[1]!, 60, 20], [terminals[2]!, 60, 20]);
      for (const terminal of terminals) core.program(terminal).output("\x1b[?1004h");
      await stage.settle();
      const before = terminals.map((terminal) => core.size(terminal));
      // the focus keys carry the focus through every pane and back, with nothing typed
      for (const terminal of [...terminals, ...[...terminals].reverse(), null]) screen.panes.focus(terminal);
      await stage.advance(10_000);
      expect(terminals.map((terminal) => screen.sent(terminal, SIZE_FRAMES))).toEqual([[], [], []]);
      expect(terminals.map((terminal) => core.size(terminal))).toEqual(before);
      expect(before[1]).toBe("120x40");
    }
  });

  it("host focus-in takes nothing", async () => {
    const { core, stage, screen, t } = await scene();
    const browser = stage.rival();
    await browser.attach(t, 120, 40);
    browser.type("x");
    await stage.live(screen, [t, 80, 24]);
    core.program(t).output("\x1b[?1004h");
    await stage.settle();
    // the host terminal loses and gains focus (the user comes back to the window)
    screen.panes.hostFocus(false);
    screen.panes.hostFocus(false);
    screen.panes.hostFocus(true);
    await stage.advance(10_000);
    // the focused pane's program hears it, as automatic input; nothing else leaves and the size is the browser's
    expect(screen.sent(t)).toEqual(["AUTOMATIC_INPUT 1b5b4f", "AUTOMATIC_INPUT 1b5b49"]);
    expect([core.size(t), screen.attaches.length]).toEqual(["120x40", 1]);

    const old = await scene(OLD);
    const other = old.stage.rival();
    await other.attach(old.t, 120, 40);
    other.type("x");
    await old.stage.live(old.screen, [old.t, 80, 24]);
    old.core.program(old.t).output("\x1b[?1004h");
    await old.stage.settle();
    old.screen.panes.hostFocus(false);
    old.screen.panes.hostFocus(true);
    await old.stage.advance(10_000);
    expect([old.screen.sent(old.t), old.core.size(old.t)]).toEqual([[], "120x40"]);
  });

  it("no FACTS beside an active viewer", async () => {
    const { core, stage, screen, t } = await scene();
    screen.panes.setDisplay({ fg: "#ffffff", bg: "#000000" });
    await stage.live(screen, [t, 80, 24]);
    expect(screen.asked(t)[0]).toMatchObject({ display: { fg: "#ffffff", bg: "#000000" }, resumed: true });
    const browser = stage.rival();
    await browser.attach(t, 120, 40);
    browser.type("x");
    await stage.advance(REATTACH_SETTLE_MS);
    await stage.pass();
    // the host's colours change while the other viewer drives the terminal
    screen.panes.setDisplay({ fg: "#000000", bg: "#ffffff" });
    await stage.advance(10_000);
    await stage.pass();
    expect([screen.sent(t), core.size(t)]).toEqual([[], "120x40"]);
    // the user's own input makes this screen the active viewer: its facts go with the take, once
    screen.type("ab");
    expect(screen.sent(t)).toEqual(["RESIZE 80x24", `FACTS ${JSON.stringify({ fg: "#000000", bg: "#ffffff" })}`, "DATA 61", "DATA 62"]);
  });
});

describe("a pane forgets what no longer waits", () => {
  const asked = (screen: Screen, terminal: string) => screen.asked(terminal).map((params) => `${String(params["cols"])}x${String(params["rows"])}`);
  /** ten deadline steps with a frame pass each: what a screen does when it is left alone */
  const rest = async (stage: Stage, seen?: () => void) => {
    for (let step = 0; step < 10; step++) {
      await stage.advance(REATTACH_SETTLE_MS);
      await stage.pass();
      seen?.();
    }
  };

  it("a rectangle that came back inside the wait leaves nothing behind", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      screen.show([t, 90, 24]);
      await stage.advance(50);
      screen.show([t, 80, 24]);
      await stage.advance(5_000);
      expect(asked(screen, t)).toEqual(["80x24"]);
      // five seconds later another viewer takes the terminal: one repaint at its size, and that is all
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      rival.type("x");
      await stage.settle();
      await rest(stage);
      expect([asked(screen, t), screen.view(t).advertised, core.size(t)]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }, "120x40"]);
    }
  });

  it("two idle screens settle after a rectangle flickered", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen: first, t } = await scene(options);
      const second = await stage.screen();
      second.panes.focus(t);
      await stage.live(first, [t, 80, 24]);
      first.show([t, 81, 24]);
      await stage.advance(50);
      first.show([t, 80, 24]);
      await stage.advance(5_000);
      await stage.live(second, [t, 120, 40]);
      const seen: string[] = [];
      await rest(stage, () => seen.push(`${traffic(core).attaches}/${core.size(t)}`));
      // nobody typed: the terminal keeps the size of the screen that attached last, and no attach follows the one repaint
      expect(seen).toEqual(Array(10).fill("3/120x40"));
      expect([asked(first, t), asked(second, t), core.events(t, "size")]).toEqual([["80x24", "120x40"], ["120x40"], ["size 80x24", "size 120x40"]]);
      expect([first.view(t).sizedBy, second.view(t).sizedBy]).toEqual([{ cols: 120, rows: 40 }, null]);
    }
  });

  it("a take inside the wait leaves nothing behind", async () => {
    for (const options of [{}, OLD]) {
      const { core, stage, screen, t } = await scene(options);
      await stage.live(screen, [t, 80, 24]);
      screen.show([t, 100, 30]);
      await stage.advance(50);
      expect(screen.type("k")).toEqual([{ sent: true }]);
      await stage.advance(5_000);
      expect([asked(screen, t), core.size(t)]).toEqual([["80x24"], "100x30"]);
      const rival = stage.rival();
      await rival.attach(t, 120, 40);
      rival.type("x");
      await stage.settle();
      await rest(stage);
      // one attach more, the repaint, not two
      expect([asked(screen, t), screen.view(t).advertised, core.size(t)]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }, "120x40"]);
    }
  });

  it("a size event that was undone inside the wait leaves nothing behind", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 120, 40);
    rival.type("x");
    await stage.settle();
    await rest(stage);
    expect([asked(screen, t), screen.view(t).advertised]).toEqual([["80x24", "120x40"], { cols: 120, rows: 40 }]);
    // the other viewer resizes, and 50 ms later it is back at the pane's own rectangle
    rival.resize(100, 30);
    await stage.settle();
    await stage.advance(50);
    rival.resize(80, 24);
    await stage.settle();
    await stage.advance(5_000);
    await stage.pass();
    expect([asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual([["80x24", "120x40"], "80x24", null]);
    // the host is resized to what the channel already advertises: no repaint is owed for a size event long undone
    screen.show([t, 120, 40]);
    await rest(stage);
    expect([asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual([["80x24", "120x40"], "80x24", { cols: 80, rows: 24 }]);
  });

  it("a repaint that waits is not owed to a new shell", async () => {
    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const rival = stage.rival();
    await rival.attach(t, 120, 40);
    rival.type("x");
    await stage.settle();
    // the repaint begins, and the core's answer to its CLOSE is still out when the shell dies and a new one starts
    screen.faults.holdCloses = true;
    await stage.advance(REATTACH_SETTLE_MS);
    expect([screen.state(t), asked(screen, t)]).toEqual(["Closing", ["80x24"]]);
    core.lose(t);
    core.restartTerminal(t);
    await stage.settle();
    screen.release();
    await stage.settle();
    await stage.pass();
    // the new shell's pane is attached with its rectangle, as any first attach, and alone it fits
    expect([screen.state(t), asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual(["Live", ["80x24", "80x24"], "80x24", null]);
  });

  it("a repaint that waits is not owed to a new line, to a pane shown again or to a new shell", async () => {
    const line = await scene();
    await line.stage.live(line.screen, [line.t, 80, 24]);
    const rival = line.stage.rival();
    await rival.attach(line.t, 120, 40);
    rival.type("x");
    await line.stage.settle();
    expect(line.screen.panes.deadlines().has("reattach")).toBe(true);
    // the line ends before the repaint is due: on the next line the pane attaches with its rectangle, as any first attach
    line.core.restart();
    await line.stage.settle();
    expect(line.screen.view(line.t).advertised).toBeNull();
    const waiting = line.screen.link.state;
    if (waiting.kind !== "Offline" || waiting.retryAt === null) throw new Error(`the link is ${waiting.kind}`);
    await line.stage.advance(waiting.retryAt - line.stage.clock.now);
    await line.stage.pass();
    expect([line.screen.state(line.t), asked(line.screen, line.t), line.core.size(line.t)]).toEqual(["Live", ["80x24", "80x24"], "80x24"]);

    const { core, stage, screen, t } = await scene();
    await stage.live(screen, [t, 80, 24]);
    const other = stage.rival();
    await other.attach(t, 120, 40);
    other.type("x");
    await stage.settle();
    // the pane leaves the tab and is back before the core answered its CLOSE
    screen.show();
    screen.show([t, 80, 24]);
    await stage.settle();
    await stage.pass();
    expect([screen.state(t), asked(screen, t), core.size(t), screen.view(t).sizedBy]).toEqual(["Live", ["80x24", "80x24"], "120x40", { cols: 120, rows: 40 }]);
    await rest(stage);
    expect(asked(screen, t)).toEqual(["80x24", "80x24"]);

    // a new shell is announced with no loss before it: an order the core does not send today, and still a first attach
    const shell = await scene();
    await shell.stage.live(shell.screen, [shell.t, 80, 24]);
    const third = shell.stage.rival();
    await third.attach(shell.t, 120, 40);
    third.type("x");
    await shell.stage.settle();
    shell.core.emit("restarted", shell.t, shell.core.terminal(shell.t));
    await shell.stage.settle();
    await shell.stage.pass();
    expect([shell.screen.state(shell.t), asked(shell.screen, shell.t)]).toEqual(["Live", ["80x24", "80x24"]]);
  });

  it("the program of a new core is told the focus anew", async () => {
    const { core, stage, screen, t } = await scene();
    core.setPaint(t, { body: "\x1b[?1004h" });
    await stage.live(screen, [t, 80, 24]);
    expect(screen.sent(t)).toEqual(["AUTOMATIC_INPUT 1b5b49"]);
    // the core is stopped; another comes up with a terminal at the same address, whose program asks for focus reports too
    core.stop();
    await stage.settle();
    const next = new FakeHcCore();
    const again = next.spawn().address;
    next.setPaint(again, { body: "\x1b[?1004h" });
    stage.core = next;
    const waiting = screen.link.state;
    if (waiting.kind !== "Offline" || waiting.retryAt === null) throw new Error(`the link is ${waiting.kind}`);
    await stage.advance(waiting.retryAt - stage.clock.now);
    await stage.pass();
    expect([again, screen.state(again), screen.sent(again), next.program(again).receivedHex()]).toEqual([t, "Live", ["AUTOMATIC_INPUT 1b5b49"], "1b5b49"]);
  });
});

describe("the size rules as values", () => {
  const at = (size: PaneSize) => reattachDue(size);
  const attached = (wanted: { cols: number; rows: number }, actual = wanted) => replied(attachSent(newPaneSize(wanted), wanted), actual);
  const A = { cols: 80, rows: 24 };
  const B = { cols: 120, rows: 40 };
  const C = { cols: 100, rows: 30 };

  it("an attach reply alone makes nothing wait, whatever size it reports", () => {
    expect([at(attached(A)), at(attached(A, B))]).toEqual([null, null]);
    expect(sizedBy(attached(A, B))).toEqual(B);
  });

  it("a changed rectangle waits from its last change and attaches with the rectangle", () => {
    const first = rectangleChanged(attached(A), C, 1000);
    const last = rectangleChanged(first, B, 1100);
    expect([at(first), at(last), attachSize(last)]).toEqual([1150, 1250, B]);
    // back to what the channel advertises: nothing waits
    expect(at(rectangleChanged(last, A, 1200))).toBeNull();
    expect(rectangleChanged(last, B, 5000)).toBe(last);
  });

  it("another viewer's size event waits from the last one and repaints at the terminal's own size", () => {
    const one = sizeTold(attached(A), B, 2000, true);
    const two = sizeTold(one, C, 2100, true);
    expect([at(one), at(two), attachSize(two), attachSize(attached(A, B))]).toEqual([2150, 2250, C, A]);
    // an event before the reply, and one that brings the size back, make nothing wait
    expect([at(sizeTold(attached(A), B, 2000, false)), at(sizeTold(two, A, 2200, true))]).toEqual([null, null]);
    const repainted = replied(attachSent(two, C), C);
    expect([at(repainted), repainted.advertised, sizedBy(repainted)]).toEqual([null, C, C]);
  });

  it("both causes at once make one attach, with the rectangle; the take ends the wait", () => {
    const both = rectangleChanged(sizeTold(attached(A), B, 3000, true), C, 3050);
    expect([at(both), attachSize(both)]).toEqual([3200, C]);
    // the user's input ends both waits at once; a later size event of another viewer starts a new one
    const taken = took(both);
    expect([taken.advertised, at(taken), at(sizeTold(taken, C, 3060, true))]).toEqual([C, null, null]);
    expect(at(sizeTold(taken, B, 3070, true))).toEqual(3220);
  });

  it("what was told, cancelled or ended no longer waits", () => {
    // the rectangle changed and came back inside the wait; later another viewer resized, and the pane repainted
    const flickered = rectangleChanged(rectangleChanged(attached(A), C, 1000), A, 1050);
    const repainted = replied(attachSent(sizeTold(flickered, B, 2000, true), B), B);
    expect([at(flickered), flickered.ownAt, at(repainted), repainted.ownAt]).toEqual([null, null, null, null]);
    // the take told the core the rectangle: the same later resize makes one repaint, and nothing after it
    const taken = took(rectangleChanged(attached(A), C, 1000));
    const afterTake = replied(attachSent(sizeTold(taken, B, 6000, true), B), B);
    expect([taken.ownAt, at(sizeTold(taken, B, 6000, true)), at(afterTake)]).toEqual([null, 6150, null]);
    // a size event that a later one undid, then a rectangle the channel already advertises
    const undone = sizeTold(sizeTold(repainted, C, 7000, true), A, 7050, true);
    expect([undone.foreignAt, at(undone), at(rectangleChanged(undone, B, 9000))]).toEqual([null, null, null]);
    // a rectangle that becomes the terminal's own size owes no repaint any more
    expect(at(rectangleChanged(sizeTold(attached(A), B, 1000, true), B, 1020))).toEqual(1170);
    expect(rectangleChanged(sizeTold(attached(A), B, 1000, true), B, 1020).foreignAt).toBeNull();
    // an attach that ended takes its waits with it: the next one starts from the rectangle
    const ended = detached(rectangleChanged(sizeTold(attached(A), B, 1000, true), C, 1010));
    expect([ended.ownAt, ended.foreignAt, ended.advertised, at(ended), attachSize(ended), at(rectangleChanged(ended, A, 2000))]).toEqual([null, null, null, null, C, null]);
  });

  it("a clipped pane shows the part of the real grid that holds the cursor", () => {
    expect([clipTop(0, 40, 24), clipTop(23, 40, 24), clipTop(24, 40, 24), clipTop(39, 40, 24), clipTop(5, 10, 24)]).toEqual([0, 0, 1, 16, 0]);
  });
});
