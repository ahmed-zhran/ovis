import { describe, expect, it } from "bun:test";
import { type HerdrChord, parseHerdrBinding, resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import { decodeControl, decodeCsi, decodeSs3, type InputEvent, type Mods, typedKey } from "../input/decode.ts";
import type { World } from "./focus.ts";
import { helpRows, modeBar } from "./hints.ts";
import { buildKeymap, chordId, type KeyAction, type Keymap, type Mode } from "./keymap.ts";
import { initialState, type ModelState, reduce } from "./reduce.ts";

// The key table over random configs: what the help and the mode bar show fires, what fires is shown, and every binding
// the resolver keeps that the table leaves out has one note. MODEL_SEED picks the run; OVIS_TUI_MODEL_SEQUENCES sets
// how many configs (default 300; the evidence runs use 3000).
const SEED = Number(process.env["MODEL_SEED"] ?? "1");
const CONFIGS = Number(process.env["OVIS_TUI_MODEL_SEQUENCES"] ?? "300");
const AT = 1_000;

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every key name the host input decoder can deliver, asked of the decoder itself: control bytes, CSI ~ / u / letter
// forms and SS3. A chord on a name outside this set has no event.
const DELIVERED = new Set<string>();
const keep = (event: ReturnType<typeof decodeSs3>) => { if (event?.type === "key") DELIVERED.add(event.key); };
for (const byte of [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f]) if (byte !== 0x1b) keep(decodeControl(byte, false));
for (let n = 1; n <= 40; n++) keep(decodeCsi(String(n), "~", false));
for (const n of [9, 13, 27, 127, ...Array.from({ length: 120 }, (_, i) => 57344 + i)]) keep(decodeCsi(String(n), "u", false));
for (const final of "ABCDEFGHPQRSZ") keep(decodeCsi("", final, false));
for (let c = 0x40; c < 0x7f; c++) keep(decodeSs3(String.fromCharCode(c)));
const NAME_OF: Readonly<Record<string, string>> = {
  Enter: "ENTER", Tab: "TAB", Escape: "ESCAPE", Backspace: "BACKSPACE", ArrowLeft: "ARROW_LEFT", ArrowRight: "ARROW_RIGHT", ArrowUp: "ARROW_UP", ArrowDown: "ARROW_DOWN",
};

/** The input events the decoder could deliver for `chord`: none for hyper (the decoder drops such a sequence) or an undeliverable key. */
function eventsFor(chord: HerdrChord): InputEvent[] {
  if (chord.hyper) return [];
  const mods: Mods = { ...(chord.ctrl ? { ctrl: true } : {}), ...(chord.alt ? { alt: true } : {}), ...(chord.shift ? { shift: true } : {}), ...(chord.meta ? { super: true } : {}) };
  if ([...chord.key].length === 1) {
    const typed: InputEvent = { ...typedKey(chord.key, mods), at: AT };
    // a plain typed character also arrives as a text run
    return typed.type === "key" && typed.text !== undefined && !chord.alt ? [typed, { type: "text", text: typed.text, at: AT }] : [typed];
  }
  const name = NAME_OF[chord.key] ?? chord.key;
  return DELIVERED.has(name) ? [{ type: "key", key: name, mods, action: "press", at: AT }] : [];
}

const INDEXED = new Set(["switch_tab", "switch_workspace", "focus_agent", "navigate_index"]);

/** The chords a shown key text stands for, each with its index. */
function chordsOf(text: string, action: string): { chord: HerdrChord; index: number | null; prefixed: boolean }[] {
  const binding = parseHerdrBinding(text);
  if (binding === null) return [];
  const chords = binding.range ? Array.from({ length: 9 }, (_, i) => ({ ...binding.chord, key: String(i + 1) })) : [binding.chord];
  return chords.map((chord) => ({ chord, prefixed: binding.prefixed, index: INDEXED.has(action) && /^[1-9]$/.test(chord.key) ? Number(chord.key) : null }));
}

/** Whether one of the events for `chord` does in `state` exactly what the action itself does there. */
function fires(state: ModelState, action: KeyAction, chord: HerdrChord, index: number | null): boolean {
  const ref = reduce(state, { type: "action", action, index: index ?? undefined, at: AT });
  return eventsFor(chord).some((event) => {
    const step = reduce(state, event);
    return Bun.deepEquals(step.state, ref.state) && Bun.deepEquals(step.effects, ref.effects);
  });
}

const MODIFIERS = ["ctrl", "alt", "shift", "cmd", "super", "hyper", "meta", "control", "option"];
const KEYS = [
  ..."abcghjklnqvxz", "A", "N", ..."0159", ..."-=[];',./`\\", ..."!?$%^&*()_+{}:<>~\"|@#",
  "space", "enter", "tab", "esc", "escape", "left", "right", "up", "down", "backspace", "minus", "comma", "plus",
  "f1", "f5", "f12", "f13", "f20", "f25", "f26", "f30", "\u314a", "\u00e9", "\u{1f600}", "\u{d55c}",
];
const SPECIAL = ["ctrl+alt+g", "esc", "ctrl+[", "left", "right", "shift+tab", "prefix+esc", "prefix+ctrl+[", "", " ", "prefix+1..9", "prefix+shift+1..9", "ctrl+b", "prefix+ctrl+b", "prefix+hyper+v", "prefix+\u314a", "nonsense+x"];
const ACTIONS = resolveAllHerdrKeys(undefined).actions.map((action) => action.action);
const NAVIGATE = ["navigate_workspace_up", "navigate_workspace_down", "navigate_pane_left", "navigate_pane_down", "navigate_pane_up", "navigate_pane_right"];

function config(rnd: () => number): Record<string, unknown> {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const binding = (prefixed: number): string => {
    if (rnd() < 0.12) return pick(SPECIAL);
    const mods = MODIFIERS.filter(() => rnd() < 0.15);
    return [...(rnd() < prefixed ? ["prefix"] : []), ...mods, rnd() < 0.05 ? "1..9" : pick(KEYS)].join("+");
  };
  const value = (prefixed: number) => rnd() < 0.7 ? binding(prefixed) : [binding(prefixed), binding(prefixed)];
  const keys: Record<string, unknown> = {};
  for (const action of ACTIONS) if (rnd() < 0.3) keys[action] = value(0.65);
  for (const name of NAVIGATE) if (rnd() < 0.3) keys[name] = value(0.05);
  if (rnd() < 0.3) keys["prefix"] = binding(0);
  if (rnd() < 0.1) keys["extra_prefixes"] = [binding(0)];
  if (rnd() < 0.1) keys["command"] = [{ key: binding(0.5), command: "x" }];
  if (rnd() < 0.05) keys["bogus_action"] = binding(0.5);
  return keys;
}

const pane = (id: string) => ({ id, name: "" });
const WORLD: World = {
  workspaces: [
    { id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [pane("p1"), pane("p2")] }, { id: "t2", name: "b", panes: [pane("p3"), pane("p4")] }] },
    { id: "w2", name: "two", tabs: [{ id: "t3", name: "c", panes: [pane("p5"), pane("p6")] }, { id: "t4", name: "d", panes: [pane("p7")] }] },
  ],
};

