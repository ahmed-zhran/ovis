import { describe, expect, it } from "bun:test";
import { type InputEvent, type Mods, typedKey } from "../input/decode.ts";
import { Framer } from "../input/framer.ts";
import type { Effect } from "./effects.ts";
import type { World } from "./focus.ts";
import { modeBar } from "./hints.ts";
import { OVERLAYS } from "./overlays.ts";
import { initialState, type Level, type ModelEvent, type ModelState, reduce, type Step } from "./reduce.ts";

const AT = 1_000;
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }, { id: "p2", name: "" }] }, { id: "t2", name: "b", panes: [{ id: "p3", name: "" }] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [{ id: "p4", name: "" }] }] },
  ],
};

const key = (char: string, mods: Mods = {}): InputEvent => ({ ...typedKey(char, mods), at: AT });
const named = (name: string, mods: Mods = {}): InputEvent => ({ type: "key", key: name, mods, action: "press", at: AT });
const text = (value: string): InputEvent => ({ type: "text", text: value, at: AT });
const paste = (value: string, complete = true): InputEvent => ({ type: "paste", text: value, complete, at: AT });
const mouse = (button: "left" | "wheelUp" = "left"): InputEvent => ({ type: "mouse", action: "press", button, mods: {}, col: 40, row: 10, at: AT });
// each call is a new object, so "the pane got exactly this event" is an identity check
const prefix = (): InputEvent => key("b", { ctrl: true });
const unlock = (): InputEvent => key("g", { ctrl: true, alt: true });

function start(keys?: unknown): ModelState {
  return reduce(initialState(keys), { type: "world", world: WORLD, at: 0 }).state;
}
function after(state: ModelState, ...events: ModelEvent[]): ModelState {
  return events.reduce((current, event) => reduce(current, event).state, state);
}
const paneInputs = (effects: readonly Effect[]) => effects.flatMap((effect) => effect.type === "pane" ? [effect.input] : []);
const focusedPane = (state: ModelState) => state.focus.panes[state.focus.tabs[state.focus.workspace!]!];

const idle = start();
const armed = after(idle, prefix());
const locked = after(idle, unlock());
const withHelp = after(idle, prefix(), text("?"));
const navigating = after(idle, prefix(), text("w"));
const copying = after(idle, prefix(), text("["));
const resizing = after(idle, prefix(), text("r"));
const directAlt = start({ new_tab: ["prefix+c", "alt+t"] });

