/**
 * What the core shows the screen: its workspaces, their tabs and each tab's panes, each tab's split tree and the pane
 * it zooms. Built from the core link's notices (the snapshot, the events that change a terminal's record, the two layout
 * documents) through the browser's own grouping, snapshot.ts `buildSnapshot`, so both clients group and order by one
 * rule. A pane is its terminal: its id is the terminal's address.
 */

import type { LayoutNode, PaneDirection } from "../../server/herdr-core/layout-doc.ts";
import { neighbour, OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { buildSnapshot, type HcTerminal, isRecord, LAYOUT_DOC } from "../../server/herdr-core/snapshot.ts";
import { agentGroup, type AgentGroup, groupAgentRows, type KnownStatus, rollupStatus, stateSeqs } from "../../shared/attention.ts";
import type { AgentStatus, PaneLayoutSnapshot, SessionSnapshot, WorkspaceWorktreeInfo } from "../../shared/herdr-api.generated.ts";
import type { World } from "../model/focus.ts";
import type { LinkNotice } from "./link.ts";

/** One tab as the screen lays it out: its tree over terminal addresses and the pane a zoom shows alone. */
export interface TabShape { readonly root: LayoutNode; readonly zoomed: string | null }

/** One pane's metadata as the chrome draws it (never reading agent_status off a tab or workspace). */
interface PaneSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly label: string;
  readonly title: string;
  readonly folder: string;
  readonly cwd: string;
  readonly agent: string | null;
  readonly status: AgentStatus;
  readonly parentId?: string;
}

/** One row of the sidebar's Agents section, ordered by shared/attention.ts. */
interface AgentRowView {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly name: string;
  readonly agent: string;
  readonly folder: string;
  readonly status: AgentStatus;
  readonly group: AgentGroup;
  readonly helper: boolean;
}

/** A top-level workspace in the sidebar and any linked worktree workspaces grouped under it. */
interface WorkspaceGroupView {
  readonly id: string;
  readonly name: string;
  readonly number: number;
  readonly status: KnownStatus;
  readonly worktree: WorkspaceWorktreeInfo | null;
  readonly children: readonly {
    readonly id: string;
    readonly name: string;
    readonly number: number;
    readonly status: KnownStatus;
    readonly worktree: WorkspaceWorktreeInfo | null;
  }[];
}

export interface CoreView {
  readonly world: World;
  readonly tabs: ReadonlyMap<string, TabShape>;
  readonly panes: ReadonlyMap<string, PaneSummary>;
  readonly workspaceStatuses: ReadonlyMap<string, KnownStatus>;
  readonly tabStatuses: ReadonlyMap<string, KnownStatus>;
  readonly workspaceGroups: readonly WorkspaceGroupView[];
  readonly agents: readonly AgentRowView[];
  /** true when Ovis arranges this core; false when the Herdr app's layout document (`herdr-app`) arranges it */
  readonly ownsLayout: boolean;
}

const EMPTY: CoreView = {
  world: { workspaces: [] },
  tabs: new Map(),
  panes: new Map(),
  workspaceStatuses: new Map(),
  tabStatuses: new Map(),
  workspaceGroups: [],
  agents: [],
  ownsLayout: true,
};

