import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { coreFolder, IsolatedCore, type StopReport, stoppedCleanly } from "../../scripts/test-hc.ts";
import { AUTOMATIC_INPUT_FEATURE, type Channel, HcConnection } from "../../server/herdr-core/connection.ts";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { REATTACH_SETTLE_MS } from "../model/deadlines.ts";
import { picture, type Screen, Stage } from "../testing/pane-harness.ts";

/**
 * The pane machine against a real hc, in cores of the test's own (IsolatedCore): a pane attaches to a
 * terminal that runs a program, shows its output, hands it what is typed exactly once and in order
 * while it prints, follows the size rules beside another viewer, sends no answer of its own to a
 * query the core answers, refuses everything typed once its core is stopped, and attaches again in a
 * new epoch on the next core at the same socket with none of it sent. Runs only where
 * OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

/** how long one event of the real core may take to arrive (a pinned, loaded machine is slow) */
const WAIT_MS = 20_000;
/** above twice the helper's own 10 s wait for a stopped core, and the waits of a run */
const TEST_MS = 240_000;

/**
 * The program in the terminal: raw input logged as hex to a file, its size printed on SIGWINCH, a DA1
 * query sent for every "@" (not "?": the answer holds one), and from the first "!" on a line printed
 * every 2 ms, so that what is typed meets a stream that never stops.
 */
const PROGRAM = [
  "import os, signal, sys, threading, time, tty",
  "log = sys.argv[1]",
  "tty.setraw(0)",
  "def winch(*_):",
  "    cols, rows = os.get_terminal_size(0)",
  "    os.write(1, ('SIZE %dx%d\\r\\n' % (cols, rows)).encode())",
  "signal.signal(signal.SIGWINCH, winch)",
  "def chatter():",
  "    n = 0",
  "    while True:",
  "        n += 1",
  "        os.write(1, ('tick %d\\r\\n' % n).encode())",
  "        time.sleep(0.002)",
  "started = False",
  "os.write(1, b'READY\\r\\n')",
  "with open(log, 'ab', buffering=0) as out:",
  "    out.write(b'R\\n')",
  "    while True:",
  "        data = os.read(0, 65536)",
  "        if not data:",
  "            break",
  "        out.write(('IN:' + data.hex() + '\\n').encode())",
  "        for _ in range(data.count(b'@')):",
  "            os.write(1, b'\\x1b[c')",
  "        if b'!' in data and not started:",
  "            started = True",
  "            threading.Thread(target=chatter, daemon=True).start()",
].join("\n");

