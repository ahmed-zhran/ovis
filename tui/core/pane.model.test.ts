import { expect, it } from "bun:test";
import { type FakeCoreOptions, FakeHcCore, FEATURES_0_1_17 } from "../../server/herdr-core/core.fake.ts";
import { typedKey } from "../input/decode.ts";
import { type AttachRecord, type ChannelCall, type EmulatorRecord, type Rival, type Screen, Stage } from "../testing/pane-harness.ts";
import type { PaneInput } from "./pane.ts";

/**
 * The pane machine under random runs: each sequence is a fake core (like hc 0.1.18 or 0.1.17), one
 * screen with real emulators, a rival viewer, and a run of random steps: panes shown, hidden, covered
 * and resized, focus moves, input of every kind with fresh and stale stamps, program output cut
 * anywhere, the clock, frame passes, another client attaching, typing and resizing, programs ending,
 * shells lost and restarted, terminals removed, the line lost, the core stopped and replaced, missed
 * events, emulator and attach faults, and the owner calling back in from a draw or a notice. After
 * EVERY step the invariants of the machine are checked by an oracle that does not ask the machine:
 * it sees each call on a channel and each write into an emulator as it is made, and reads the fake
 * core's own record of what each viewer advertises.
 *
 * PANE_MODEL_SEED picks the run (default 23), PANE_MODEL_SEQUENCES its length (default 2000) and
 * PANE_MODEL_ONLY replays one sequence by the seed a failure printed.
 */
const SEED = Number(process.env["PANE_MODEL_SEED"] ?? 23);
const SEQUENCES = Number(process.env["PANE_MODEL_SEQUENCES"] ?? 2000);
const ONLY = process.env["PANE_MODEL_ONLY"];
const STEPS = 28;
const RECTANGLES = [[20, 6], [30, 8], [40, 10], [24, 7]] as const;
const OUTPUTS = [
  "a line of output\r\n", "\x1b[?1004h", "\x1b[?1004l", "\x1b[?1000h\x1b[?1006h", "\x1b[?1000l", "\x1b[5n", "\x1b[6n", "\x1b[?2004h", "\x1b[?2004l",
  "\x1b[2J\x1b[H", "\x1b[31mred\x1b[0m", "\x07", "\x1b[?2026h", "\x1b[?2026l", "\x1b]0;title\x07",
];

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Totals { steps: number; attaches: number; lives: number; accepted: number; refused: number; takes: number; reattaches: number; lines: number }