function folderName(path: string | null | undefined): string {
  if (!path) return "";
  if (/^(?:\\\\[?.]\\)?[A-Za-z]:[\\/]+$/.test(path)) return path;
  const parts = path.split(/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? /[\\/]/ : "/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function buildWorktreeGroups(
  snapshot: SessionSnapshot,
  workspaceStatuses: ReadonlyMap<string, KnownStatus>,
): WorkspaceGroupView[] {
  const ordered = snapshot.workspaces;
  const firstByRepo = new Map<string, (typeof ordered)[number]>();
  for (const workspace of ordered) {
    if (workspace.worktree && !workspace.worktree.is_linked_worktree && !firstByRepo.has(workspace.worktree.repo_key)) {
      firstByRepo.set(workspace.worktree.repo_key, workspace);
    }
  }
  const nearestByRepo = new Map<string, (typeof ordered)[number]>();
  const childrenOf = new Map<string, (typeof ordered)[number][]>();
  const top: (typeof ordered)[number][] = [];
  for (const workspace of ordered) {
    const worktree = workspace.worktree;
    if (worktree && !worktree.is_linked_worktree) nearestByRepo.set(worktree.repo_key, workspace);
    const parent = worktree?.is_linked_worktree ? nearestByRepo.get(worktree.repo_key) ?? firstByRepo.get(worktree.repo_key) : undefined;
    if (!parent) {
      top.push(workspace);
      continue;
    }
    const list = childrenOf.get(parent.workspace_id) ?? [];
    list.push(workspace);
    childrenOf.set(parent.workspace_id, list);
  }
  return top.map((workspace) => ({
    id: workspace.workspace_id,
    name: workspace.label,
    number: workspace.number,
    status: workspaceStatuses.get(workspace.workspace_id) ?? "unknown",
    worktree: workspace.worktree ?? null,
    children: (childrenOf.get(workspace.workspace_id) ?? []).map((child) => ({
      id: child.workspace_id,
      name: child.label,
      number: child.number,
      status: workspaceStatuses.get(child.workspace_id) ?? "unknown",
      worktree: child.worktree ?? null,
    })),
  }));
}

function buildAgents(snapshot: SessionSnapshot, panes: ReadonlyMap<string, PaneSummary>): AgentRowView[] {
  const seqs = stateSeqs(snapshot);
  const candidates = snapshot.panes.filter((pane) => Boolean(pane.agent?.trim()));
  if (candidates.length === 0) return [];
  interface Row {
    machine: { id: string };
    entry: { pane: { pane_id: string; parent_pane_id?: string; agent_status: AgentStatus } };
    summary: PaneSummary;
  }
  const rows: Row[] = candidates.map((pane) => {
    const summary = panes.get(pane.pane_id)!;
    return {
      machine: { id: "local" },
      entry: {
        pane: {
          pane_id: pane.pane_id,
          ...(summary.parentId === undefined ? {} : { parent_pane_id: summary.parentId }),
          agent_status: summary.status,
        },
      },
      summary,
    };
  });
  const byId = new Set(rows.map((r) => r.summary.id));
  const grouped = groupAgentRows<Row>(rows, {
    sort: "wait",
    status: (row) => row.summary.status,
    name: (row) => row.summary.label || row.summary.agent || row.summary.id,
    seqs: () => seqs,
  });
  return grouped.flatMap(({ group, rows: groupRows }) =>
    groupRows.map(({ summary }): AgentRowView => ({
      paneId: summary.id,
      workspaceId: summary.workspaceId,
      tabId: summary.tabId,
      name: summary.label || summary.title || summary.agent || summary.id,
      agent: summary.agent ?? "",
      folder: summary.folder,
      status: summary.status,
      group: group ?? agentGroup(summary.status),
      helper: summary.parentId !== undefined && byId.has(summary.parentId),
    })),
  );
}

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
  private readonly firstTurns = new Map<string, number>();
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
        for (const record of notice.terminals) {
          if (isRecord(record) && typeof record["address"] === "string") {
            this.records.set(record["address"], { ...record });
            if (!this.firstTurns.has(record["address"])) {
              this.firstTurns.set(record["address"], typeof record["turn"] === "number" ? record["turn"] : 0);
            }
          }
        }
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
    const appDoc = this.docs.get(LAYOUT_DOC) ?? null;
    const ovisDoc = this.docs.get(OVIS_LAYOUT_DOC) ?? null;
    const ownsLayout = appDoc === null || appDoc === undefined;
    const snapshot = buildSnapshot(
      [...this.records.values()] as unknown as HcTerminal[],
      appDoc,
      this.version,
      (terminal) => this.firstTurns.get(terminal.address) ?? terminal.turn ?? 0,
      ovisDoc,
    );
    const tabs = new Map<string, TabShape>();
    for (const layout of snapshot.layouts) {
      const root = treeOf(layout);
      if (root) tabs.set(layout.tab_id, { root, zoomed: layout.zoomed ? layout.focused_pane_id ?? null : null });
    }
    const panes = new Map<string, PaneSummary>();
    for (const pane of snapshot.panes) {
      const raw = pane as unknown as { parent_pane_id?: string };
      const cwd = pane.foreground_cwd ?? pane.cwd ?? "";
      panes.set(pane.pane_id, {
        id: pane.pane_id,
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        label: pane.label ?? "",
        title: pane.title ?? pane.terminal_title ?? "",
        folder: folderName(cwd),
        cwd,
        agent: pane.agent ?? null,
        status: pane.agent_status,
        ...(raw.parent_pane_id === undefined ? {} : { parentId: raw.parent_pane_id }),
      });
    }
    const order = new Map(snapshot.layouts.map((layout) => [layout.tab_id, layout.panes.map((pane) => pane.pane_id)]));
    const tabStatuses = new Map<string, KnownStatus>();
    for (const tab of snapshot.tabs) {
      const ids = order.get(tab.tab_id) ?? [];
      tabStatuses.set(tab.tab_id, rollupStatus(ids.map((id) => panes.get(id)?.status)));
    }
    const workspaceStatuses = new Map<string, KnownStatus>();
    for (const workspace of snapshot.workspaces) {
      const wsPanes = snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
      workspaceStatuses.set(workspace.workspace_id, rollupStatus(wsPanes.map((pane) => panes.get(pane.pane_id)?.status)));
    }
    const workspaceGroups = buildWorktreeGroups(snapshot, workspaceStatuses);
    const agents = buildAgents(snapshot, panes);
    this.shown = {
      tabs,
      panes,
      workspaceStatuses,
      tabStatuses,
      workspaceGroups,
      agents,
      ownsLayout,
      world: {
        workspaces: snapshot.workspaces.map((workspace) => ({
          id: workspace.workspace_id,
          name: workspace.label,
          tabs: snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).map((tab) => ({
            id: tab.tab_id,
            name: tab.label,
            panes: (order.get(tab.tab_id) ?? []).map((id) => ({ id, name: panes.get(id)?.label ?? "" })),
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
        if (!this.firstTurns.has(terminal)) this.firstTurns.set(terminal, typeof data["turn"] === "number" ? data["turn"] : 0);
        return true;
      case "labels":
        if (!record || !isRecord(data?.["labels"])) return false;
        record["labels"] = { ...data["labels"] };
        return true;
      case "status":
        if (!record) return false;
        record["status"] = isRecord(data?.["status"]) ? { ...data["status"] } : null;
        return true;
      case "foreground":
        if (!record) return false;
        record["foreground"] = isRecord(data?.["foreground"]) ? { ...data["foreground"] } : null;
        if (typeof data?.["cwd"] === "string") record["cwd"] = data["cwd"];
        return true;
      case "turn":
        if (!record) return false;
        if (typeof data?.["turn"] === "number") record["turn"] = data["turn"];
        if (isRecord(data?.["status"])) record["status"] = { ...data["status"] };
        return true;
      case "title":
        if (!record) return false;
        record["title"] = typeof data?.["title"] === "string" ? data["title"] : null;
        return true;
      case "cwd":
        if (!record || typeof data?.["cwd"] !== "string") return false;
        record["cwd"] = data["cwd"];
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
