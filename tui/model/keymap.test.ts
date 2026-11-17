import { describe, expect, it } from "bun:test";
import { type Mods, typedKey } from "../input/decode.ts";
import { resolveAllHerdrKeys } from "../../shared/herdr-keys.ts";
import type { World } from "./focus.ts";
import { cleanConfigText, helpRows, modeBar, shownRefusals } from "./hints.ts";
import { buildKeymap } from "./keymap.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./reduce.ts";

const AT = 1_000;
const WORLD: World = { workspaces: [{ id: "w1", name: "one", tabs: [{ id: "t1", name: "a", panes: [{ id: "p1", name: "" }] }] }] };
const key = (char: string, mods: Mods = {}): ModelEvent => ({ ...typedKey(char, mods), at: AT });
const start = (keys?: unknown): ModelState => reduce(initialState(keys), { type: "world", world: WORLD, at: 0 }).state;
const sentToPane = (state: ModelState, event: ModelEvent) => reduce(state, event).effects.filter((effect) => effect.type === "pane").length;

describe("the keymap table", () => {
  it("has one row per herdr action, with the resolver's default and bindings, in Terminal mode", () => {
    for (const keys of [undefined, { prefix: "ctrl+a" }, { new_tab: "alt+t" }, { zoom: "" }]) {
      const resolved = resolveAllHerdrKeys(keys);
      const rows = buildKeymap(keys).rows.filter((row) => row.source === "herdr" && row.mode === "terminal");
      expect(rows.map(({ action, default: d, bindings }) => ({ action, default: d, bindings })))
        .toEqual(resolved.actions.map(({ action, default: d, bindings }) => ({ action, default: d, bindings })));
    }
  });

  it("holds herdr's six navigate keys in Navigate mode, the arrows fixed first", () => {
    const rows = buildKeymap(undefined).rows.filter((row) => row.mode === "navigate" && row.source === "herdr");
    expect(rows.map((row) => [row.action, row.bindings.map((binding) => binding.text)])).toEqual([
      ["navigate_workspace_up", ["up"]], ["navigate_workspace_down", ["down"]], ["navigate_pane_left", ["left", "h"]],
      ["navigate_pane_down", ["j"]], ["navigate_pane_up", ["k"]], ["navigate_pane_right", ["right", "l"]],
    ]);
  });

  it("follows a changed prefix, a direct Alt binding and an unbound action", () => {
    const changed = buildKeymap({ prefix: "ctrl+a" });
    expect(changed.prefixes.map((prefix) => prefix.text)).toEqual(["ctrl+a"]);
    const alt = buildKeymap({ split_vertical: ["prefix+v", "alt+v"] });
    expect(Object.values(alt.direct)).toContainEqual({ action: "split_vertical", index: null });
    const unbound = buildKeymap({ zoom: "" });
    expect(unbound.rows.find((row) => row.action === "zoom")!.bindings).toEqual([]);
    expect(Object.values(unbound.afterPrefix).some((bound) => bound.action === "zoom")).toBe(false);
  });

  it("gives the lock its chord only while nothing of herdr's holds it", () => {
    expect(buildKeymap(undefined).rows.find((row) => row.action === "lock")!.bindings.map((binding) => binding.text)).toEqual(["ctrl+alt+g"]);
    const taken = buildKeymap({ new_tab: "ctrl+alt+g" });
    expect(taken.rows.find((row) => row.action === "lock")!.bindings).toEqual([]);
    expect(taken.notes).toContainEqual({ code: "lock_unbound" });
  });

  it("names what holds no key and no refusal", () => {
    expect(buildKeymap({ indexed: { tabs: "ctrl" }, zoom: " " }).notes).toEqual([{ code: "indexed_legacy", entry: "tabs" }, { code: "blank_binding", action: "zoom" }]);
  });

  it("keymap reload", () => {
    const armed = reduce(start(), key("b", { ctrl: true })).state;
    expect(armed.armed).toBe(true);
    const reloaded = reduce(armed, { type: "keys", keys: { prefix: "ctrl+a", new_tab: "prefix+t" }, at: AT });
    expect(reloaded.effects).toEqual([]);
    const state = reloaded.state;
    // an armed prefix returns to Idle and its deadline goes
    expect(state.armed).toBe(false);
    expect(state.deadlines.has("prefix")).toBe(false);
    // the old prefix is typed into the pane, the new one arms
    expect(sentToPane(state, key("b", { ctrl: true }))).toBe(1);
    const rearmed = reduce(state, key("a", { ctrl: true })).state;
    expect(rearmed.armed).toBe(true);
    // the mode bar and the help follow the new table
    expect(modeBar(rearmed).hints.find((hint) => hint.action === "new_tab")!.keys).toEqual(["t"]);
    expect(helpRows(state.keymap).find((row) => row.action === "new_tab")!.keys).toEqual(["prefix+t"]);
    // a config with refusals answers one notice with their count
    const refused = reduce(state, { type: "keys", keys: { new_tab: "prefix+nonsense+x", zoom: "q", bogus: "x" }, at: AT }).state;
    expect(refused.notices.map((notice) => [notice.code, notice.data])).toEqual([["keys_refused", { count: 3 }]]);
    // a config of the wrong type is not read at all: herdr's defaults stand
    const unread = reduce(state, { type: "keys", keys: { prefix: 5 }, at: AT }).state;
    expect(unread.keymap.prefixes.map((prefix) => prefix.text)).toEqual(["ctrl+b"]);
    expect(unread.notices.map((notice) => notice.code)).toEqual(["keys_unread"]);
  });

  it("unlocks on a reload that takes the unlock chord away", () => {
    const locked = reduce(start(), key("g", { ctrl: true, alt: true })).state;
    expect(locked.locked).toBe(true);
    const step = reduce(locked, { type: "keys", keys: { new_tab: "ctrl+alt+g" }, at: AT });
    expect(step.state.locked).toBe(false);
    // the lost chord is also one of the config's notes
    expect(step.state.notices.map((notice) => notice.code)).toEqual(["unlocked", "keys_refused"]);
  });

  it("cleans, clamps and caps the config text it shows", () => {
    expect(cleanConfigText("a\u0007b\u202ec\u200bd\n")).toBe("abcd");
    expect([...cleanConfigText("x".repeat(500))]).toHaveLength(80);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`bogus_${i}`, "x"]));
    const shown = shownRefusals(buildKeymap(many));
    expect(shown.shown).toHaveLength(20);
    expect(shown.more).toBe(10);
  });
});
