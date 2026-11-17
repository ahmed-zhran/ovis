/**
 * The screen's one key table: every row an action, the mode it works in and the keys that run it.
 * herdr's 52 actions and its six navigate keys come from the user's `[keys]` through
 * `resolveAllHerdrKeys` (shared/herdr-keys.ts); next to them stand the keys herdr fixes for its own
 * modes (the arrows, Enter and Escape of navigate and resize mode) and the screen's lock. Matching,
 * the mode bar and the help all read this one table.
 */
import { type HerdrAction, type HerdrChord, type HerdrKeptBinding, type HerdrKeyRefusal, type HerdrNavigateKey, parseHerdrBinding, resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import type { InputEvent } from "../input/decode.ts";

export type Mode = "terminal" | "navigate" | "resize" | "copy";

/** Actions only the screen's modes and its lock know. */
export type LocalAction = "lock" | "navigate_focus" | "navigate_cancel" | "navigate_index" | "navigate_cycle_next" | "navigate_cycle_previous" | "resize_leave" | "copy_leave";
export type KeyAction = HerdrAction | HerdrNavigateKey | LocalAction;

export interface KeyRow {
  readonly action: KeyAction;
  /** herdr's default for its own names ("" unbound); for the screen's rows the fixed keys */
  readonly default: string;
  readonly mode: Mode;
  /** "herdr": the user's config through herdr's resolver; "fixed": keys the screen gives a mode or the lock */
  readonly source: "herdr" | "fixed";
  readonly bindings: readonly HerdrKeptBinding[];
}

export interface Bound { readonly action: KeyAction; readonly index: number | null }

/** What the config writes that holds no key and is no refusal of the resolver. */
export type KeymapNote =
  | { readonly code: "indexed_legacy"; readonly entry: string }
  | { readonly code: "blank_binding"; readonly action: string }
  | { readonly code: "lock_unbound" };

type Lookup = Readonly<Record<string, Bound>>;

export interface Keymap {
  readonly configRead: boolean;
  readonly prefixes: readonly { readonly text: string; readonly chord: HerdrChord }[];
  readonly rows: readonly KeyRow[];
  readonly refusals: readonly HerdrKeyRefusal[];
  readonly notes: readonly KeymapNote[];
  /** lookups by `chordId` */
  readonly prefixIds: Readonly<Record<string, true>>;
  readonly afterPrefix: Lookup;
  /** Terminal mode without the prefix: herdr's direct bindings, then the lock */
  readonly direct: Lookup;
  readonly modeKeys: Readonly<Record<Exclude<Mode, "terminal">, Lookup>>;
}

/** The screen's own key for the lock, which herdr does not have: one chord that locks and unlocks. */
const LOCK_KEY = "ctrl+alt+g";

/** Keys herdr fixes for its modes, in herdr's key syntax, registered before the config's so they always work. */
const FIXED: readonly { readonly action: KeyAction; readonly mode: Exclude<Mode, "terminal">; readonly keys: readonly string[] }[] = [
  // herdr: the left and right arrows always focus the pane to that side in navigate mode
  { action: "navigate_pane_left", mode: "navigate", keys: ["left"] },
  { action: "navigate_pane_right", mode: "navigate", keys: ["right"] },
  { action: "navigate_focus", mode: "navigate", keys: ["enter"] },
  { action: "navigate_cancel", mode: "navigate", keys: ["esc", "ctrl+["] },
  { action: "navigate_index", mode: "navigate", keys: ["1..9"] },
  { action: "navigate_cycle_next", mode: "navigate", keys: ["tab"] },
  { action: "navigate_cycle_previous", mode: "navigate", keys: ["shift+tab"] },
  { action: "resize_pane_left", mode: "resize", keys: ["h", "left"] },
  { action: "resize_pane_down", mode: "resize", keys: ["j", "down"] },
  { action: "resize_pane_up", mode: "resize", keys: ["k", "up"] },
  { action: "resize_pane_right", mode: "resize", keys: ["l", "right"] },
  { action: "resize_leave", mode: "resize", keys: ["esc", "enter"] },
  { action: "copy_leave", mode: "copy", keys: ["esc", "q"] },
];

export function chordId(chord: HerdrChord): string {
  return `${+chord.ctrl}${+chord.alt}${+chord.shift}${+chord.meta}${+chord.hyper}:${chord.key}`;
}

/** A fixed key as a binding: a range is its nine digits, each with its index. */
function fixedBinding(text: string): HerdrKeptBinding {
  const parsed = parseHerdrBinding(text)!;
  const chords = parsed.range ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => ({ chord: { ...parsed.chord, key: String(index) }, index })) : [{ chord: parsed.chord, index: null }];
  return { text, prefixed: false, range: parsed.range, chords };
}

