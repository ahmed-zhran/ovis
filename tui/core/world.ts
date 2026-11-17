/**
 * What the core shows the screen: its workspaces, their tabs and each tab's panes, each tab's split tree and the pane
 * it zooms. Built from the core link's notices (the snapshot, the events that change a terminal's record, the two layout
 * documents) through the browser's own grouping, snapshot.ts `buildSnapshot`, so both clients group and order by one
 * rule. A pane is its terminal: its id is the terminal's address.
 */

import type { LayoutNode, PaneDirection } from "../../server/herdr-core/layout-doc.ts";
import { neighbour, OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { buildSnapshot, type HcTerminal, isRecord, LAYOUT_DOC } from "../../server/herdr-core/snapshot.ts";
import type { PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import type { World } from "../model/focus.ts";
import type { LinkNotice } from "./link.ts";

/** One tab as the screen lays it out: its tree over terminal addresses and the pane a zoom shows alone. */
export interface TabShape { readonly root: LayoutNode; readonly zoomed: string | null }

export interface CoreView {
  readonly world: World;
  readonly tabs: ReadonlyMap<string, TabShape>;
}

const EMPTY: CoreView = { world: { workspaces: [] }, tabs: new Map() };

/**
 * A tab's tree from the snapshot's layout: its splits carry the path of each split in their ids (`split_<n>_root`,
 * `split_<n>_01`: 0 the first side, 1 the second) and its panes come in the order `place()` walks the tree, so the tree
 * is the splits by path with the panes as leaves in that order.
 */
export function treeOf(layout: Pick<PaneLayoutSnapshot, "splits" | "panes">): LayoutNode | null {
  const splits = new Map(layout.splits.map((split) => [split.id.slice(split.id.indexOf("_", "split_".length) + 1), split]));
  const leaves = layout.panes.map((pane) => pane.pane_id);
  let next = 0;
  const build = (path: string): LayoutNode | null => {
    const split = splits.get(path === "" ? "root" : path);
    if (!split) {
      const leaf = leaves[next++];
      return leaf === undefined ? null : { leaf };
    }
    const first = build(`${path}0`);
    const second = build(`${path}1`);
    if (!first || !second) return first ?? second;
    return { split: split.direction === "down" ? "down" : "right", ratio: split.ratio, first, second };
  };
  return leaves.length === 0 ? null : build("");
}

/** herdr's directional focus actions and the side each looks to; null for any other action. */
const FOCUS_DIRECTIONS: Readonly<Record<string, PaneDirection>> = { focus_pane_left: "left", focus_pane_right: "right", focus_pane_up: "up", focus_pane_down: "down" };

export function focusDirection(action: string): PaneDirection | null {
  return Object.hasOwn(FOCUS_DIRECTIONS, action) ? FOCUS_DIRECTIONS[action]! : null;
}

/** The pane on that side of `pane` in the tab's tree (layout-doc.ts `neighbour`): the one sharing most of its edge; null at the edge. */
export function paneToward(shape: TabShape, pane: string, direction: PaneDirection): string | null {
  return neighbour(shape.root, pane, direction);
}

/** The terminals and documents the link told of, and what they show. */
export class CoreWorld {
  private readonly records = new Map<string, Record<string, unknown>>();
  private readonly docs = new Map<string, unknown>();
  private shown: CoreView = EMPTY;
  private stale = false;
  private version = "";

  /** Takes one notice of the link; answers whether what the screen shows may have changed. */
  notice(notice: LinkNotice): boolean {
    switch (notice.type) {
      case "state":
        return false;
      case "snapshot":
        this.records.clear();
        for (const record of notice.terminals) if (isRecord(record) && typeof record["address"] === "string") this.records.set(record["address"], { ...record });
        break;
      case "doc":
        if (notice.name !== LAYOUT_DOC && notice.name !== OVIS_LAYOUT_DOC) return false;
        this.docs.set(notice.name, notice.doc.value ?? null);
        break;
      case "event":
        if (!this.event(notice.event.type, notice.event.terminal, notice.event.data)) return false;
        break;
    }
    this.stale = true;
    return true;
  }

  /** hc's version, for the snapshot's own field */
  setVersion(version: string): void {
    this.version = version;
  }

  view(): CoreView {
    if (!this.stale) return this.shown;
    this.stale = false;
    const snapshot = buildSnapshot([...this.records.values()] as unknown as HcTerminal[], this.docs.get(LAYOUT_DOC) ?? null, this.version, undefined, this.docs.get(OVIS_LAYOUT_DOC) ?? null);
    const tabs = new Map<string, TabShape>();
    for (const layout of snapshot.layouts) {
      const root = treeOf(layout);
      if (root) tabs.set(layout.tab_id, { root, zoomed: layout.zoomed ? layout.focused_pane_id ?? null : null });
    }
    const label = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane.label ?? ""]));
    const order = new Map(snapshot.layouts.map((layout) => [layout.tab_id, layout.panes.map((pane) => pane.pane_id)]));
    this.shown = {
      tabs,
      world: {
        workspaces: snapshot.workspaces.map((workspace) => ({
          id: workspace.workspace_id,
          name: workspace.label,
          tabs: snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).map((tab) => ({
            id: tab.tab_id,
            name: tab.label,
            panes: (order.get(tab.tab_id) ?? []).map((id) => ({ id, name: label.get(id) ?? "" })),
          })),
        })),
      },
    };
    return this.shown;
  }

  /** An event's change to a terminal's record; false when it changes nothing the screen shows. */
  private event(type: string, terminal: string | undefined, data: Record<string, unknown> | undefined): boolean {
    if (terminal === undefined) return false;
    const record = this.records.get(terminal);
    switch (type) {
      case "created":
      case "restarted":
        if (!isRecord(data) || data["address"] !== terminal) return false;
        this.records.set(terminal, { ...data });
        return true;
      case "labels":
        if (!record || !isRecord(data?.["labels"])) return false;
        record["labels"] = { ...data["labels"] };
        return true;
      case "finished":
        if (!record) return false;
        Object.assign(record, data ?? {}, { state: "finished" });
        return true;
      case "lost":
        if (!record) return false;
        Object.assign(record, data ?? {});
        return true;
      case "removed":
        return this.records.delete(terminal);
      default:
        return false;
    }
  }
}