describe("the ladder", () => {
  interface Row { level: Level; takes: boolean; name: string; state: ModelState; event: ModelEvent; levels: Level[]; pane: boolean; check?: (step: Step) => void }
  const rows: Row[] = [
    { level: 0, takes: true, name: "a host reply", state: idle, event: { type: "reply", kind: "color", data: "11;rgb:0000/0000/0000", at: AT }, levels: [0], pane: false,
      check: (step) => expect(step.effects).toEqual([{ type: "host_reply", kind: "color", data: "11;rgb:0000/0000/0000" }]) },
    { level: 0, takes: true, name: "an unknown sequence", state: armed, event: { type: "unknown", raw: "\x1b[999z", at: AT }, levels: [0], pane: false,
      check: (step) => expect(step.state.armed).toBe(true) },
    { level: 0, takes: true, name: "host focus", state: idle, event: { type: "focus", focused: true, at: AT }, levels: [0], pane: false },
    { level: 0, takes: true, name: "a host resize", state: idle, event: { type: "resize", cols: 100, rows: 30, at: AT }, levels: [0], pane: false },
    { level: 0, takes: true, name: "a host resize to no usable size is ignored", state: idle, event: { type: "resize", cols: Infinity, rows: -3, at: AT }, levels: [0], pane: false,
      check: (step) => expect(step.state.host).toEqual(idle.host) },
    { level: 0, takes: true, name: "a key release", state: idle, event: { ...key("x"), action: "release" } as InputEvent, levels: [0], pane: false },
    { level: 0, takes: true, name: "a paste refused at the limit", state: idle, event: paste("x".repeat(64), false), levels: [0], pane: false,
      check: (step) => expect(step.state.notices.map((notice) => notice.code)).toEqual(["paste_refused"]) },
    { level: 0, takes: false, name: "a key", state: idle, event: key("x"), levels: [6], pane: true },
    { level: 1, takes: true, name: "the unlock chord while locked", state: locked, event: unlock(), levels: [1], pane: false,
      check: (step) => expect(step.state.locked).toBe(false) },
    { level: 1, takes: true, name: "the prefix while locked goes straight to the pane", state: locked, event: prefix(), levels: [6], pane: true,
      check: (step) => expect(step.state.armed).toBe(false) },
    { level: 1, takes: true, name: "a bound key after nothing while locked", state: locked, event: text("?"), levels: [6], pane: true },
    { level: 1, takes: false, name: "text when not locked", state: idle, event: text("x"), levels: [6], pane: true },
    { level: 2, takes: true, name: "the prefix under an overlay", state: withHelp, event: prefix(), levels: [2], pane: false,
      check: (step) => { expect(step.state.armed).toBe(false); expect(step.state.overlays.map((overlay) => overlay.kind)).toEqual(["help"]); } },
    { level: 2, takes: true, name: "text under an overlay", state: withHelp, event: text("x"), levels: [2], pane: false },
    { level: 2, takes: true, name: "a paste under an overlay", state: withHelp, event: paste("hello"), levels: [2], pane: false },
    { level: 2, takes: true, name: "a click under an overlay", state: withHelp, event: mouse(), levels: [2], pane: false,
      check: (step) => expect(step.effects.map((effect) => effect.type === "mouse" ? effect.over : effect.type)).toEqual(["overlay"]) },
    { level: 2, takes: false, name: "a click with no overlay", state: idle, event: mouse(), levels: [6], pane: false,
      check: (step) => expect(step.effects.map((effect) => effect.type === "mouse" ? effect.over : effect.type)).toEqual(["screen"]) },
    { level: 3, takes: true, name: "an unbound key in Navigate", state: navigating, event: key("x"), levels: [3], pane: false,
      check: (step) => expect(step.effects).toEqual([]) },
    { level: 3, takes: true, name: "a navigate key", state: navigating, event: key("j"), levels: [3], pane: false,
      check: (step) => expect(step.effects).toEqual([{ type: "run", action: "focus_pane_down", target: { kind: "pane", id: "p1" }, index: null, name: null }]) },
    { level: 3, takes: true, name: "Escape leaves Resize mode", state: resizing, event: named("ESCAPE"), levels: [3], pane: false,
      check: (step) => expect(step.state.mode).toEqual({ name: "terminal" }) },
    { level: 3, takes: true, name: "a non-ASCII navigate key never fires", state: after(start({ navigate_pane_down: "\u{3153}" }), prefix(), text("w")), event: text("\u{3153}"), levels: [3], pane: false,
      check: (step) => { expect(step.effects).toEqual([]); expect(step.state.mode.name).toBe("navigate"); } },
    { level: 3, takes: true, name: "a text run in Copy, one code point at a time", state: copying, event: text("abc"), levels: [3, 3, 3], pane: false },
    { level: 3, takes: true, name: "a paste in Copy", state: copying, event: paste("abc"), levels: [3], pane: false },
    { level: 3, takes: false, name: "a navigate key in Terminal", state: idle, event: key("j"), levels: [6], pane: true },
    { level: 4, takes: true, name: "a direct binding on an Alt chord", state: directAlt, event: key("t", { alt: true }), levels: [4], pane: false,
      check: (step) => expect(step.state.overlays.map((overlay) => overlay.kind)).toEqual(["text"]) },
    { level: 4, takes: false, name: "text never matches a direct binding (the letter of alt+t)", state: directAlt, event: text("t"), levels: [6], pane: true },
    { level: 4, takes: false, name: "an unbound Alt chord", state: directAlt, event: key("y", { alt: true }), levels: [6], pane: true },
    { level: 4, takes: false, name: "a direct chord while the prefix is armed", state: after(directAlt, prefix()), event: key("t", { alt: true }), levels: [5], pane: false },
    { level: 5, takes: true, name: "the prefix chord", state: idle, event: prefix(), levels: [5], pane: false, check: (step) => expect(step.state.armed).toBe(true) },
    { level: 5, takes: true, name: "a key bound after the prefix", state: armed, event: text("c"), levels: [5], pane: false },
    { level: 5, takes: false, name: "the prefix twice", state: armed, event: prefix(), levels: [6], pane: true },
    { level: 5, takes: false, name: "a bound key without the prefix", state: idle, event: text("c"), levels: [6], pane: true },
    { level: 6, takes: true, name: "a key", state: idle, event: key("x"), levels: [6], pane: true },
    { level: 6, takes: true, name: "an unidentified key is never sent", state: idle, event: { type: "key", key: "UNIDENTIFIED", mods: {}, text: "\u{e000}", action: "press", at: AT }, levels: [6], pane: false },
  ];

  it("ladder table", () => {
    for (const row of rows) {
      const step = reduce(row.state, row.event);
      const label = `${row.level} ${row.takes ? "takes" : "passes"} ${row.name}`;
      expect({ label, levels: step.levels }).toEqual({ label, levels: row.levels });
      // a taken event reaches no lower level: nothing goes to a pane unless level 6 took it
      const inputs = paneInputs(step.effects);
      expect({ label, pane: inputs.length > 0 }).toEqual({ label, pane: row.pane });
      if (row.pane) expect({ label, inputs }).toEqual({ label, inputs: [row.event as never] });
      if (row.pane) expect(inputs[0]).toBe(row.event as never);
      row.check?.(step);
    }
    // every level has a row it takes and (above the pane) a row it passes on
    for (const level of [0, 1, 2, 3, 4, 5, 6] as Level[]) {
      expect({ level, takes: rows.some((row) => row.level === level && row.takes) }).toEqual({ level, takes: true });
      if (level < 6) expect({ level, passes: rows.some((row) => row.level === level && !row.takes) }).toEqual({ level, passes: true });
    }
  });
});

