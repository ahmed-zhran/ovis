/**
 * The screen's one key table: every row an action, the mode it works in and the keys that run it.
 * herdr's 52 actions and its six navigate keys come from the user's `[keys]` through
 * `resolveAllHerdrKeys` (shared/herdr-keys.ts); next to them stand the keys herdr fixes for its own
 * modes (the arrows, Enter and Escape of navigate and resize mode) and the screen's lock. Matching,
 * the mode bar and the help all read this one table.
 */
import { type HerdrAction, type HerdrChord, type HerdrKeptBinding, type HerdrKeyRefusal, type HerdrNavigateKey, parseHerdrBinding, resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import { decodeControl, decodeCsi, decodeSs3, type InputEvent, typedKey } from "../input/decode.ts";

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

/**
 * Why no input event can ever fire a binding the resolver keeps, so the table drops it. Each reason is a fact
 * of the host input decoder (tui/input/decode.ts) or of the ladder:
 * - no_such_modifier: a key event carries only shift, alt, ctrl and super; the decoder drops a sequence with
 *   hyper or meta (its UNSENDABLE_BITS), so a chord with hyper never arrives.
 * - not_typable: a character outside printable ASCII arrives as text or an UNIDENTIFIED key, which match no
 *   chord, and a named key the decoder never names (F26 and up) has no event.
 * - shift_in_text: without ctrl or super a key that types text carries shift in the text, not in its mods
 *   (typedKey). shift+1 arrives as "!" and is matched as "!" (see `delivered`); shift with a key whose text
 *   shift does not change (space, "!") arrives as that key alone and never matches.
 * - shifted_character: with ctrl or super the decoder names a character typed with shift by its base key and
 *   shift (typedKey): ctrl+! arrives as ctrl+shift+1.
 * - cancel_key: after the prefix, Escape and ctrl+[ end the prefix before a binding is looked up.
 * - fixed_key: a key the screen fixes for that mode holds it first (for another action: the same one is no drop).
 * Chords these leave in can fire, some only on a host with the kitty keyboard flag (ctrl+shift+1, ctrl+1,
 * super chords): there the decoder reports them whole.
 */
export type DropCode = "no_such_modifier" | "not_typable" | "shift_in_text" | "shifted_character" | "cancel_key" | "fixed_key";

/** A key of a fallback list passed over, and what holds it. */
export interface Skipped { readonly key: string; readonly holder: string }

/** What the config writes that holds no key and is no refusal of the resolver. */
export type KeymapNote =
  | { readonly code: "indexed_legacy"; readonly entry: string }
  | { readonly code: "blank_binding"; readonly action: string }
  /** the lock's chord is held by `holder` (an action, "prefix" or "command"), so the lock has no key */
  | { readonly code: "lock_taken"; readonly holder: string }
  /** a binding the resolver keeps that no input event can fire (`action` is "prefix" for a prefix key) */
  | { readonly code: DropCode; readonly action: string; readonly binding: string }
  /**
   * two bindings the screen reads as one key (shift+2 and "@" both arrive as "@"), or one on the fallback prefix or
   * the detach fallback: `holder` (an action, "prefix" or "detach") keeps the key. `binding` is the one digit a
   * range lost ("prefix+shift+3") when it keeps the others.
   */
  | { readonly code: "taken"; readonly action: string; readonly binding: string; readonly holder: string }
  /** no prefix key can be typed: `binding`, herdr's `prefix`, cannot for `reason`, and `fallback` stands in for it */
  | { readonly code: "prefix_fallback"; readonly action: "prefix"; readonly binding: string; readonly reason: DropCode; readonly fallback: string; readonly skipped: readonly Skipped[] }
  /** no key of detach can fire: `fallback`, after the prefix, quits */
  | { readonly code: "detach_fallback"; readonly fallback: string; readonly skipped: readonly Skipped[] };

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

// The screen's own lock chord (herdr has no lock), pending the owner's decision on how the lock is switched.
const LOCK_KEY = "ctrl+alt+g";

/**
 * The prefix when none of the config's can be typed: herdr's default, then the next one no direct binding holds. Each
 * is one control byte every terminal sends, and none is a key a shell needs (ctrl+c, ctrl+d, ctrl+z), flow control
 * (ctrl+s, ctrl+q), Tab, Enter, Backspace or Escape. When all are held, herdr's default takes its key back.
 */
const FALLBACK_PREFIXES = ["ctrl+b", "ctrl+a", "ctrl+]", "ctrl+\\"] as const;

/** detach when none of its keys can fire, so the screen can always be left by key: herdr's default, then the next free one. */
const FALLBACK_DETACH = ["prefix+q", "prefix+ctrl+q", "prefix+alt+q"] as const;

/** The keys that always leave an armed prefix (and navigate mode). */
const CANCEL_KEYS = ["esc", "ctrl+["] as const;

/** Keys herdr fixes for its modes, in herdr's key syntax, registered before the config's so they always work. */
const FIXED: readonly { readonly action: KeyAction; readonly mode: Exclude<Mode, "terminal">; readonly keys: readonly string[] }[] = [
  // herdr: the left and right arrows always focus the pane to that side in navigate mode
  { action: "navigate_pane_left", mode: "navigate", keys: ["left"] },
  { action: "navigate_pane_right", mode: "navigate", keys: ["right"] },
  { action: "navigate_focus", mode: "navigate", keys: ["enter"] },
  { action: "navigate_cancel", mode: "navigate", keys: CANCEL_KEYS },
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

const CANCEL_IDS: ReadonlySet<string> = new Set(CANCEL_KEYS.map((text) => chordId(parseHerdrBinding(text)!.chord)));

/**
 * The chord as the matching sees it. Without ctrl or super the decoder puts shift into the text of a key that types
 * one (typedKey): shift+2 arrives as "@", alt+shift+1 as alt and "!", so such a chord is matched by the character
 * the decoder gives for it (herdr matches them through its table of shifted symbols).
 */
function delivered(chord: HerdrChord): HerdrChord {
  if (!chord.shift || chord.ctrl || chord.meta || !/^[\x20-\x7e]$/.test(chord.key) || /^[a-z]$/.test(chord.key)) return chord;
  const text = typedKey(chord.key, { shift: true }).text;
  return text === undefined || text === chord.key ? chord : { ...chord, shift: false, key: text };
}

/** The lookup id of `chord`: the one of the chord the decoder delivers for it. */
const matchId = (chord: HerdrChord): string => chordId(delivered(chord));

/** The levels a binding is matched at. */
type Level = "prefix" | "direct" | "after_prefix" | "navigate";

/** Why no input event can fire `chord` at `level` (see DropCode), or null when one can. `fixed`: the chords the screen fixes there. */
function dropReason(chord: HerdrChord, level: Level, fixed: ReadonlySet<string>): DropCode | null {
  if (chord.hyper) return "no_such_modifier";
  const char = /^[\x20-\x7e]$/.test(chord.key);
  if (!char && !NAMED_KEYS.has(chord.key)) return "not_typable";
  if (char && !/^[a-z]$/.test(chord.key)) {
    if (chord.ctrl || chord.meta) {
      if (typedKey(chord.key, { ctrl: true }).mods.shift) return "shifted_character";
    } else if (chord.shift && delivered(chord) === chord) return "shift_in_text";
  }
  if (level === "after_prefix" && CANCEL_IDS.has(matchId(chord))) return "cancel_key";
  if (fixed.has(matchId(chord))) return "fixed_key";
  return null;
}

/** The first of `texts` (bindings) whose chord `holderOf` finds free, with those passed over; when none is, the first `canTake`. */
function firstFree(texts: readonly string[], holderOf: (chord: HerdrChord) => string | null, canTake: (holder: string) => boolean): { text: string; chord: HerdrChord; skipped: Skipped[] } | null {
  const skipped: Skipped[] = [];
  for (const text of texts) {
    const chord = parseHerdrBinding(text)!.chord;
    const holder = holderOf(chord);
    if (holder === null) return { text, chord, skipped };
    skipped.push({ key: text, holder });
  }
  const taken = skipped.find(({ holder }) => canTake(holder));
  return taken === undefined ? null : { text: taken.key, chord: parseHerdrBinding(taken.key)!.chord, skipped };
}

const NOTHING_FIXED: ReadonlySet<string> = new Set();

/** The direct chords the config's `[[keys.command]]` entries hold (the resolver gives commands no action), when it reads the config. */
function commandChords(keys: unknown, configRead: boolean): ReadonlySet<string> {
  const commands = configRead ? table(keys)?.["command"] : undefined;
  if (!Array.isArray(commands)) return NOTHING_FIXED;
  return new Set(commands.flatMap((entry) => {
    const command = table(entry);
    if (command === null || typeof command["command"] !== "string" || command["command"].trim() === "") return [];
    const written = command["key"];
    return (typeof written === "string" ? [written] : Array.isArray(written) ? written : []).flatMap((text) => {
      const binding = typeof text === "string" ? parseHerdrBinding(text) : null;
      return binding === null || binding.prefixed || binding.range ? [] : [matchId(binding.chord)];
    });
  }));
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
  const notes = configNotes(keys, new Set([...resolved.actions.map(({ action }) => action), ...resolved.navigate.map(({ name }) => name)]));
  const commands = commandChords(keys, resolved.configRead);
  const checked = resolved.prefixes.map((prefix) => ({ ...prefix, reason: dropReason(prefix.chord, "prefix", NOTHING_FIXED) }));
  const typable = checked.flatMap(({ text, chord, reason }) => reason === null ? [{ text, chord }] : []);
  // no prefix can be typed: one stands in, or no key would reach any action, detach included
  const fallback = typable.length > 0 ? null : firstFree(FALLBACK_PREFIXES, (chord) => {
    const id = matchId(chord);
    return resolved.direct.find((bound) => matchId(bound.chord) === id)?.action ?? (commands.has(id) ? "command" : null);
  }, () => true)!;
  checked.forEach(({ text, reason }, i) => {
    if (reason === null) return;
    notes.push(i === 0 && fallback !== null ? { code: "prefix_fallback", action: "prefix", binding: text, reason, fallback: fallback.text, skipped: fallback.skipped } : { code: reason, action: "prefix", binding: text });
  });
  const prefixes = fallback === null ? typable : [{ text: fallback.text, chord: fallback.chord }];
  const prefixIds: Record<string, true> = Object.fromEntries(prefixes.map(({ chord }) => [matchId(chord), true]));
  /** `binding` when every chord of it can fire at `level`; else null, with the binding's one note. */
  const firing = (action: string, binding: HerdrKeptBinding, level: Level, fixed: ReadonlySet<string>): HerdrKeptBinding | null => {
    const code = binding.chords.map(({ chord }) => dropReason(chord, level, fixed)).find((reason) => reason !== null) ?? null;
    if (code !== null) notes.push({ code, action, binding: binding.text });
    return code === null ? binding : null;
  };
  const afterPrefix: Record<string, Bound> = {};
  const direct: Record<string, Bound> = {};
  const rows: KeyRow[] = [];
  /** What holds the key `chord` arrives as in `lookup` (in Terminal mode a prefix holds its own key), or null. */
  const holderIn = (lookup: Record<string, Bound>, chord: HerdrChord): string | null => {
    const id = matchId(chord);
    if (Object.hasOwn(lookup, id)) return lookup[id]!.action;
    return (lookup === direct || lookup === afterPrefix) && Object.hasOwn(prefixIds, id) ? "prefix" : null;
  };
  const claim = (lookup: Record<string, Bound>, action: KeyAction) => (chord: HerdrChord, index: number | null): boolean => {
    if (holderIn(lookup, chord) !== null) return false;
    lookup[matchId(chord)] = { action, index };
    return true;
  };
  /** `binding` with the chords it gets in `lookup`, or null; a chord already held is noted as the binding or, for a range that keeps others, its digit. */
  const take = (lookup: Record<string, Bound>, action: KeyAction, binding: HerdrKeptBinding): HerdrKeptBinding | null => {
    const lost: { key: string; holder: string }[] = [];
    const got = kept(binding, (chord, index) => {
      const holder = holderIn(lookup, chord);
      if (holder === null) return claim(lookup, action)(chord, index);
      lost.push({ key: chord.key, holder });
      return false;
    });
    if (got === null && lost.length > 0) notes.push({ code: "taken", action, binding: binding.text, holder: lost[0]!.holder });
    else for (const { key, holder } of lost) notes.push({ code: "taken", action, binding: binding.text.replace("1..9", key), holder });
    return got;
  };
  // two bindings can arrive as one key (shift+2 and "@"): herdr's rule decides, the actions the config writes
  // first, then the defaults, each pass in herdr's order, and the first binding keeps the key
  const user = resolved.configRead ? table(keys) ?? {} : {};
  const written = (action: string) => Object.hasOwn(user, action) || (action === "zoom" && Object.hasOwn(user, "fullscreen"));
  const held = new Map<KeyAction, HerdrKeptBinding[]>();
  for (const pass of [true, false]) {
    for (const { action, bindings } of resolved.actions) {
      if (written(action) !== pass) continue;
      const live = bindings.flatMap((binding) => firing(action, binding, binding.prefixed ? "after_prefix" : "direct", NOTHING_FIXED) ?? []);
      held.set(action, live.flatMap((binding) => take(binding.prefixed ? afterPrefix : direct, action, binding) ?? []));
    }
  }
  if (![...Object.values(direct), ...Object.values(afterPrefix)].some((bound) => bound.action === "detach")) {
    // no key would leave the screen: detach takes the first free fallback, else takes back the first one a prefix does not hold
    const choice = firstFree(FALLBACK_DETACH, (chord) => holderIn(afterPrefix, chord), (holder) => holder !== "prefix");
    if (choice !== null) {
      const id = matchId(choice.chord);
      if (Object.hasOwn(afterPrefix, id)) {
        const holder = afterPrefix[id]!.action;
        const lost = held.get(holder)!.find((binding) => binding.chords.some(({ chord }) => matchId(chord) === id))!;
        held.set(holder, held.get(holder)!.filter((binding) => binding !== lost));
        notes.push({ code: "taken", action: holder, binding: lost.text, holder: "detach" });
      }
      afterPrefix[id] = { action: "detach", index: null };
      held.get("detach")!.push({ text: choice.text, prefixed: true, range: false, chords: [{ chord: choice.chord, index: null }] });
      notes.push({ code: "detach_fallback", fallback: choice.text, skipped: choice.skipped });
    }
  }
  for (const { action, default: defaults } of resolved.actions) rows.push({ action, default: defaults, mode: "terminal", source: "herdr", bindings: held.get(action)! });
  const lockBinding = fixedBinding(LOCK_KEY);
  const lockId = chordId(lockBinding.chords[0]!.chord);
  const lockHolder = Object.hasOwn(direct, lockId) ? direct[lockId]!.action : Object.hasOwn(prefixIds, lockId) ? "prefix" : commands.has(lockId) ? "command" : null;
  if (lockHolder === null) claim(direct, "lock")(lockBinding.chords[0]!.chord, null);
  else notes.push({ code: "lock_taken", holder: lockHolder });
  rows.push({ action: "lock", default: LOCK_KEY, mode: "terminal", source: "fixed", bindings: lockHolder === null ? [lockBinding] : [] });

  const modeKeys = { navigate: {}, resize: {}, copy: {} } as Record<Exclude<Mode, "terminal">, Record<string, Bound>>;
  const fixedRows = new Map<string, HerdrKeptBinding[]>();
  for (const { action, mode, keys: texts } of FIXED) {
    const bindings = texts.flatMap((text) => kept(fixedBinding(text), claim(modeKeys[mode], action)) ?? []);
    fixedRows.set(`${mode}:${action}`, bindings);
  }
  // navigate mode is left with the prefix as well (herdr: "Esc, the prefix or Ctrl+[ cancels")
  for (const { text, chord } of prefixes) {
    if (claim(modeKeys.navigate, "navigate_cancel")(chord, null)) fixedRows.get("navigate:navigate_cancel")!.push({ text, prefixed: false, range: false, chords: [{ chord, index: null }] });
  }
  // resize mode is left with the key that entered it (the one after the prefix)
  for (const binding of rows.find((row) => row.action === "resize_mode")!.bindings.filter((b) => b.prefixed)) {
    const leave = kept({ ...binding, text: binding.text.replace(/^prefix\+/, "") }, claim(modeKeys.resize, "resize_leave"));
    if (leave !== null) fixedRows.get("resize:resize_leave")!.push(leave);
  }
  const navigateFixed: ReadonlySet<string> = new Set(Object.keys(modeKeys.navigate));
  for (const name of new Set(resolved.navigate.map((entry) => entry.name))) {
    const entries = resolved.navigate.filter((entry) => entry.name === name);
    const bindings = [...fixedRows.get(`navigate:${name}`) ?? []];
    for (const { text, chord } of entries) {
      // the key the screen fixes for this very name (navigate_pane_right = "right") already runs it: nothing dropped
      if (chord === null || modeKeys.navigate[matchId(chord)]?.action === name) continue;
      const binding = firing(name, { text, prefixed: false, range: false, chords: [{ chord, index: null }] }, "navigate", navigateFixed);
      const got = binding === null ? null : take(modeKeys.navigate, name, binding);
      if (got !== null) bindings.push(got);
    }
    rows.push({ action: name, default: entries[0]!.default, mode: "navigate", source: "herdr", bindings });
  }
  for (const { action, mode, keys: texts } of FIXED) {
    if (rows.some((row) => row.action === action && row.mode === mode)) continue;
    rows.push({ action, default: texts.join(", "), mode, source: "fixed", bindings: fixedRows.get(`${mode}:${action}`)! });
  }
  return { configRead: resolved.configRead, prefixes, rows, refusals: resolved.refusals, notes, prefixIds, afterPrefix, direct, modeKeys };
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

/** The named keys the decoder can deliver, asked of the decoder: control bytes, the CSI ~, u and letter forms, SS3. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...[...Array.from({ length: 0x20 }, (_, i) => i), 0x7f].filter((byte) => byte !== 0x1b).map((byte) => decodeControl(byte, false)),
  ...Array.from({ length: 40 }, (_, i) => decodeCsi(String(i + 1), "~", false)),
  ...[9, 13, 27, 127, ...Array.from({ length: 120 }, (_, i) => 57344 + i)].map((code) => decodeCsi(String(code), "u", false)),
  ...[..."ABCDEFGHPQRSZ"].map((final) => decodeCsi("", final, false)),
  ...Array.from({ length: 0x3f }, (_, i) => decodeSs3(String.fromCharCode(0x40 + i))),
].flatMap((event) => event?.type === "key" ? keyChords({ ...event, at: 0 }).map((chord) => chord.key) : []).filter((key) => key.length > 1));

export function isPrefix(keymap: Keymap, chords: readonly HerdrChord[]): boolean {
  return chords.some((chord) => Object.hasOwn(keymap.prefixIds, chordId(chord)));
}
