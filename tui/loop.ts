/**
 * Where the screen's modules meet: the host terminal, the input decoder, the core link, the pane machine, the state
 * core and the painter. The loop holds no rule of its own; it moves what one module answers to the module that acts
 * on it, in this order within a turn:
 *   1. host input -> the framer -> the reducer -> its effects, performed at once (typed bytes leave here, before any frame);
 *   2. when the one timer fires: whatever is due in the framer, the link, the panes, the model, a hold, a refused paste;
 *   3. a frame pass, at most every FRAME_PASS_MS: each shown pane's picture copied, ONE write, then credit (at most
 *      PASS_CREDIT_BYTES, the focused pane first, none when the write was not taken), then panes whose first paint was
 *      drawn go live after stdin was drained;
 *   4. the one timer armed again for the earliest deadline of all, or none.
 * Time and the timer are the caller's (`LoopClock`), so a test runs it on an injected clock.
 */

import type { HcTransport, HelloInfo } from "../server/herdr-core/connection.ts";
import type { PaneDirection } from "../server/herdr-core/layout-doc.ts";
import { type CoreLink, type LinkNotice, type LinkState, openLink } from "./core/link.ts";
import { createPanes, type PaneNotice, type Panes, type PanesOptions } from "./core/pane.ts";
import { CoreWorld, paneToward } from "./core/world.ts";
import type { Host, HostEnd } from "./host/index.ts";
import type { InputEvent } from "./input/decode.ts";
import { Framer } from "./input/framer.ts";
import { placeholderChrome } from "./view/chrome.ts";
import { type Deadlines, earliest, FRAME_PASS_MS, HOLD_RELEASE_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, QUIT_BOUND_MS, STYLE_TABLE_LIMIT, CRASH_ACTIONS_KEPT } from "./model/deadlines.ts";
import type { Effect } from "./model/effects.ts";
import { focused } from "./model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./model/reduce.ts";
import { PaneGrid } from "./view/grid.ts";
import { Painter, type PaneScene } from "./view/paint.ts";
import { layOut, paneScene, type ScreenShape } from "./view/screen.ts";

/** The caller's clock and its one timer: `arm` sets the timer for `at` (on the same clock) and answers its cancel. */
export interface LoopClock {
  now(): number;
  arm(at: number, fire: () => void): () => void;
}

export interface LoopOptions {
  host: Host;
  clock: LoopClock;
  /** the core's socket, as the entry worked it out */
  socket: string;
  /** herdr's parsed `[keys]` table (anything else: the defaults) */
  keys: unknown;
  /** reads herdr's `[keys]` table again, for the reload action */
  readKeys?: () => unknown;
  /** one attempt at the socket: the real socket transport unless a test wraps it */
  connect?: (path: string) => Promise<HcTransport>;
  createEmulator?: PanesOptions["createEmulator"];
  /** how long hello and each call wait (the connection's own 10 s unless a test shortens it) */
  timeoutMs?: number;
}

/**
 * How the screen ended: `quit` (the detach key: every channel closed, the terminal given back), `gone` (the host hung up
 * or a write failed), `signal` (the host gave the terminal back and ends the process), `no_core` and `incompatible`
 * (before the host was entered), `not_a_terminal`, `crashed` (an unexpected error: the caller restores the terminal
 * first, then writes the crash record).
 */
export type LoopEnd =
  | { kind: "quit" }
  | { kind: "gone"; why: "hangup" | "write-failed" }
  | { kind: "signal"; signal: "SIGINT" | "SIGTERM" }
  | { kind: "no_core"; code: string; reason: string }
  | { kind: "incompatible"; code: string; reason: string }
  | { kind: "not_a_terminal" }
  | { kind: "crashed"; error: unknown };

/** What a test and the crash record read of a running loop. */
export interface LoopReport {
  /** the timer armed now: 0 or 1, and the names due at its time */
  timers: number;
  due: string[];
  passes: number;
  /** frame writes handed to the host (an unchanged frame writes nothing) */
  writes: number;
  /** the last action codes: what happened, never what was typed or shown */
  actions: string[];
  hc: { version: string; features: string[] } | null;
  size: { cols: number; rows: number };
  mode: { name: string; locked: boolean; armed: boolean; overlays: string[] };
  link: LinkState["kind"];
}

