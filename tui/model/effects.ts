/**
 * What the reducer asks the loop (row 25) to do, as data. The reducer performs none of it.
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";
import type { InputEvent } from "../input/decode.ts";
import type { Target } from "./focus.ts";

export type KeyInput = Extract<InputEvent, { type: "key" }>;
export type TextInput = Extract<InputEvent, { type: "text" }>;
export type PasteInput = Extract<InputEvent, { type: "paste" }>;
export type MouseInput = Extract<InputEvent, { type: "mouse" }>;
/** What reaches a pane: the key, the text run (or what is left of it) or the paste, as read. */
export type PaneInput = KeyInput | TextInput | PasteInput;

/** An action the reducer cannot finish itself: a layout write (row 28), the agent list (row 34), the picker (row 35), a directional focus (row 25). */
export interface RunEffect {
  readonly type: "run";
  readonly action: HerdrAction;
  readonly target: Target | null;
  readonly index: number | null;
  /** a name typed into a field (rename, new tab) or the goto query */
  readonly name: string | null;
}

export type Effect =
  /** level 6: send this input to the pane through its gate (encodeKey, or encodePaste) */
  | { readonly type: "pane"; readonly pane: string; readonly input: PaneInput }
  | RunEffect
  /** detach: close every channel, give the terminal back; no terminal is killed */
  | { readonly type: "quit" }
  /** read herdr's config again and answer with a `keys` event */
  | { readonly type: "reload_keys" }
  /** a mouse event for the hit map (row 27): inside the top overlay, or over the screen's chrome and panes */
  | { readonly type: "mouse"; readonly over: "overlay" | "screen"; readonly event: MouseInput }
  /** a reply to the start probe (the host's colours, flags, cell size) */
  | { readonly type: "host_reply"; readonly kind: Extract<InputEvent, { type: "reply" }>["kind"]; readonly data: string };
