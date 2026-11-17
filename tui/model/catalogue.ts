/**
 * Every one of herdr's 52 actions (shared/herdr-keys.ts), built or left as a parity difference with
 * its reason. `built`: the reducer gives its effect as data (`effect`); `row` is the plan row that
 * performs that effect. A bound action that is not built shows one notice naming it.
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";

/** overlay: opens an overlay; mode: enters a mode; focus: moves the screen's own focus; view: a view flag; run: a run effect; quit and reload: their own effects */
export type BuiltEffect = "overlay" | "mode" | "focus" | "view" | "run" | "quit" | "reload";

export type CatalogueEntry =
  | { readonly id: HerdrAction; readonly status: "built"; readonly effect: BuiltEffect; readonly row: number }
  | { readonly id: HerdrAction; readonly status: "parity"; readonly reason: string };

const built = (id: HerdrAction, effect: BuiltEffect, row: number): CatalogueEntry => ({ id, status: "built", effect, row });
const parity = (id: HerdrAction, reason: string): CatalogueEntry => ({ id, status: "parity", reason });

const WORKTREES = "worktree dialogs run git and stay with the server's adapter; the screen shows worktree workspaces as the shared snapshot groups them";

export const CATALOGUE: readonly CatalogueEntry[] = [
  built("help", "overlay", 26),
  parity("settings", "a settings overlay that writes configuration back is left out on purpose"),
  built("new_workspace", "run", 28),
  parity("new_worktree", WORKTREES),
  parity("open_worktree", WORKTREES),
  parity("remove_worktree", WORKTREES),
  built("rename_workspace", "overlay", 28),
  built("close_workspace", "overlay", 28),
  built("workspace_picker", "mode", 35),
  built("goto", "overlay", 35),
  built("detach", "quit", 25),
  built("reload_config", "reload", 25),
  built("open_notification_target", "run", 34),
  built("previous_workspace", "focus", 25),
  built("next_workspace", "focus", 25),
  built("previous_agent", "run", 34),
  built("next_agent", "run", 34),
  built("focus_agent", "run", 34),
  built("new_tab", "overlay", 28),
  built("rename_tab", "overlay", 28),
  built("previous_tab", "focus", 25),
  built("next_tab", "focus", 25),
  built("move_tab_previous", "run", 28),
  built("move_tab_next", "run", 28),
  built("switch_tab", "focus", 25),
  built("switch_workspace", "focus", 25),
  built("close_tab", "run", 28),
  built("rename_pane", "overlay", 28),
  parity("edit_scrollback", "it opens the scrollback in an editor program, and the screen starts no process"),
  parity("clear_pane", "herdr clears a pane through its own server; herdr-core has no call for it, and typing a clear into the program is not the same"),
  built("copy_mode", "mode", 36),
  built("focus_pane_left", "run", 25),
  built("focus_pane_down", "run", 25),
  built("focus_pane_up", "run", 25),
  built("focus_pane_right", "run", 25),
  built("swap_pane_left", "run", 28),
  built("swap_pane_down", "run", 28),
  built("swap_pane_up", "run", 28),
  built("swap_pane_right", "run", 28),
  built("last_pane", "focus", 25),
  built("cycle_pane_next", "focus", 25),
  built("cycle_pane_previous", "focus", 25),
  built("split_vertical", "run", 28),
  built("split_horizontal", "run", 28),
  built("close_pane", "run", 28),
  built("zoom", "run", 28),
  built("resize_mode", "mode", 28),
  built("resize_pane_left", "run", 28),
  built("resize_pane_down", "run", 28),
  built("resize_pane_up", "run", 28),
  built("resize_pane_right", "run", 28),
  built("toggle_sidebar", "view", 26),
];

export const CATALOGUE_BY_ID: Readonly<Record<HerdrAction, CatalogueEntry>> = Object.fromEntries(CATALOGUE.map((entry) => [entry.id, entry])) as Record<HerdrAction, CatalogueEntry>;