/** a DA1 reply: `ESC [ ? ... c` */
const DA_REPLY = /\x1b\[\?[\d;]*c/g;

describe.skipIf(!bin || process.platform === "win32")("the pane machine against a real hc", () => {
  const cores: IsolatedCore[] = [];
  const lines: HcConnection[] = [];
  let stage: Stage | null = null;
  /** the one teardown: the test, afterAll and a signal all await it */
  let teardown: Promise<StopReport[]> | null = null;
  const stopAll = () => (teardown ??= (async () => {
    await stage?.close();
    for (const line of lines) line.close();
    const reports: StopReport[] = [];
    for (const core of cores) reports.push(await core.stop());
    return reports;
  })());
  /** a signal ends `bun test` without running afterAll: the same teardown runs first */
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => { void stopAll().finally(() => process.exit(128 + constants.signals[signal])); };

  afterAll(async () => {
    const reports = await stopAll();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    expect(reports.map(stoppedCleanly)).toEqual(cores.map(() => true));
  }, TEST_MS);

  it("attaches, shows output, hands on what is typed once and in order, follows the size rules, and sends nothing typed while its core was gone", async () => {
    for (const signal of SIGNALS) process.once(signal, onSignal);
    const folder = coreFolder();
    const first = new IsolatedCore(bin!, folder);
    cores.push(first);
    await first.start();
    // the stage's own fake core stays unused: the screen's link goes through the socket to the real one
    stage = new Stage(new FakeHcCore());
    const screen: Screen = await stage.screen({ socket: first.socket });
    const scripts = join(folder.root, "s");
    const program = join(scripts, "program.py");
    const logged = (name: string) => { try { return readFileSync(join(scripts, name), "utf8"); } catch { return ""; } };
    /** everything the program read, in order */
    const read = (name: string) => Buffer.from([...logged(name).matchAll(/^IN:([0-9a-f]*)$/gm)].map((match) => match[1]).join(""), "hex").toString("latin1");
    /** waits for something only the real core's own time brings: a frame pass (credit) and a rest each turn, within WAIT_MS */
    const until = async (label: string, check: () => boolean) => {
      const started = Date.now();
      while (!check()) {
        if (Date.now() - started > WAIT_MS) throw new Error(`no ${label} within ${WAIT_MS}ms; the pane is ${screen.panes.views().map((view) => `${view.terminal} ${screen.state(view.terminal)}`).join(", ")}, the link ${screen.link.state.kind}`);
        screen.pass({ live: false });
        await stage!.settle();
      }
    };
    const size = async (terminal: string) => {
      const record = await screen.link.call("terminal.get", { terminal });
      return `${record.cols}x${record.rows}`;
    };
    const live = async (terminal: string) => {
      await until(`${terminal}'s first paint`, () => screen.panes.view(terminal)?.ready === true);
      screen.pass();
      expect(screen.state(terminal)).toBe("Live");
    };
    const start = async (name: string) => {
      mkdirSync(scripts, { recursive: true });
      writeFileSync(program, PROGRAM);
      const { address } = await screen.link.call("terminal.run", { argv: ["python3", program, join(scripts, name)] });
      await until(`${name}'s program to start`, () => logged(name).startsWith("R\n"));
      return address;
    };
    const frames = (terminal: string) => screen.did(terminal);

    expect(screen.link.state).toEqual({ kind: "Online", epoch: 1 });
    const automatic = (await screen.link.hello()).features.includes(AUTOMATIC_INPUT_FEATURE);
    const t = await start("one.log");

    // a pane attaches to the terminal; alone, the terminal takes the pane's rectangle with no RESIZE
    screen.panes.focus(t);
    screen.show([t, 80, 24]);
    await live(t);
    expect(screen.asked(t)).toEqual([{ terminal: t, cols: 80, rows: 24, history: 2000, resumed: true }]);
    expect([await size(t), frames(t), screen.attaches[0]!.automaticInput]).toEqual(["80x24", [], automatic]);
    // the first paint starts with CAN, and its output is in the pane's emulator
    expect(screen.attaches[0]!.received[0]![0]).toBe(0x18);
    await until("READY in the picture", () => picture(screen.view(t).emulator!).join("\n").includes("READY"));

    // a query the core answers itself: the program gets one answer, and none of it came from the pane
    expect(screen.type("@")).toEqual([{ sent: true }]);
    await until("the key and an answer to DA1 at the program", () => read("one.log").includes("@") && read("one.log").match(DA_REPLY) !== null);
    await stage.settle();
    expect(frames(t)).toEqual([...(automatic ? [] : ["FOCUS 1"]), "DATA 40"]);
    expect(screen.emulators[0]!.replies).toEqual([]);

    // 2000 characters in bursts while the program prints without a pause
    expect(screen.type("!")).toEqual([{ sent: true }]);
    await until("the program's stream of lines", () => picture(screen.view(t).emulator!).join("\n").includes("tick "));
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const typed = Array.from({ length: 2000 }, (_, at) => alphabet[(at * 7 + (at >> 3)) % alphabet.length]).join("");
    for (let at = 0; at < typed.length; at += 50) {
      expect(screen.type(typed.slice(at, at + 50)).every((result) => result.sent)).toBe(true);
      screen.pass({ live: false });
      await stage.settle();
    }
    await until("everything typed at the program", () => read("one.log").replace(DA_REPLY, "").length >= typed.length + 2);
    // exactly once, in order, nothing else
    expect(read("one.log").replace(DA_REPLY, "")).toBe(`@!${typed}`);
    expect((read("one.log").match(DA_REPLY) ?? []).length).toBe(1);
    expect(frames(t).filter((frame) => !frame.startsWith("DATA ") && frame !== "FOCUS 1")).toEqual([]);

    // a host resize: no RESIZE, one new attach with the new rectangle; alone, the terminal takes it
    screen.show([t, 100, 30]);
    await stage.advance(REATTACH_SETTLE_MS - 1);
    expect(screen.attaches.length).toBe(1);
    await stage.advance(1);
    await live(t);
    expect(screen.asked(t).at(-1)).toEqual({ terminal: t, cols: 100, rows: 30, history: 2000, resumed: true });
    expect([await size(t), screen.attaches.length, frames(t).filter((frame) => frame.startsWith("RESIZE") || frame === "CLOSE")]).toEqual(["100x30", 2, ["CLOSE"]]);
    expect([screen.view(t).actual, screen.view(t).sizedBy]).toEqual([{ cols: 100, rows: 30 }, null]);

    // another client takes the terminal: the pane repaints at that size, asks for nothing, and shows the notice
    const browser = new HcConnection(await (async () => { const transport = await connectCoreSocket(first.socket); return () => transport; })());
    lines.push(browser);
    const theirs: Channel = (await browser.open("terminal.attach", { terminal: t, cols: 120, rows: 40 }, { onData: () => {}, onClose: () => {} })).channel;
    theirs.write("z");
    await until("the other viewer's size at the pane", () => screen.view(t).actual?.cols === 120);
    await stage.advance(REATTACH_SETTLE_MS);
    await live(t);
    expect(screen.asked(t).at(-1)).toEqual({ terminal: t, cols: 120, rows: 40, history: 2000, resumed: true });
    expect([await size(t), screen.view(t).sizedBy, screen.view(t).advertised]).toEqual(["120x40", { cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);
    expect(frames(t).filter((frame) => frame.startsWith("RESIZE"))).toEqual([]);
    // the user's own key takes it back: the rectangle first, then the key
    const before = frames(t).length;
    expect(screen.type("k")).toEqual([{ sent: true }]);
    expect(frames(t).slice(before)).toEqual(["RESIZE 100x30", ...(automatic ? [] : ["FOCUS 1"]), "DATA 6b"]);
    await until("the terminal back at the pane's rectangle", () => screen.view(t).actual?.cols === 100 && screen.view(t).sizedBy === null);
    expect(await size(t)).toBe("100x30");
    await theirs.close();
    await until("everything typed at the program, the last key too", () => read("one.log").replace(DA_REPLY, "").endsWith("zk"));
    expect(read("one.log").replace(DA_REPLY, "")).toBe(`@!${typed}zk`);

    // the core is stopped: the pane waits offline, and everything typed from here is refused
    const attachesBefore = screen.attaches.length;
    expect(stoppedCleanly(await first.stop())).toBe(true);
    await until("the link to notice its core is gone", () => screen.link.state.kind === "Offline" && screen.state(t) === "Waiting(offline)");
    const refused = [...screen.type("rm -rf everything"), screen.key("ENTER"), screen.paste("typed while the core was gone\n")];
    expect(refused.map((result) => result.sent)).toEqual(Array(refused.length).fill(false));
    expect(refused.filter((result) => !result.sent && result.notice).length).toBe(1);

    // a new core at the same socket, with a terminal of its own at the same address
    for (const sub of ["home", "state", "config", "run"]) mkdirSync(join(folder.root, sub), { recursive: true, mode: 0o700 });
    const second = new IsolatedCore(bin!, folder);
    cores.push(second);
    await second.start();
    expect(second.socket).toBe(first.socket);
    const control = new HcConnection(await (async () => { const transport = await connectCoreSocket(second.socket); return () => transport; })());
    lines.push(control);
    // the first core's stop removed its folder, the program with it
    mkdirSync(scripts, { recursive: true });
    writeFileSync(program, PROGRAM);
    const next = (await control.call("terminal.run", { argv: ["python3", program, join(scripts, "two.log")] })).address;
    expect(next).toBe(t);
    // until it reads raw input a key would be the tty's to echo and to drop
    await until("the new program to start", () => logged("two.log").startsWith("R\n"));
    // the link's next attempt comes up in a new epoch, and the pane attaches again by its record there
    for (let attempt = 0; attempt < 8 && screen.link.state.kind !== "Online"; attempt++) {
      const state = screen.link.state;
      if (state.kind === "Offline" && state.retryAt !== null) await stage.advance(Math.max(0, state.retryAt - stage.clock.now));
      else await stage.settle();
    }
    expect(screen.link.state).toEqual({ kind: "Online", epoch: 2 });
    await live(t);
    expect([screen.view(t).gen, screen.attaches.length, screen.asked(t).at(-1)]).toEqual([4, attachesBefore + 1, { terminal: t, cols: 100, rows: 30, history: 2000, resumed: true }]);
    // nothing typed while the core was gone reached the new terminal: its program reads the next key and only that
    expect(screen.type("n")).toEqual([{ sent: true }]);
    await until("the next key at the new program", () => read("two.log").length > 0);
    await stage.settle();
    expect(read("two.log")).toBe("n");
    expect(frames(t).slice(-(automatic ? 1 : 2))).toEqual([...(automatic ? [] : ["FOCUS 1"]), "DATA 6e"]);

    const reports = await stopAll();
    expect(reports.map(stoppedCleanly)).toEqual([true, true]);
  }, TEST_MS);
});