/** `binding` with only the chords `take` accepts (it records them); null when none is left. */
function kept(binding: HerdrKeptBinding, take: (chord: HerdrChord, index: number | null) => boolean): HerdrKeptBinding | null {
  const chords = binding.chords.filter(({ chord, index }) => take(chord, index));
  return chords.length === 0 ? null : { ...binding, chords };
}

function table(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The legacy `[keys.indexed]` entries (they bind nothing here) and written bindings that are only blanks (they unbind silently). */
function configNotes(keys: unknown, names: ReadonlySet<string>): KeymapNote[] {
  const written = table(keys) ?? {};
  const indexed = table(written["indexed"]) ?? {};
  const notes: KeymapNote[] = Object.entries(indexed).filter(([, value]) => typeof value === "string" && value.trim() !== "").map(([entry]) => ({ code: "indexed_legacy", entry }));
  for (const [name, value] of Object.entries(written)) {
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    if (names.has(name) && values.some((item) => typeof item === "string" && item !== "" && item.trim() === "")) notes.push({ code: "blank_binding", action: name });
  }
  return notes;
}

/** The key table for the user's `[keys]` table (anything else: herdr's defaults). Pure: it reads no file. */
export function buildKeymap(keys: unknown): Keymap {
  const resolved = resolveAllHerdrKeys(keys);
  const prefixIds: Record<string, true> = Object.fromEntries(resolved.prefixes.map(({ chord }) => [chordId(chord), true]));
  const afterPrefix: Record<string, Bound> = {};
  const direct: Record<string, Bound> = {};
  const rows: KeyRow[] = [];
  const claim = (lookup: Record<string, Bound>, action: KeyAction) => (chord: HerdrChord, index: number | null): boolean => {
    const id = chordId(chord);
    if (Object.hasOwn(lookup, id) || (lookup === direct && Object.hasOwn(prefixIds, id))) return false;
    lookup[id] = { action, index };
    return true;
  };
  for (const { action, default: defaults, bindings } of resolved.actions) {
    // the resolver already gave every chord to one action: these claims never collide
    for (const binding of bindings) kept(binding, claim(binding.prefixed ? afterPrefix : direct, action));
    rows.push({ action, default: defaults, mode: "terminal", source: "herdr", bindings });
  }
  const notes = configNotes(keys, new Set([...resolved.actions.map(({ action }) => action), ...resolved.navigate.map(({ name }) => name)]));
  const lock = kept(fixedBinding(LOCK_KEY), claim(direct, "lock"));
  if (lock === null) notes.push({ code: "lock_unbound" });
  rows.push({ action: "lock", default: LOCK_KEY, mode: "terminal", source: "fixed", bindings: lock === null ? [] : [lock] });

  const modeKeys = { navigate: {}, resize: {}, copy: {} } as Record<Exclude<Mode, "terminal">, Record<string, Bound>>;
  const fixedRows = new Map<string, HerdrKeptBinding[]>();
  for (const { action, mode, keys: texts } of FIXED) {
    const bindings = texts.flatMap((text) => kept(fixedBinding(text), claim(modeKeys[mode], action)) ?? []);
    fixedRows.set(`${mode}:${action}`, bindings);
  }
  // navigate mode is left with the prefix as well (herdr: "Esc, the prefix or Ctrl+[ cancels")
  for (const { text, chord } of resolved.prefixes) {
    if (claim(modeKeys.navigate, "navigate_cancel")(chord, null)) fixedRows.get("navigate:navigate_cancel")!.push({ text, prefixed: false, range: false, chords: [{ chord, index: null }] });
  }
  // resize mode is left with the key that entered it (the one after the prefix)
  for (const binding of rows.find((row) => row.action === "resize_mode")!.bindings.filter((b) => b.prefixed)) {
    const leave = kept({ ...binding, text: binding.text.replace(/^prefix\+/, "") }, claim(modeKeys.resize, "resize_leave"));
    if (leave !== null) fixedRows.get("resize:resize_leave")!.push(leave);
  }
  for (const name of new Set(resolved.navigate.map((entry) => entry.name))) {
    const entries = resolved.navigate.filter((entry) => entry.name === name);
    const bindings = [...fixedRows.get(`navigate:${name}`) ?? []];
    for (const { text, chord } of entries) {
      if (chord === null) continue;
      const binding = kept({ text, prefixed: false, range: false, chords: [{ chord, index: null }] }, claim(modeKeys.navigate, name));
      if (binding !== null) bindings.push(binding);
    }
    rows.push({ action: name, default: entries[0]!.default, mode: "navigate", source: "herdr", bindings });
  }
  for (const { action, mode, keys: texts } of FIXED) {
    if (rows.some((row) => row.action === action && row.mode === mode)) continue;
    rows.push({ action, default: texts.join(", "), mode, source: "fixed", bindings: fixedRows.get(`${mode}:${action}`)! });
  }
  return { configRead: resolved.configRead, prefixes: resolved.prefixes, rows, refusals: resolved.refusals, notes, prefixIds, afterPrefix, direct, modeKeys };
}

/** The lock's chords: the unlock chord exists exactly when this is not empty. */
export function unlockChords(keymap: Keymap): readonly HerdrChord[] {
  return keymap.rows.find((row) => row.action === "lock")?.bindings.flatMap((binding) => binding.chords.map(({ chord }) => chord)) ?? [];
}

// A key event's GhosttyKey name (tui/input/decode.ts) as herdr names the key in a binding.
const KEY_NAMES: Readonly<Record<string, string>> = {
  ENTER: "Enter", NUMPAD_ENTER: "Enter", TAB: "Tab", ESCAPE: "Escape", BACKSPACE: "Backspace", ARROW_LEFT: "ArrowLeft", ARROW_RIGHT: "ArrowRight",
  ARROW_UP: "ArrowUp", ARROW_DOWN: "ArrowDown", SPACE: " ", MINUS: "-", EQUAL: "=", BRACKET_LEFT: "[", BRACKET_RIGHT: "]", BACKSLASH: "\\",
  SEMICOLON: ";", QUOTE: "'", COMMA: ",", PERIOD: ".", SLASH: "/", BACKQUOTE: "`",
};

/**
 * The chords one typed character can match: a capital is shift with its letter, any other printable ASCII
 * character matches itself. A character outside printable ASCII matches no binding.
 */
export function charChords(char: string, alt: boolean): HerdrChord[] {
  if (!/^[\x20-\x7e]$/.test(char)) return [];
  const flags = { ctrl: false, alt, shift: false, meta: false, hyper: false };
  return [/^[A-Z]$/.test(char) ? { ...flags, shift: true, key: char.toLowerCase() } : { ...flags, key: char }];
}

/** The chords a key event can match. Shift is in the text of a key that types one (tui/input/decode.ts). */
export function keyChords(event: Extract<InputEvent, { type: "key" }>): HerdrChord[] {
  const { mods } = event;
  if (event.text !== undefined) return [...event.text].length === 1 ? charChords(event.text, Boolean(mods.alt)) : [];
  const name = event.key;
  const key = /^[A-Z]$/.test(name) ? name.toLowerCase() : /^DIGIT_[0-9]$/.test(name) ? name.slice(-1) : /^F\d{1,3}$/.test(name) ? name : KEY_NAMES[name];
  if (key === undefined) return [];
  return [{ ctrl: Boolean(mods.ctrl), alt: Boolean(mods.alt), shift: Boolean(mods.shift), meta: Boolean(mods.super), hyper: false, key }];
}

/** The first bound action among `chords` in `lookup`. */
export function boundIn(lookup: Lookup, chords: readonly HerdrChord[]): Bound | undefined {
  for (const chord of chords) {
    const id = chordId(chord);
    if (Object.hasOwn(lookup, id)) return lookup[id];
  }
  return undefined;
}

export function isPrefix(keymap: Keymap, chords: readonly HerdrChord[]): boolean {
  return chords.some((chord) => Object.hasOwn(keymap.prefixIds, chordId(chord)));
}