describe("the prefix machine", () => {
  interface Row { row: number; name: string; from: ModelState; events: ModelEvent[]; armed: boolean; pane: number[]; check?: (state: ModelState, steps: Step[]) => void }
  const unboundKey = named("F5");
  const rows: Row[] = [
    { row: 1, name: "Idle, a prefix chord: Armed, the mode bar shows the keys after the prefix", from: idle, events: [prefix()], armed: true, pane: [],
      check: (state) => { expect(modeBar(state).mode).toBe("prefix"); expect(modeBar(state).hints.map((hint) => hint.action)).toContain("new_tab"); } },
    { row: 1, name: "Idle, a prefix chord: Armed with no deadline, and still Armed however late a deadline event comes", from: idle,
      events: [prefix(), { type: "deadline", name: "prefix", at: AT + 86_400_000 }], armed: true, pane: [],
      check: (state) => expect([...state.deadlines.keys()]).toEqual([]) },
    { row: 2, name: "Armed, the prefix chord again: one literal prefix to the pane", from: idle, events: [prefix(), prefix()], armed: false, pane: [1] },
    { row: 3, name: "Armed, a text bound after the prefix: its action runs", from: armed, events: [text("c")], armed: false, pane: [],
      check: (state) => expect(state.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "new_tab", target: { kind: "workspace", id: "w1" } })]) },
    { row: 3, name: "Armed, a key bound after the prefix: its mode is entered", from: armed, events: [key("[")], armed: false, pane: [],
      check: (state) => expect(state.mode).toEqual({ name: "copy" }) },
    { row: 3, name: "Armed, 2 as text: 1..9 gives the index (tab 2)", from: armed, events: [text("2")], armed: false, pane: [],
      check: (state) => expect(state.focus.tabs["w1"]).toBe("t2") },
    { row: 3, name: "Armed, 2 then 1 as keys: tab 2 then tab 1", from: idle, events: [prefix(), named("DIGIT_2"), prefix(), named("DIGIT_1")], armed: false, pane: [],
      check: (state) => expect(state.focus.tabs["w1"]).toBe("t1") },
    { row: 4, name: "Armed, Escape: Idle, nothing sent", from: armed, events: [named("ESCAPE")], armed: false, pane: [],
      check: (state) => expect(state.overlays).toEqual([]) },
    { row: 4, name: "Armed, Escape: Idle even when a binding after the prefix names Escape", from: after(start({ help: ["prefix+?", "prefix+esc"] }), prefix()), events: [named("ESCAPE")], armed: false, pane: [],
      check: (state) => expect(state.overlays).toEqual([]) },
    { row: 4, name: "Armed, ctrl+[: Idle, nothing sent", from: armed, events: [key("[", { ctrl: true })], armed: false, pane: [],
      check: (state) => expect(state.mode).toEqual({ name: "terminal" }) },
    { row: 5, name: "Armed, a non-ASCII key bound after the prefix never fires: dropped, the Hangul rule applies", from: after(start({ new_tab: "prefix+\u{d55c}" }), prefix()),
      events: [text("\u{d55c}")], armed: false, pane: [],
      check: (state) => { expect(state.overlays).toEqual([]); expect(state.notices.map((notice) => notice.code)).toEqual(["ime_prefix"]); } },
    { row: 5, name: "Armed, an unbound text: dropped, Idle", from: armed, events: [text("y")], armed: false, pane: [] },
    { row: 5, name: "Armed, an unbound key: zero bytes to the pane, Idle", from: armed, events: [unboundKey], armed: false, pane: [],
      check: (state, steps) => expect(steps.flatMap((step) => step.effects)).toEqual([]) },
    { row: 5, name: "Armed, an unbound key, then the same key again reaches the pane", from: armed, events: [named("F5"), named("F5")], armed: false, pane: [1] },
    { row: 6, name: "Armed, a paste: Idle first, then the paste reaches the pane", from: armed, events: [paste("pasted")], armed: false, pane: [0] },
    { row: 6, name: "Armed, a mouse press: Idle first, then the screen gets it", from: armed, events: [mouse()], armed: false, pane: [],
      check: (_, steps) => expect(steps[0]!.effects.map((effect) => effect.type)).toEqual(["mouse"]) },
    { row: 6, name: "Armed, a wheel turn: Idle first", from: armed, events: [mouse("wheelUp")], armed: false, pane: [] },
    { row: 7, name: "Armed, host focus lost: Idle", from: armed, events: [{ type: "focus", focused: false, at: AT }], armed: false, pane: [] },
    { row: 7, name: "Armed, the keymap loaded again: Idle", from: armed, events: [{ type: "keys", keys: {}, at: AT }], armed: false, pane: [] },
  ];

  it("prefix table", () => {
    for (const row of rows) {
      const steps: Step[] = [];
      let state = row.from;
      for (const event of row.events) {
        const step = reduce(state, event);
        steps.push(step);
        state = step.state;
      }
      const label = `row ${row.row}: ${row.name}`;
      expect({ label, armed: state.armed }).toEqual({ label, armed: row.armed });
      // exactly these events reached the pane, each whole and once
      const sent = steps.flatMap((step) => paneInputs(step.effects));
      expect({ label, sent: sent.length }).toEqual({ label, sent: row.pane.length });
      row.pane.forEach((index, i) => expect(sent[i]).toBe(row.events[index] as never));
      row.check?.(state, steps);
    }
    expect(new Set(rows.map((row) => row.row))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
  });

  it("hangul after prefix gives a notice", () => {
    const step = reduce(armed, text("\u{d55c}"));
    expect(paneInputs(step.effects)).toEqual([]);
    expect(step.state.armed).toBe(false);
    expect(step.state.notices.map((notice) => notice.code)).toEqual(["ime_prefix"]);
    // a second time replaces the notice instead of stacking it
    const again = after(step.state, prefix(), text("\u{d55c}"));
    expect(again.notices.map((notice) => notice.code)).toEqual(["ime_prefix"]);
    // an unbound ASCII key after the prefix is dropped without that notice
    expect(after(armed, text("y")).notices).toEqual([]);
  });
});