export interface Loop {
  readonly done: Promise<LoopEnd>;
  report(): LoopReport;
  /** the state core's state now (tests read focus and notices) */
  model(): ModelState;
  /** An event from outside the host's input (a click turned into a `select`, a menu's `action`), through the state core now. */
  dispatch(event: ModelEvent): void;
  readonly panes: Panes;
  readonly link: CoreLink;
  /** the painter's composed screen: what the host shows once the last write was taken */
  screen(): Painter["screen"] | null;
}

const DIRECTIONS: Readonly<Record<string, PaneDirection>> = { focus_pane_left: "left", focus_pane_right: "right", focus_pane_up: "up", focus_pane_down: "down" };

export function startLoop(options: LoopOptions): Loop {
  const { host, clock } = options;
  const framer = new Framer();
  const world = new CoreWorld();
  const actions: string[] = [];
  const act = (code: string) => {
    actions.push(code);
    if (actions.length > CRASH_ACTIONS_KEPT) actions.shift();
  };

  let state = initialState(options.keys);
  let painter: Painter | null = null;
  /** the host answered DECRQM 2026 at start */
  let sync = false;
  let grids = new Map<string, { emulator: unknown; grid: PaneGrid }>();
  let shape: ScreenShape | null = null;
  let shownKey = "";
  let paneFocus: string | null = null;
  let hello: HelloInfo | null = null;
  let entered = false;
  let ended = false;
  let quitting: { at: number; settle: () => void } | null = null;
  /** every channel is being closed (quit, hang-up, a signal): nothing is drawn again, whatever arrives meanwhile */
  let closing = false;
  let passOwed = false;
  let lastPass = -Infinity;
  let passes = 0;
  let writes = 0;
  let draining = false;
  const holds = new Map<string, number>();
  let pasteAt: number | null = null;
  let timer: { at: number; cancel: () => void } | null = null;
  let firstState: ((state: LinkState) => void) | null = null;

  let resolveDone!: (end: LoopEnd) => void;
  const done = new Promise<LoopEnd>((resolve) => { resolveDone = resolve; });

  /** Ends the loop once: no timer, no frame, no write after this. */
  const end = (how: LoopEnd) => {
    if (ended) return;
    ended = true;
    timer?.cancel();
    timer = null;
    act(`end:${how.kind}`);
    resolveDone(how);
  };

  const fail = (error: unknown) => {
    if (ended) return;
    act("crash");
    end({ kind: "crashed", error });
    void panes.close().catch(() => {});
    void link.close().catch(() => {});
  };

  /** Runs one piece of a turn; an error nothing expected ends the screen as a crash. */
  const guard = (work: () => void) => {
    if (ended && !quitting) return;
    try {
      work();
    } catch (error) {
      fail(error);
    }
  };

  const link = openLink({
    socket: options.socket,
    now: () => clock.now(),
    model: { firstTurn: (terminal) => terminal.turn ?? 0, host: null },
    notify: (notice) => {
      guard(() => onLinkNotice(notice));
      arm();
    },
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const panes = createPanes({
    link,
    now: () => clock.now(),
    notify: (notice) => {
      guard(() => onPaneNotice(notice));
      arm();
    },
    ...(options.createEmulator ? { createEmulator: options.createEmulator } : {}),
  });

  function onLinkNotice(notice: LinkNotice): void {
    panes.notice(notice);
    if (notice.type === "state") {
      act(`link:${notice.state.kind}${"code" in notice.state ? `:${notice.state.code}` : ""}`);
      if (notice.state.kind !== "Connecting" && firstState) {
        const told = firstState;
        firstState = null;
        told(notice.state);
      }
      if (notice.state.kind === "Online") {
        const epoch = notice.state.epoch;
        void link.hello().then((info) => {
          if (link.state.kind === "Online" && link.state.epoch === epoch) {
            hello = info;
            world.setVersion(info.version);
          }
        }, () => {});
      }
      owePass();
      return;
    }
    if (world.notice(notice)) {
      dispatch({ type: "world", world: world.view().world, at: clock.now() });
      reshow();
    }
  }

  function onPaneNotice(notice: PaneNotice): void {
    if (notice.type === "hold") {
      if (notice.held) holds.set(notice.terminal, clock.now());
      else holds.delete(notice.terminal);
    }
    if (notice.type === "gone") grids.delete(notice.terminal);
    owePass();
  }

  /** One event through the state core, and its effects performed in order, now. */
  function dispatch(event: ModelEvent): void {
    const before = state;
    const step = reduce(state, event);
    state = step.state;
    for (const effect of step.effects) perform(effect);
    if (state !== before) {
      reshow();
      owePass();
    }
  }

  function perform(effect: Effect): void {
    switch (effect.type) {
      case "pane": {
        // each effect goes to the pane it names, in order: a prefix in a text run can move focus between two
        if (paneFocus !== effect.pane) {
          paneFocus = effect.pane;
          panes.focus(effect.pane);
        }
        const sent = panes.input(effect.input);
        act(`input:${effect.input.type}:${sent.sent ? "sent" : sent.code}`);
        if (!sent.sent && sent.notice) dispatch({ type: "notice", code: "input_refused", data: { reason: sent.code }, at: clock.now() });
        return;
      }
      case "run": {
        act(`run:${effect.action}`);
        const direction = DIRECTIONS[effect.action];
        if (direction && effect.target?.kind === "pane") {
          const tab = focused(state.world, state.focus).tab;
          const shapeOf = tab ? world.view().tabs.get(tab.id) : undefined;
          const toward = shapeOf ? paneToward(shapeOf, effect.target.id, direction) : null;
          if (toward !== null) dispatch({ type: "select", target: { kind: "pane", id: toward }, at: clock.now() });
          return;
        }
        // layout writes and the agent list come with later rows of the plan: one notice per press, never silence
        dispatch({ type: "notice", code: "not_built", data: { action: effect.action }, at: clock.now() });
        return;
      }
      case "quit":
        act("quit");
        quit();
        return;
      case "reload_keys":
        act("reload_keys");
        dispatch({ type: "keys", keys: options.readKeys ? options.readKeys() : options.keys, at: clock.now() });
        return;
      case "mouse":
        // the hit map's actions are row 27's; the event is dropped here
        act(`mouse:${effect.over}`);
        return;
      case "host_reply":
        return;
    }
  }

  /** The shown tab's panes with their cells, told to the pane machine when anything about them changed. */
  function reshow(): void {
    const size = host.size();
    const view = world.view();
    const tab = focused(state.world, state.focus).tab;
    shape = layOut(size.cols, size.rows, tab ? view.tabs.get(tab.id) ?? null : null, { sidebarCollapsed: state.sidebarCollapsed });
    const shown = shape.spots.map(({ pane, cells, covered }) => ({ terminal: pane, cols: cells.cols, rows: cells.rows, covered }));
    const key = JSON.stringify(shown);
    if (key !== shownKey) {
      shownKey = key;
      panes.show(shown);
    }
    const pane = focused(state.world, state.focus).pane?.id ?? null;
    if (pane !== paneFocus) {
      paneFocus = pane;
      panes.focus(pane);
    }
  }

  function owePass(): void {
    passOwed = true;
  }

  /** Bytes read from the host (or drained): events, each through the state core at once. */
  function read(bytes: Uint8Array): void {
    const events: InputEvent[] = framer.feed(bytes, clock.now());
    if (events.some((event) => event.type === "paste" && !event.complete)) pasteAt = clock.now() + PASTE_ABANDON_MS;
    else if (pasteAt !== null) pasteAt = events.length > 0 ? null : clock.now() + PASTE_ABANDON_MS;
    for (const event of events) {
      act(`read:${event.type}`);
      if (event.type === "focus") {
        panes.hostFocus(event.focused);
        // the host lost its screen meanwhile, or redrew it: the next frame writes every cell
        if (event.focused) painter?.invalidate();
      }
      dispatch(event);
    }
  }

  /** Everything due by the clock, then a frame pass when one is owed and FRAME_PASS_MS passed since the last. */
  function turn(): void {
    const now = clock.now();
    if (closing) {
      if (quitting && now >= quitting.at) quitting.settle();
      return;
    }
    for (const event of framer.tick(now)) dispatch(event);
    if (pasteAt !== null && now >= pasteAt) {
      pasteAt = null;
      framer.reset();
      act("paste_reset");
    }
    link.fire();
    panes.fire();
    for (const [name, at] of state.deadlines) if (at <= now) dispatch({ type: "deadline", name, at: now });
    for (const [terminal, since] of holds) {
      if (since + HOLD_RELEASE_MS > now) continue;
      holds.delete(terminal);
      panes.view(terminal)?.emulator?.releaseHold();
      owePass();
    }
    if (passOwed && painter && now >= lastPass + FRAME_PASS_MS) pass(now);
  }

  function pass(now: number): void {
    if (!painter || !shape || ended) return;
    passOwed = false;
    lastPass = now;
    passes++;
    // the style table only grows: past its limit the painter and every grid are made anew
    if (painter.styles.get(STYLE_TABLE_LIMIT) !== undefined) rebuildPainter();
    const scenes: PaneScene[] = [];
    const drawn = new Set<string>();
    for (const spot of shape.spots) {
      if (spot.covered) continue;
      const view = panes.view(spot.pane);
      const actual = view?.actual ?? { cols: spot.cells.cols, rows: spot.cells.rows };
      let held = grids.get(spot.pane);
      const emulator = view?.emulator ?? null;
      if (!held || held.emulator !== emulator) {
        held = { emulator, grid: new PaneGrid(painter.styles, actual.cols, actual.rows) };
        grids.set(spot.pane, held);
      }
      held.grid.resize(actual.cols, actual.rows);
      if (emulator) {
        held.grid.copy(emulator, held.grid.allDirty);
        drawn.add(spot.pane);
      }
      scenes.push(paneScene(spot, held.grid, actual, { live: view?.state.kind === "Live", hold: holds.has(spot.pane) }));
    }
    const size = host.size();
    const frame = painter.paint({
      width: size.cols, height: size.rows, parts: placeholderChrome(shape.regions, shape.spots.filter((spot) => !spot.covered).map((spot) => spot.cells)),
      panes: scenes, overlays: [], focus: paneFocus, input: null,
    });
    let taken = true;
    if (frame.bytes.length > 0) {
      writes++;
      taken = host.write(frame.bytes);
    }
    painter.taken(taken);
    if (ended || !taken) return;
    // credit after the write was taken: the focused pane first, then the others; a covered pane takes none
    let budget = PASS_CREDIT_BYTES;
    const order = [...shape.spots].filter((spot) => !spot.covered).sort((a, b) => Number(b.pane === paneFocus) - Number(a.pane === paneFocus));
    for (const spot of order) {
      if (budget <= 0) break;
      budget -= panes.credit(spot.pane, budget);
    }
    if (order.some((spot) => (panes.view(spot.pane)?.owed ?? 0) > 0)) owePass();
    const ready = [...drawn].filter((pane) => panes.view(pane)?.ready);
    if (ready.length > 0 && !draining) drainThenLive(ready);
  }

  /** What was typed before a pane's first paint was drawn is read (and refused there), then the pane is Live. */
  function drainThenLive(ready: string[]): void {
    draining = true;
    host.drain().then((bytes) => guard(() => {
      draining = false;
      if (bytes.length > 0) read(bytes);
      for (const pane of ready) if (panes.view(pane)?.ready) panes.live(pane);
      owePass();
      arm();
    }), fail);
  }

  function rebuildPainter(): void {
    if (!painter) return;
    painter = new Painter({ sync, colors: host.colorDepth });
    grids = new Map();
    act("painter_rebuilt");
  }

  /** Every deadline of every module, each under its own prefix, so two `failure` names stay apart. */
  function deadlines(): Deadlines {
    const all = new Map<string, number>();
    if (closing) return quitting ? all.set("quit", quitting.at) : all;
    const input = framer.deadline();
    if (input !== undefined) all.set("input", input);
    if (pasteAt !== null) all.set("paste", pasteAt);
    for (const [name, at] of link.deadlines()) all.set(`link:${name}`, at);
    for (const [name, at] of panes.deadlines()) all.set(`panes:${name}`, at);
    for (const [name, at] of state.deadlines) all.set(`model:${name}`, at);
    for (const since of holds.values()) all.set("hold", Math.min(all.get("hold") ?? Infinity, since + HOLD_RELEASE_MS));
    if (passOwed && painter) all.set("pass", Math.max(lastPass + FRAME_PASS_MS, clock.now()));
    return all;
  }

  /** The one timer, for the earliest deadline; none when there is none. */
  function arm(): void {
    if (ended && !quitting) return;
    const first = earliest(deadlines());
    if (timer && first && timer.at === first.at) return;
    timer?.cancel();
    timer = null;
    if (!first) return;
    const at = first.at;
    timer = { at, cancel: clock.arm(at, () => {
      timer = null;
      guard(turn);
      arm();
    }) };
  }

  /** Closes every pane channel and the event stream, and settles when they are answered or QUIT_BOUND_MS passed. */
  function closeAll(): Promise<void> {
    act("close_all");
    closing = true;
    const closes = Promise.allSettled([panes.close(), link.close()]);
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        quitting = null;
        timer?.cancel();
        timer = null;
        resolve();
      };
      quitting = { at: clock.now() + QUIT_BOUND_MS, settle };
      timer?.cancel();
      timer = null;
      arm();
      void closes.then(settle);
    });
  }

  function quit(): void {
    if (ended) return;
    void closeAll().then(() => {
      host.leave();
      end({ kind: "quit" });
    });
  }

  function onHostEnd(how: HostEnd): Promise<void> | void {
    if (ended) return;
    act(`host:${how.kind}`);
    // closeAll puts the loop in its closing state: no frame is drawn from here on
    return closeAll().then(() => {
      end(how.kind === "gone" ? { kind: "gone", why: how.why } : { kind: "signal", signal: how.signal });
    });
  }

  async function start(): Promise<void> {
    const first = await new Promise<LinkState>((resolve) => {
      if (link.state.kind !== "Connecting") resolve(link.state);
      else firstState = resolve;
    });
    if (ended) return;
    if (first.kind === "NoCore" || first.kind === "Incompatible") {
      void link.close().catch(() => {});
      end(first.kind === "NoCore" ? { kind: "no_core", code: first.code, reason: first.reason } : { kind: "incompatible", code: first.code, reason: first.reason });
      return;
    }
    if (!host.enter()) {
      void link.close().catch(() => {});
      end({ kind: "not_a_terminal" });
      return;
    }
    entered = true;
    framer.setModes({ mouse: true });
    host.onInput((bytes) => {
      guard(() => read(bytes));
      arm();
    });
    host.onResize((size) => {
      guard(() => {
        act("resize");
        rebuildPainter();
        dispatch({ type: "resize", cols: size.cols, rows: size.rows, at: clock.now() });
        reshow();
        owePass();
      });
      arm();
    });
    host.onEnd((how) => onHostEnd(how));
    const size = host.size();
    guard(() => {
      dispatch({ type: "resize", cols: size.cols, rows: size.rows, at: clock.now() });
      reshow();
    });
    const probe = await host.probe();
    if (ended) return;
    guard(() => {
      framer.setModes({ kitty: (probe.kittyFlags ?? 0) > 0 });
      sync = probe.syncOutput === true;
      painter = new Painter({ sync, colors: host.colorDepth });
      reshow();
      owePass();
    });
    arm();
  }

  void start().catch(fail);

  return {
    done,
    panes,
    link,
    model: () => state,
    dispatch: (event) => {
      guard(() => dispatch(event));
      arm();
    },
    screen: () => painter?.screen ?? null,
    report: () => {
      const first = earliest(deadlines());
      const due = first ? [...deadlines()].filter(([, at]) => at === first.at).map(([name]) => name) : [];
      return {
        timers: timer ? 1 : 0,
        due: timer ? due : [],
        passes,
        writes,
        actions: [...actions],
        hc: hello ? { version: hello.version, features: [...hello.features] } : null,
        size: entered ? host.size() : { cols: 0, rows: 0 },
        mode: { name: state.mode.name, locked: state.locked, armed: state.armed, overlays: state.overlays.map((overlay) => overlay.kind) },
        link: link.state.kind,
      };
    },
  };
}