async function sequence(seed: number, totals: Totals): Promise<void> {
  const random = mulberry(seed);
  const chance = (share: number) => random() < share;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const options: FakeCoreOptions = chance(0.4) ? { version: "0.1.17", features: FEATURES_0_1_17 } : {};
  const stage = new Stage(new FakeHcCore(options));
  let terminals = [1, 2, 3].map(() => stage.core.spawn().address);
  const screen: Screen = await stage.screen();
  const rival: Rival = stage.rival();

  // what the test itself did, which the oracle judges the machine against
  const shown = new Map<string, { cols: number; rows: number; covered: boolean }>();
  let focus: string | null = null;
  let hostFocused = true;
  /** the attaches that were taken live, and when */
  const liveAt = new Map<AttachRecord, number>();
  const gotFocus = new Set<AttachRecord>();
  const fedBy = new Map<EmulatorRecord, { attach: AttachRecord; next: number; bytes: number }>();
  const feeds = new Set<AttachRecord>();
  const broken: string[] = [];
  const trace: string[] = [];
  const latest = (terminal: string) => screen.attaches.filter((record) => record.terminal === terminal).at(-1);
  const open = (record: AttachRecord | undefined): record is AttachRecord => record !== undefined && record.state === "open" && !record.closeAsked && !record.closeHeard;
  const wantedOf = (terminal: string) => { const pane = shown.get(terminal); return pane ? `${pane.cols}x${pane.rows}` : null; };
  const alive = (terminal: string) => {
    try {
      const record = stage.core.terminal(terminal);
      return record.state === "live" && record.reason === null;
    } catch {
      return false;
    }
  };
  const isReply = (text: string) => screen.emulators.some((record) => record.replies.some((reply) => text.endsWith(` ${Buffer.from(reply).toString("hex")}`)));

  // I8, I9: every attach is a resumed plain viewer with the rectangle or the terminal's own size, and none leaves while an earlier one is open
  screen.hooks.attach = (record) => {
    totals.attaches++;
    const { terminal } = record;
    const params = record.params;
    if (params["resumed"] !== true || params["history"] !== 2000 || "observe" in params || "resize_notifications" in params) broken.push(`I8 attach params ${JSON.stringify(params)}`);
    const size = `${String(params["cols"])}x${String(params["rows"])}`;
    const actual = screen.panes.view(terminal)?.actual;
    if (size !== wantedOf(terminal) && size !== (actual ? `${actual.cols}x${actual.rows}` : null)) broken.push(`I8 ${terminal} attached at ${size}: neither its rectangle ${wantedOf(terminal)} nor the terminal's size`);
    if (!shown.has(terminal)) broken.push(`I14 ${terminal} is not shown and was attached`);
    const earlier = screen.attaches.filter((other) => other !== record && other.terminal === terminal && other.state !== "refused" && !other.closeHeard);
    if (earlier.length > 0) broken.push(`I9 ${terminal} attached again while attach ${earlier.map((other) => other.index).join(",")} is not closed`);
    if (screen.attaches.filter((other) => other.terminal === terminal).length > 1) totals.reattaches++;
  };

  // I4: an emulator is fed the frames of exactly one attach, each once, in the order they came
  screen.hooks.write = (emulator, bytes) => {
    let feed = fedBy.get(emulator);
    if (!feed) {
      const attach = screen.attaches.find((record) => record.received[0] === bytes);
      if (!attach || feeds.has(attach)) {
        broken.push(`I4 emulator ${emulator.index} was first fed bytes that open no attach's stream, or one that feeds another emulator`);
        return;
      }
      feeds.add(attach);
      fedBy.set(emulator, feed = { attach, next: 0, bytes: 0 });
    }
    if (feed.attach.received[feed.next] !== bytes) broken.push(`I4 emulator ${emulator.index} got bytes that are not frame ${feed.next} of attach ${feed.attach.index}`);
    feed.next++;
    feed.bytes += bytes.length;
  };

  // I1, I3, I5, I6, I7, I14: judged at the moment the machine makes the call
  screen.hooks.call = (call: ChannelCall) => {
    const { attach, op, text } = call;
    const terminal = attach.terminal;
    const where = `${op} ${text.slice(0, 40)} on attach ${attach.index} (${terminal})`;
    if (attach.closeAsked) broken.push(`I14 ${where} after our CLOSE`);
    if (op === "close") return;
    if (shown.get(terminal)?.covered) broken.push(`I6 ${where} while the pane is covered`);
    if (op === "credit") return;
    if (op === "focus" && text === "FOCUS 0") {
      if (!gotFocus.has(attach)) broken.push(`I6 ${where}: this channel never got FOCUS 1`);
      if (shown.has(terminal)) broken.push(`I6 ${where} while the pane is shown`);
      return;
    }
    if (!liveAt.has(attach)) broken.push(`I3 ${where} before the pane was live`);
    if (screen.panes.view(terminal)?.state.kind !== "Live") broken.push(`I3 ${where} in state ${screen.state(terminal)}`);
    const typing = call.input !== null;
    if (op === "writeAutomatic") {
      if (!attach.automaticInput) broken.push(`I6 ${where} on a channel without automatic input`);
      if (text !== "AUTOMATIC_INPUT 1b5b49" && text !== "AUTOMATIC_INPUT 1b5b4f" && !isReply(text)) broken.push(`I2 ${where} is neither a focus report nor an emulator's reply`);
      return;
    }
    if (op === "write" && !typing) {
      // a reply as DATA: only without automatic input, only from the pane the user drives
      if (attach.automaticInput || !isReply(text)) broken.push(`I1 ${where} outside the user's input`);
      if (focus !== terminal || !hostFocused || !gotFocus.has(attach)) broken.push(`I6 ${where} from a pane the user does not drive`);
    }
    if (op !== "write" && !typing) broken.push(`I6 ${where} without the user's input`);
    if (typing && focus !== terminal) broken.push(`I1 ${where} is not the focused pane`);
    const told = screen.advertisedTo(attach);
    if (op === "resize") {
      if (text !== `RESIZE ${wantedOf(terminal)}`) broken.push(`I6 ${where}: not the rectangle ${wantedOf(terminal)}`);
      if (told === wantedOf(terminal)) broken.push(`I6 ${where}: the channel already advertises it`);
      totals.takes++;
    }
    if (op === "focus") {
      if (attach.automaticInput || gotFocus.has(attach)) broken.push(`I6 ${where}: a second FOCUS 1, or one on a channel with automatic input`);
      gotFocus.add(attach);
    }
    if (op === "write" && told !== null && told !== wantedOf(terminal)) broken.push(`I7 ${where} while the channel advertises ${told}, not ${wantedOf(terminal)}`);
  };

  const input = (event: PaneInput): void => {
    const terminal = focus;
    const attach = terminal === null ? undefined : latest(terminal);
    const allowed = terminal !== null && open(attach) && liveAt.has(attach) && event.at > liveAt.get(attach)! && screen.link.state.kind === "Online" && shown.get(terminal)?.covered === false;
    const before = screen.calls.length;
    const result = screen.input(event);
    const made = screen.calls.slice(before).filter((call) => call.op !== "close");
    if (result.sent) totals.accepted++;
    else totals.refused++;
    // I1: sent only when the test's own account allows it; a refusal sends nothing
    if (result.sent && !allowed) broken.push(`I1 input ${event.type} read at ${event.at} was sent to ${terminal} (${terminal === null ? "none" : screen.state(terminal)}, live since ${attach ? liveAt.get(attach) : "never"})`);
    if (!result.sent && made.length > 0) broken.push(`I1 a refused input (${result.code}) made ${made.map((call) => call.text).join(", ")}`);
    // I2, I6: one DATA, last, with at most RESIZE, FOCUS 1 and FACTS ahead of it in that order
    if (result.sent && !/^(resize )?(focus )?(facts )?write $/.test(made.map((call) => `${call.op} `).join(""))) broken.push(`I2 an accepted input made ${made.map((call) => call.text).join(", ")}`);
    if (event.type === "paste" && !event.complete && result.sent) broken.push("I1 a cut paste was sent");
  };
  const stamp = () => (chance(0.15) ? stage.clock.now - Math.floor(random() * 400) : screen.stamp());
  const someInput = (): PaneInput => {
    const at = stamp();
    const kind = random();
    if (kind < 0.55) return { ...typedKey(pick(["a", "b", "Z", "1", " "]), {}), at };
    if (kind < 0.62) return { ...typedKey("q", {}, "release"), at };
    if (kind < 0.7) return { type: "text", text: pick(["x", "한", "é"]), at };
    if (kind < 0.8) return { type: "paste", text: pick(["pasted", "two\nlines"]), complete: !chance(0.2), at };
    if (kind < 0.85) return { type: "key", key: pick(["ENTER", "ESCAPE", "ARROW_UP", "UNIDENTIFIED"]), mods: {}, action: "press", at };
    return { type: "mouse", action: pick(["press", "press", "release", "motion"] as const), button: pick(["left", "wheelUp"] as const), mods: {}, col: 2, row: 1, at };
  };

  const apply = () => screen.show(...[...shown].map(([terminal, pane]) => [terminal, pane.cols, pane.rows, pane.covered] as [string, number, number, boolean]));
  const pass = (budget: number) => {
    for (const view of screen.panes.views()) {
      view.emulator?.frame(() => {});
      screen.panes.credit(view.terminal, budget);
      if (!view.ready) continue;
      // noted before the call: the owner may type from the notice the pane's new state makes
      const attach = latest(view.terminal);
      if (attach) liveAt.set(attach, stage.clock.now);
      if (screen.panes.live(view.terminal)) {
        if (!open(attach)) broken.push(`I3 ${view.terminal} went live without an open attach`);
        totals.lives++;
      } else if (attach) liveAt.delete(attach);
    }
  };
  const reconnect = async () => {
    for (let attempt = 0; attempt < 12 && screen.link.state.kind === "Offline" && screen.link.state.retryAt !== null; attempt++) {
      await stage.advance(Math.max(0, screen.link.state.retryAt - stage.clock.now));
    }
  };

  /** [weight, name, what it does]: a step that awaits something cannot be part of a burst */
  const steps: [number, string, () => void | Promise<void>][] = [
    [10, "show", () => {
      shown.clear();
      for (const terminal of terminals) {
        if (chance(0.6)) {
          const [cols, rows] = pick(RECTANGLES);
          shown.set(terminal, { cols, rows, covered: chance(0.08) });
        }
      }
      apply();
    }],
    [8, "resize", () => {
      for (const pane of shown.values()) if (chance(0.6)) [pane.cols, pane.rows] = pick(RECTANGLES);
      apply();
    }],
    [3, "cover", () => {
      for (const pane of shown.values()) pane.covered = chance(0.3);
      apply();
    }],
    [7, "focus", () => {
      focus = chance(0.1) ? null : chance(0.8) && shown.size > 0 ? pick([...shown.keys()]) : pick(terminals);
      screen.panes.focus(focus);
    }],
    [2, "host focus", () => {
      hostFocused = !hostFocused;
      screen.panes.hostFocus(hostFocused);
    }],
    [30, "input", () => { for (let count = 1 + Math.floor(random() * 3); count > 0; count--) input(someInput()); }],
    [14, "output", () => {
      const terminal = pick(terminals);
      if (!alive(terminal)) return;
      const program = stage.core.program(terminal);
      const kind = random();
      if (kind < 0.04) program.output("x".repeat(300_000));
      else if (kind < 0.12) program.output("0123456789".repeat(4_000));
      else if (kind < 0.25) {
        // one sequence in two pieces, cut inside a character or an escape
        const whole = Buffer.from(pick(["한글 text\r\n", "\x1b[38;5;196mcolour\x1b[0m", "\x1b]0;a title\x07"]));
        const cut = 1 + Math.floor(random() * (whole.length - 1));
        program.output(whole.subarray(0, cut));
        program.output(whole.subarray(cut));
      } else program.output(pick(OUTPUTS));
    }],
    [24, "pass", () => pass(chance(0.3) ? 2_000 : 512 * 1024)],
    [12, "clock", () => {
      stage.clock.now += pick([1, 50, 149, 150, 151, 1_000, 5_000]);
      screen.fire();
    }],
    [5, "rival attaches", async () => {
      const terminal = pick(terminals);
      if (rival.attached || !alive(terminal)) return;
      const [cols, rows] = pick([...RECTANGLES, [120, 40], [1200, 50]] as const);
      await rival.attach(terminal, cols, rows, chance(0.4)).catch(() => {});
    }],
    [5, "rival types", () => rival.type("r")],
    [4, "rival resizes", () => { const [cols, rows] = pick(RECTANGLES); rival.resize(cols, rows); }],
    [3, "rival leaves", async () => { await rival.detach(); }],
    [3, "shell lost", () => { const terminal = pick(terminals); if (alive(terminal)) stage.core.lose(terminal); }],
    [3, "shell restarted", () => {
      const terminal = pick(terminals);
      try {
        const record = stage.core.terminal(terminal);
        if (record.state === "live" && record.reason !== null) stage.core.restartTerminal(terminal);
      } catch { /* the terminal is gone */ }
    }],
    [2, "program ends", () => { const terminal = pick(terminals); if (alive(terminal)) stage.core.program(terminal).exit(Math.floor(random() * 4)); }],
    [1, "terminal removed", () => { const terminal = pick(terminals); try { stage.core.remove(terminal); } catch { /* gone already */ } }],
    [2, "terminal made", () => { terminals = [...terminals, stage.core.spawn().address]; }],
    [4, "line lost", () => stage.core.restart()],
    [8, "reconnect", reconnect],
    [2, "core stopped and replaced", () => {
      stage.core.stop();
      stage.core = new FakeHcCore(options);
      terminals = [1, 2, 3].slice(0, 1 + Math.floor(random() * 3)).map(() => stage.core.spawn().address);
      totals.lines++;
    }],
    [2, "missed", () => stage.core.missed()],
    [1, "heartbeat", () => stage.core.heartbeat()],
    [3, "emulator fault", () => {
      const kind = random();
      if (kind < 0.5) screen.faults.write = pick(["trapped", "failed", "busy"] as const);
      else if (kind < 0.65) screen.faults.resize = pick(["size", "failed"] as const);
      else if (kind < 0.85) screen.faults.encode = pick(["busy", "failed"] as const);
      else screen.faults.create = true;
    }],
    [3, "attach fault", () => {
      const kind = random();
      if (kind < 0.45) screen.faults.attach = { reject: pick(["unavailable", "finished", "not_found", "timeout", "closed", "blocked"]) };
      else if (kind < 0.6) screen.faults.attach = { reply: () => ({ channel: 1, terminal: {} }) };
      else if (kind < 0.8) screen.faults.holdReplies = true;
      // the core's answer to our CLOSE comes late: no attach may leave before it
      else screen.faults.holdCloses = true;
    }],
    [4, "held answers let go", () => screen.release()],
    [2, "stream dropped", () => {
      // a relay closes the stream with no reason while the terminal lives
      const record = terminals.map(latest).find(open);
      if (!record) return;
      record.closeHeard = true;
      record.state = "closed";
      record.handlers.onClose(null);
    }],
    [2, "owner calls back from a draw", () => {
      const view = screen.panes.views().find((seen) => seen.emulator && seen.state.kind === "Live");
      if (!view) return;
      stage.core.program(view.terminal).output("redraw\r\n");
      let done = false;
      const hide = () => {
        if (done) return;
        done = true;
        shown.delete(view.terminal);
        apply();
      };
      // the picture may have nothing new to draw yet: then the owner hides the pane right after
      view.emulator!.frame(hide);
      hide();
    }],
    [2, "owner calls back from a notice", () => {
      screen.hooks.notice = () => {
        screen.hooks.notice = undefined;
        input(someInput());
        for (const view of screen.panes.views()) screen.panes.credit(view.terminal, 1_000);
      };
    }],
    [2, "display changes", () => screen.panes.setDisplay(chance(0.3) ? undefined : { fg: pick(["#ffffff", "#000000"]), bg: "#101010" })],
    [2, "retry", () => screen.panes.retry(pick(terminals))],
  ];
  const total = steps.reduce((sum, [weight]) => sum + weight, 0);
  const draw = () => {
    let at = random() * total;
    return steps.find(([weight]) => (at -= weight) < 0)!;
  };

  /** what holds whenever the stage is at rest */
  const check = (after: string) => {
    // I5: credited <= consumed <= received, per attach
    for (const attach of screen.attaches) {
      const consumed = [...fedBy.values()].find((feed) => feed.attach === attach)?.bytes ?? 0;
      if (attach.credited > consumed || consumed > attach.receivedBytes) broken.push(`I5 attach ${attach.index}: credited ${attach.credited}, consumed ${consumed}, received ${attach.receivedBytes}`);
    }
    // I13: the machine never calls an emulator from inside that emulator's own write
    for (const emulator of screen.emulators) if (emulator.reentered.length > 0) broken.push(`I13 emulator ${emulator.index} was called from inside its own write: ${emulator.reentered.join(", ")}`);
    for (const view of screen.panes.views()) {
      const { terminal, state } = view;
      if (!shown.has(terminal) && state.kind !== "Closing") broken.push(`I14 ${terminal} is not shown and is ${state.kind}`);
      if (state.kind !== "Painting" && state.kind !== "Live") continue;
      const attach = latest(terminal);
      if (!open(attach)) {
        broken.push(`I4 ${terminal} is ${state.kind} with no open attach`);
        continue;
      }
      // I10: the grid follows the record, and the emulator has it
      const feed = [...fedBy.entries()].find(([, fed]) => fed.attach === attach);
      if (screen.link.state.kind === "Online" && alive(terminal)) {
        const size = stage.core.size(terminal);
        if (!view.actual || `${view.actual.cols}x${view.actual.rows}` !== size) broken.push(`I10 ${terminal} holds ${JSON.stringify(view.actual)} and the core's record says ${size}`);
        if (feed && `${feed[0].cols}x${feed[0].rows}` !== size) broken.push(`I10 ${terminal}'s emulator is ${feed[0].cols}x${feed[0].rows} and the core's record says ${size}`);
      }
      if (state.kind === "Live" && !liveAt.has(attach)) broken.push(`I3 ${terminal} is Live and its attach was never taken live`);
    }
    if (broken.length > 0) throw new Error(`after "${after}": ${broken.slice(0, 4).join(" | ")}`);
  };

  try {
    // every sequence starts with a tab shown and its panes on their way
    for (const terminal of terminals.slice(0, 2)) shown.set(terminal, { cols: 30, rows: 8, covered: false });
    apply();
    focus = terminals[0]!;
    screen.panes.focus(focus);
    await stage.settle();
    pass(512 * 1024);
    check("start");
    for (let step = 0; step < STEPS; step++) {
      const burst = chance(0.15) ? 3 : 1;
      const names: string[] = [];
      for (let part = 0; part < burst; part++) {
        const [, name, run] = draw();
        names.push(name);
        await run();
      }
      trace.push(names.join(" + "));
      await stage.settle();
      totals.steps++;
      check(names.join(" + "));
    }

    // I11: left alone, it settles. Faults and held replies end, the line comes back, and nothing more is asked of anyone
    Object.assign(screen.faults, { attach: null, create: false, write: null, resize: null, encode: null });
    screen.release();
    screen.hooks.notice = undefined;
    await rival.detach();
    await stage.settle();
    await reconnect();
    const quiet = () => `${screen.attaches.length} attaches, ${screen.calls.filter((call) => call.op !== "credit").length} frames`;
    let rest = "";
    for (let turn = 0; turn < 14; turn++) {
      stage.clock.now += 150;
      screen.fire();
      await stage.settle();
      pass(512 * 1024);
      await stage.settle();
      if (turn === 5) rest = quiet();
      if (turn > 5 && quiet() !== rest) broken.push(`I11 turn ${turn} of the quiet tail: ${quiet()}, after ${rest}`);
      trace.push("tail");
      check("the quiet tail");
    }
    // at rest every byte delivered to a pane that still shows a picture was fed
    for (const [emulator, feed] of fedBy) if (open(feed.attach) && !emulator.disposed && feed.next !== feed.attach.received.length) broken.push(`I13 emulator ${emulator.index} was fed ${feed.next} of ${feed.attach.received.length} frames`);
    check("the end");
  } catch (error) {
    // I12 too: nothing the machine does may throw
    throw new Error(`sequence seed ${seed} failed (replay: PANE_MODEL_ONLY=${seed}) ${error instanceof Error ? error.message : String(error)}\nsteps: ${trace.join(" > ")}`);
  } finally {
    await stage.close();
  }
}

it(`${ONLY ? 1 : SEQUENCES} seeded sequences keep every invariant after every step (seed ${ONLY ?? SEED})`, async () => {
  const totals: Totals = { steps: 0, attaches: 0, lives: 0, accepted: 0, refused: 0, takes: 0, reattaches: 0, lines: 0 };
  const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: SEQUENCES }, (_, index) => SEED * 100_003 + index);
  for (const seed of seeds) await sequence(seed, totals);
  console.log(`pane model: seed ${ONLY ?? SEED}, ${seeds.length} sequences, ${JSON.stringify(totals)}`);
  // the runs did reach what the invariants are about
  if (!ONLY) {
    expect(totals.steps).toBe(SEQUENCES * STEPS);
    expect(totals.lives).toBeGreaterThan(SEQUENCES * 2);
    expect(totals.accepted).toBeGreaterThan(SEQUENCES * 2);
    expect(totals.refused).toBeGreaterThan(SEQUENCES * 2);
    expect(totals.takes).toBeGreaterThan(SEQUENCES / 20);
    expect(totals.reattaches).toBeGreaterThan(SEQUENCES);
  }
}, 1_500_000);