class PropertyError extends Error {}
function check(condition: boolean, what: string): asserts condition {
  if (!condition) throw new PropertyError(what);
}

/** The states the table's rows are shown in: Idle, Armed, each mode and locked (null when the screen cannot get there). */
function states(keymap: Keymap, keys: unknown): Record<"idle" | "armed" | Exclude<Mode, "terminal"> | "locked", ModelState | null> {
  let idle = reduce(initialState(keys), { type: "world", world: WORLD, at: 0 }).state;
  idle = reduce(idle, { type: "select", target: { kind: "pane", id: "p2" }, at: 0 }).state;
  const arming = keymap.prefixes.flatMap(({ chord }) => eventsFor(chord)).map((event) => reduce(idle, event).state).find((state) => state.armed) ?? null;
  const mode = (action: KeyAction) => reduce(idle, { type: "action", action, at: AT }).state;
  const locked = mode("lock");
  return { idle, armed: arming, navigate: mode("workspace_picker"), resize: mode("resize_mode"), copy: mode("copy_mode"), locked: locked.locked ? locked : null };
}

function checkConfig(keys: Record<string, unknown>): void {
  const keymap = buildKeymap(keys);
  const resolved = resolveAllHerdrKeys(keys);
  const at = states(keymap, keys);
  const notes = keymap.notes as readonly { code: string; action?: string; binding?: string }[];
  const notesFor = (action: string, binding: string) => notes.filter((note) => note.action === action && note.binding === binding);

  // (a) every key text the help shows fires its action in the state it is shown in
  const shown = new Set<string>();
  for (const row of helpRows(keymap)) {
    for (const text of row.keys) {
      for (const { chord, index, prefixed } of chordsOf(text, row.action)) {
        const level = row.mode === "terminal" ? (row.action === "lock" ? "direct" : prefixed ? "after" : "direct") : row.mode;
        shown.add(`${level}|${row.action}|${chordId(chord)}`);
        const state = level === "after" ? at.armed : level === "direct" ? at.idle : at[row.mode as Exclude<Mode, "terminal">];
        check(state !== null, `${row.action} "${text}" is shown in a state the screen cannot reach`);
        check(fires(state, row.action, chord, index), `${row.mode} ${row.action} "${text}" is shown but no input event fires it`);
      }
    }
  }
  if (at.locked !== null) for (const text of helpRows(keymap).find((row) => row.action === "lock")!.keys) {
    for (const { chord } of chordsOf(text, "lock")) check(fires(at.locked, "lock", chord, null), `the unlock chord "${text}" does not unlock`);
  }
  for (const { text, chord } of keymap.prefixes) check(eventsFor(chord).some((event) => reduce(at.idle!, event).state.armed), `the prefix "${text}" is shown but no input event arms it`);
  // Escape and ctrl+[ end an armed prefix and run nothing, whatever the config binds, unless the key is a prefix itself
  if (at.armed !== null) {
    for (const text of ["esc", "ctrl+["]) {
      const chord = parseHerdrBinding(text)!.chord;
      const literal = keymap.prefixes.some((prefix) => chordId(prefix.chord) === chordId(chord));
      for (const event of eventsFor(chord)) {
        const step = reduce(at.armed, event);
        check(!step.state.armed && step.state.overlays.length === 0 && step.state.mode.name === "terminal", `${text} after the prefix did more than end it`);
        check(step.effects.every((effect) => literal && effect.type === "pane"), `${text} after the prefix ran something`);
      }
    }
  }

  // the mode bar shows what the help shows for that state
  const helpKeys = (filter: (mode: Mode, text: string) => boolean, strip: boolean) => helpRows(keymap).flatMap((row) => {
    const keysShown = row.keys.filter((text) => filter(row.mode, text)).map((text) => strip ? text.replace(/^prefix\+/, "") : text);
    return keysShown.length === 0 ? [] : [{ action: row.action, keys: keysShown }];
  });
  if (at.armed !== null) check(Bun.deepEquals(modeBar(at.armed).hints, helpKeys((mode, text) => mode === "terminal" && text.startsWith("prefix+"), true)), "the armed mode bar differs from the help");
  for (const mode of ["navigate", "resize", "copy"] as const) check(Bun.deepEquals(modeBar(at[mode]!).hints, helpKeys((m) => m === mode, false)), `the ${mode} mode bar differs from the help`);
  check(Bun.deepEquals(modeBar(at.idle!).hints[0]!.keys, keymap.prefixes.map((prefix) => prefix.text)), "the idle mode bar's prefixes differ from the table's");

  // (b) and (d): the table is the resolver's minus the bindings it drops, and each drop has exactly one note
  check(Bun.deepEquals(keymap.prefixes, resolved.prefixes.filter(({ text }) => notesFor("prefix", text).length === 0)), "the prefixes are the resolver's minus the noted ones");
  for (const { text } of resolved.prefixes) check(notesFor("prefix", text).length <= 1, `prefix "${text}" has more than one note`);
  for (const { action, bindings } of resolved.actions) {
    const row = keymap.rows.find((r) => r.action === action && r.mode === "terminal")!;
    check(Bun.deepEquals(row.bindings, bindings.filter((binding) => notesFor(action, binding.text).length === 0)), `${action}: the table is the resolver's minus the noted bindings`);
    for (const binding of bindings) check(notesFor(action, binding.text).length <= 1, `${action} "${binding.text}" has more than one note`);
  }
  for (const { name, text, chord } of resolved.navigate) {
    if (chord === null) continue;
    const row = keymap.rows.find((r) => r.action === name && r.mode === "navigate")!;
    const noted = notesFor(name, text).length;
    check(noted <= 1, `${name} "${text}" has more than one note`);
    check(noted === 1 || row.bindings.some((binding) => binding.text === text && binding.chords.some((c) => chordId(c.chord) === chordId(chord))), `${name} "${text}" is kept by the resolver, not shown and has no note`);
  }

  // (c) nothing fires that is not shown: every chord the matching looks up is a shown key of that level
  const lookups: [string, Readonly<Record<string, { action: KeyAction }>>][] = [["after", keymap.afterPrefix], ["direct", keymap.direct], ...(["navigate", "resize", "copy"] as const).map((mode): [string, Readonly<Record<string, { action: KeyAction }>>] => [mode, keymap.modeKeys[mode]])];
  for (const [level, lookup] of lookups) {
    for (const [id, bound] of Object.entries(lookup)) check(shown.has(`${level}|${bound.action}|${id}`), `${level} ${bound.action} on ${id} fires but is not shown`);
  }
  const shownPrefixes = new Set(keymap.prefixes.map(({ chord }) => chordId(chord)));
  for (const id of Object.keys(keymap.prefixIds)) check(shownPrefixes.has(id), `the prefix ${id} arms but is not shown`);
}

describe("the key table over random configs", () => {
  it(`shows only what fires, notes every drop and follows the resolver over ${CONFIGS} configs (seed ${SEED})`, () => {
    let bindings = 0;
    let notes = 0;
    for (let n = 0; n < CONFIGS; n++) {
      const keys = config(random(SEED * 1_000_003 + n));
      try {
        checkConfig(keys);
      } catch (error) {
        if (error instanceof PropertyError) throw new Error(`seed ${SEED} config ${n}: ${error.message}\n${JSON.stringify(keys)}`);
        throw error;
      }
      const keymap = buildKeymap(keys);
      bindings += keymap.rows.reduce((sum, row) => sum + row.bindings.length, 0);
      notes += keymap.notes.length;
    }
    // the generator reached both sides: many bindings shown and many dropped with a note
    expect(bindings).toBeGreaterThan(CONFIGS * 10);
    expect(notes).toBeGreaterThan(CONFIGS / 10);
  });
});