describe("hangul once", () => {
  const word = "\u{d55c}\u{ae00}";

  it("reaches the pane exactly once, whole or cut at every offset", () => {
    const whole = reduce(idle, text(word));
    expect(paneInputs(whole.effects).map((input) => input.type === "text" && input.text)).toEqual([word]);
    const bytes = new TextEncoder().encode(word);
    for (let cut = 1; cut < bytes.length; cut++) {
      const framer = new Framer();
      const events = [...framer.feed(bytes.slice(0, cut), AT), ...framer.feed(bytes.slice(cut), AT + 1)];
      let state = idle;
      const sent: string[] = [];
      for (const event of events) {
        const step = reduce(state, event);
        const inputs = paneInputs(step.effects);
        expect(inputs.length).toBeLessThanOrEqual(1);
        for (const input of inputs) sent.push(input.type === "text" ? input.text : "?");
        state = step.state;
      }
      expect({ cut, sent: sent.join("") }).toEqual({ cut, sent: word });
    }
  });

  it("when Armed, the first is dropped as the key after the prefix and the second reaches the pane once", () => {
    const step = reduce(armed, text(word));
    expect(paneInputs(step.effects).map((input) => input.type === "text" && input.text)).toEqual(["\u{ae00}"]);
    expect(step.state.armed).toBe(false);
  });

  it("in a rename field inserts two graphemes", () => {
    const renaming = after(idle, prefix(), key("P"));
    expect(renaming.overlays).toEqual([expect.objectContaining({ kind: "text", purpose: "rename_pane" })]);
    const step = reduce(renaming, text(word));
    expect(paneInputs(step.effects)).toEqual([]);
    const top = step.state.overlays.at(-1)!;
    expect(top.kind === "text" && top.field.graphemes).toEqual(["\u{d55c}", "\u{ae00}"]);
  });
});

