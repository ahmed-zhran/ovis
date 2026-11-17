import { describe, expect, it } from "bun:test";
import { type LayoutNode, OVIS_LAYOUT_DOC, type PaneDirection, place } from "../../server/herdr-core/layout-doc.ts";
import { LAYOUT_DOC, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import type { LinkNotice } from "./link.ts";
import { CoreWorld, paneToward, treeOf } from "./world.ts";

const leaf = (id: string): LayoutNode => ({ leaf: id });
const right = (ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: "right", ratio, first, second });
const down = (ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ split: "down", ratio, first, second });

const layoutOf = (root: LayoutNode) => {
  const placed = place(root);
  return { splits: placed.splits, panes: placed.panes.map(({ pane_id, rect }) => ({ pane_id, rect, focused: false })) };
};

describe("a tab's tree from the snapshot's layout", () => {
  it("is the tree place() cut, for single panes, nested splits and both directions", () => {
    const trees = [
      leaf("a"),
      right(0.5, leaf("a"), leaf("b")),
      right(0.3, leaf("a"), down(0.6, leaf("b"), leaf("c"))),
      down(0.5, right(0.5, leaf("a"), leaf("b")), right(0.2, leaf("c"), down(0.5, leaf("d"), leaf("e")))),
    ];
    for (const tree of trees) expect(treeOf(layoutOf(tree))).toEqual(tree);
  });

  it("is null for a layout with no pane", () => {
    expect(treeOf({ splits: [], panes: [] })).toBeNull();
  });
});

describe("the pane that lies that way (layout-doc.ts neighbour, on the tree the screen draws)", () => {
  const table: [name: string, root: LayoutNode, from: string, direction: PaneDirection, expected: string | null][] = [
    ["side by side", right(0.5, leaf("a"), leaf("b")), "a", "right", "b"],
    ["side by side, back", right(0.5, leaf("a"), leaf("b")), "b", "left", "a"],
    ["at the edge", right(0.5, leaf("a"), leaf("b")), "a", "left", null],
    ["nothing above", right(0.5, leaf("a"), leaf("b")), "a", "up", null],
    ["a tie: two share the edge equally, the first in the tree wins", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "a", "right", "b"],
    ["nested, down", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "b", "down", "c"],
    ["nested, up", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "c", "up", "b"],
    ["nested, out to the left", right(0.5, leaf("a"), down(0.5, leaf("b"), leaf("c"))), "c", "left", "a"],
    ["the larger share of the edge wins", right(0.5, leaf("a"), down(0.3, leaf("b"), leaf("c"))), "a", "right", "c"],
    ["a tie from below", down(0.5, right(0.5, leaf("a"), leaf("b")), leaf("c")), "c", "up", "a"],
    ["two levels deep", down(0.5, right(0.5, leaf("a"), leaf("b")), right(0.2, leaf("c"), down(0.5, leaf("d"), leaf("e")))), "b", "down", "d"],
    ["a pane not in the tab", right(0.5, leaf("a"), leaf("b")), "z", "right", null],
  ];
  for (const [name, root, from, direction, expected] of table) {
    it(name, () => {
      expect(paneToward({ root, zoomed: null }, from, direction)).toBe(expected);
    });
  }
});

const record = (address: string, space: string, tab: string, extra: Record<string, unknown> = {}) => ({
  address, state: "live", cols: 80, rows: 24, cwd: "/", turn: 0, created_ms: 1,
  labels: { [SPACE_LABEL]: space, [WORKSPACE_NAME_LABEL]: space.toUpperCase(), [TAB_LABEL]: tab, [TAB_NAME_LABEL]: `${tab} name` },
  ...extra,
});
const snapshot = (terminals: unknown[]): LinkNotice => ({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
const event = (type: string, terminal: string, data: Record<string, unknown> = {}): LinkNotice => ({ type: "event", epoch: 1, seq: 2, event: { type, terminal, data }, changes: [] });

describe("the core's world as the screen shows it", () => {
  it("groups the snapshot's terminals into workspaces, tabs and panes, each tab with its tree", () => {
    const world = new CoreWorld();
    expect(world.notice(snapshot([record("t1", "w1", "a"), record("t2", "w1", "a"), record("t3", "w2", "b")]))).toBe(true);
    const view = world.view();
    expect(view.world.workspaces.map((workspace) => [workspace.id, workspace.name, workspace.tabs.map((tab) => [tab.id, tab.name, tab.panes.map((pane) => pane.id)])])).toEqual([
      ["w1", "W1", [["a", "a name", ["t1", "t2"]]]],
      ["w2", "W2", [["b", "b name", ["t3"]]]],
    ]);
    expect(view.tabs.get("a")).toEqual({ root: { split: "right", ratio: 0.5, first: leaf("t1"), second: leaf("t2") }, zoomed: null });
  });

  it("follows created, labels, finished and removed, and ignores what it does not show", () => {
    const world = new CoreWorld();
    world.notice(snapshot([record("t1", "w1", "a")]));
    expect(world.notice(event("size", "t1", { cols: 10, rows: 5 }))).toBe(false);
    expect(world.notice(event("created", "t2", record("t2", "w1", "a")))).toBe(true);
    expect(world.view().world.workspaces[0]!.tabs[0]!.panes.map((pane) => pane.id)).toEqual(["t1", "t2"]);
    world.notice(event("labels", "t2", { labels: { ...record("t2", "w2", "c").labels } }));
    expect(world.view().world.workspaces.map((workspace) => workspace.id)).toEqual(["w1", "w2"]);
    world.notice(event("finished", "t1", { exit_code: 0, reason: "exited" }));
    expect(world.view().world.workspaces.map((workspace) => workspace.id)).toEqual(["w2"]);
    world.notice(event("removed", "t2"));
    expect(world.view().world.workspaces).toEqual([]);
  });

  it("takes the tree and the zoom from Ovis's own document", () => {
    const world = new CoreWorld();
    world.notice(snapshot([record("t1", "w1", "a"), record("t2", "w1", "a")]));
    const root = down(0.25, leaf("t2"), leaf("t1"));
    world.notice({ type: "doc", epoch: 1, name: OVIS_LAYOUT_DOC, doc: { value: { schema: 1, workspaces: [{ id: "w1", tabs: [{ id: "a", root, zoomed: "t1" }] }] }, version: 1 } });
    expect(world.view().tabs.get("a")).toEqual({ root, zoomed: "t1" });
    expect(world.view().world.workspaces[0]!.tabs[0]!.panes.map((pane) => pane.id)).toEqual(["t2", "t1"]);
  });

  it("follows the Herdr app's document on a core it arranges, and ignores other documents", () => {
    const world = new CoreWorld();
    world.notice(snapshot([record("t1", "w1", "a"), record("t2", "w1", "a")]));
    expect(world.notice({ type: "doc", epoch: 1, name: "other", doc: { value: {}, version: 1 } })).toBe(false);
    const app = { spaces: [{ id: "s1", name: "app space", tabs: [{ id: "x", name: "app tab", root: { type: "column", children: [{ content: { terminal: "t2" } }, { content: { terminal: "t1" } }] } }] }] };
    world.notice({ type: "doc", epoch: 1, name: LAYOUT_DOC, doc: { value: app, version: 1 } });
    const view = world.view();
    expect(view.world.workspaces.map((workspace) => [workspace.id, workspace.name])).toEqual([["s1", "app space"]]);
    expect(view.tabs.get("x")).toEqual({ root: { split: "down", ratio: 0.5, first: leaf("t2"), second: leaf("t1") }, zoomed: null });
  });
});