describe("overlay close keys", () => {
  it("every key an overlay declares closes it, and is the one way a key closes it", () => {
    const open: Record<keyof typeof OVERLAYS, ModelState> = {
      help: after(idle, prefix(), text("?")),
      text: after(idle, prefix(), key("P")),
      confirm: after(idle, prefix(), key("D")),
      goto: after(idle, prefix(), text("g")),
    };
    for (const [kind, entry] of Object.entries(OVERLAYS)) {
      const state = open[kind as keyof typeof OVERLAYS];
      expect(state.overlays.map((overlay): string => overlay.kind)).toEqual([kind]);
      for (const closeKey of entry.closeKeys) {
        const event = closeKey === "esc" ? named("ESCAPE") : key(closeKey);
        expect({ kind, closeKey, open: reduce(state, event).state.overlays.length }).toEqual({ kind, closeKey, open: 0 });
      }
    }
    // a key that is not declared does not close help
    expect(reduce(open.help, key("x")).state.overlays.length).toBe(1);
  });
});

describe("focus moves by key stay local", () => {
  it("cycles panes and keeps the previous pane", () => {
    const moved = after(idle, prefix(), named("TAB"));
    expect(focusedPane(moved)).toBe("p2");
    expect(moved.focus.previous).toBe("p1");
    expect(focusedPane(after(moved, prefix(), named("TAB", { shift: true })))).toBe("p1");
  });
});
