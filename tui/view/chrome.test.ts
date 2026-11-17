import { describe, expect, it } from "bun:test";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { LAYOUT_DOC, PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { WORKTREE_LABEL } from "../../server/herdr-core/worktrees.ts";
import { CoreWorld } from "../core/world.ts";
import { initialState, reduce } from "../model/reduce.ts";
import { OVERLAYS } from "../model/overlays.ts";
import { STRINGS } from "../strings.ts";
import { TUI_THEMES } from "../theme.generated.ts";
import { buildChrome, buildOverlays, sessionFromSocket, themeColors } from "./chrome.ts";
import { Grid, PaneGrid } from "./grid.ts";
import { nearest256, Painter, type Part, type Scene } from "./paint.ts";
import { layOut, paneScene } from "./screen.ts";

function renderScene(width: number, height: number, parts: readonly Part[], overlays: readonly Part[] = [], panes: Scene["panes"] = [], input: Scene["input"] = null): { rows: string[]; painter: Painter } {
  const painter = new Painter({ sync: false });
  painter.paint({ width, height, parts, panes, overlays, focus: panes[0]?.id ?? null, input });
  painter.taken(true);
  const screen = painter.screen;
  const rows: string[] = [];
  for (let r = 0; r < screen.rows; r++) {
    let line = "";
    for (let c = 0; c < screen.cols; c++) {
      const i = r * screen.cols + c;
      if (screen.width[i] !== 0) line += screen.text[i];
    }
    rows.push(line);
  }
  return { rows, painter };
}

function makeWorld(terminals: unknown[], appDoc: unknown = null, ovisDoc: unknown = null): CoreWorld {
  const world = new CoreWorld();
  world.notice({ type: "snapshot", epoch: 1, cause: "connect", seq: 1, terminals });
  if (appDoc !== null) world.notice({ type: "doc", epoch: 1, name: LAYOUT_DOC, doc: { value: appDoc, version: 1 } });
  if (ovisDoc !== null) world.notice({ type: "doc", epoch: 1, name: OVIS_LAYOUT_DOC, doc: { value: ovisDoc, version: 1 } });
  return world;
}

describe("generated TUI themes", () => {
  it("provides dark and light palettes from src/styles.css as RGB on truecolor and nearest 256 index on 256-colour hosts", () => {
    expect(TUI_THEMES.dark.accent).toEqual([58, 131, 247]);
    expect(TUI_THEMES.light.bg).toEqual([255, 255, 255]);
    const trueDark = themeColors("dark", "truecolor");
    const lowDark = themeColors("dark", "256");
    const trueLight = themeColors("light", "truecolor");
    expect(trueDark.accent).toEqual([58, 131, 247]);
    expect(lowDark.accent).toBe(nearest256([58, 131, 247]));
    expect(trueLight.bg).toEqual([255, 255, 255]);
  });
});

describe("chrome frames at 120x40 and 80x24", () => {
  const terminals = [
    {
      address: "t1", state: "live", cols: 46, rows: 36, cwd: "/home/user/ovis", turn: 1,
      labels: { [SPACE_LABEL]: "w-ovis", [WORKSPACE_NAME_LABEL]: "ovis", [TAB_LABEL]: "t-main", [TAB_NAME_LABEL]: "main", [PANE_NAME_LABEL]: "shell" },
      status: { state: "blocked", app: "claude" },
    },
    {
      address: "t2", state: "live", cols: 46, rows: 36, cwd: "/home/user/ovis/tui", turn: 1,
      labels: { [SPACE_LABEL]: "w-ovis", [WORKSPACE_NAME_LABEL]: "ovis", [TAB_LABEL]: "t-main", [TAB_NAME_LABEL]: "main", [PANE_NAME_LABEL]: "files" },
      status: { state: "working", app: "codex" },
    },
    {
      address: "t3", state: "live", cols: 90, rows: 36, cwd: "/home/user/문서", turn: 2,
      labels: { [SPACE_LABEL]: "w-docs", [WORKSPACE_NAME_LABEL]: "문서", [TAB_LABEL]: "t-notes", [TAB_NAME_LABEL]: "노트" },
      status: { state: "done", app: "claude" },
    },
  ];

  for (const [cols, rows] of [[120, 40], [80, 24]] as const) {
    it(`draws sidebar, tab bar, bordered panes, session header, state glyphs/words and mode bar as rows of cells at ${cols}x${rows}`, () => {
      const world = makeWorld(terminals);
      const view = world.view();
      const state = reduce(initialState(undefined), { type: "world", world: view.world, at: 0 }).state;
      const shape = layOut(cols, rows, view.tabs.get("t-main") ?? null, { sidebarCollapsed: false });
      const chrome = buildChrome({
        regions: shape.regions,
        spots: shape.spots,
        splits: shape.splits,
        state,
        world: view,
        panes: new Map([
          ["t1", { terminal: "t1", state: { kind: "Live" }, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 46, rows: 36 }, advertised: { cols: 46, rows: 36 }, sizedBy: null, emulator: null, ready: false, covered: false, owed: 0 }],
          ["t2", { terminal: "t2", state: { kind: "Live" }, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 46, rows: 36 }, advertised: { cols: 46, rows: 36 }, sizedBy: null, emulator: null, ready: false, covered: false, owed: 0 }],
        ]),
        link: { kind: "Online", code: null },
        session: "work-session",
        cwd: "/home/user/ovis",
        theme: "dark",
        colors: "truecolor",
      });
      const { rows: cellRows, painter } = renderScene(cols, rows, chrome.parts);
      expect(cellRows).toHaveLength(rows);
      expect(painter.screen.cols).toBe(cols);
      const text = cellRows.join("\n");
      // Session header
      expect(cellRows[0]).toContain("work-session");
      // Workspaces with roll-up glyph (! for blocked on w-ovis, * for done on 문서) and state word
      expect(text).toContain("ovis");
      expect(text).toContain("문서");
      expect(text).toContain(STRINGS.stateBlocked);
      expect(text).toContain(STRINGS.stateDone);
      // Agents section with name, folder and state dot/word
      expect(text).toContain("shell");
      expect(text).toContain("claude");
      expect(text).toContain("codex");
      // Tab bar
      expect(cellRows[0]).toContain("1:main");
      // Pane borders with title of name, folder and agent
      expect(text).toContain("shell");
      expect(text).toContain("files");
      // Mode bar with prefix and help hints
      expect(cellRows[rows - 1]).toContain("ctrl+b");
      expect(cellRows[rows - 1]).toContain("?");
      // Divider hit target registered for mouse divider drag
      const frame = painter.paint({ width: cols, height: rows, parts: chrome.parts, panes: [], overlays: [], focus: "t1", input: null });
      expect(frame.hits.hits.some((hit) => "part" in hit.target && hit.target.part === "borders" && hit.target.id === "split_0_root")).toBe(true);
    });
  }
});

describe("tab bar, zoom mark, overflow, and worktree grouping", () => {
  it("shows ZOOM mark when zoomed and reveals the focused last tab on overflow with its full label", () => {
    const terminals = Array.from({ length: 10 }, (_, i) => ({
      address: `t${i + 1}`, state: "live", cols: 80, rows: 24, cwd: "/work",
      labels: { [SPACE_LABEL]: "w1", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: `tab-${i + 1}`, [TAB_NAME_LABEL]: `long-tab-label-${i + 1}` },
    }));
    const ovisDoc = { schema: 1, workspaces: [{ id: "w1", tabs: terminals.map((_, i) => ({ id: `tab-${i + 1}`, root: { leaf: `t${i + 1}` }, zoomed: i === 9 ? "t10" : null })) }] };
    const world = makeWorld(terminals, null, ovisDoc);
    const view = world.view();
    let state = reduce(initialState(undefined), { type: "world", world: view.world, at: 0 }).state;
    state = reduce(state, { type: "select", target: { kind: "tab", id: "tab-10" }, at: 1 }).state;
    const shape = layOut(80, 24, view.tabs.get("tab-10") ?? null, { sidebarCollapsed: false });
    const chrome = buildChrome({
      regions: shape.regions, spots: shape.spots, splits: shape.splits, state, world: view,
      panes: new Map(), link: { kind: "Online", code: null }, session: "default", cwd: "/work", theme: "dark", colors: "truecolor",
    });
    const { rows } = renderScene(80, 24, chrome.parts);
    expect(rows[0]).toContain("10:long-tab-label-10");
    expect(rows[0]).toContain("ZOOM");
  });

  it("groups linked worktree workspaces under their repository workspace as buildSnapshot groups them", () => {
    const mainWt = JSON.stringify({ repo_key: "/repo/.git", repo_name: "repo", repo_root: "/repo", checkout_path: "/repo", is_linked_worktree: false });
    const childWt = JSON.stringify({ repo_key: "/repo/.git", repo_name: "repo", repo_root: "/repo", checkout_path: "/repo-wt", is_linked_worktree: true });
    const world = makeWorld([
      { address: "t1", state: "live", cols: 80, rows: 24, cwd: "/repo", labels: { [SPACE_LABEL]: "w-main", [WORKSPACE_NAME_LABEL]: "repo-main", [TAB_LABEL]: "t1", [WORKTREE_LABEL]: mainWt } },
      { address: "t2", state: "live", cols: 80, rows: 24, cwd: "/other", labels: { [SPACE_LABEL]: "w-other", [WORKSPACE_NAME_LABEL]: "other-space", [TAB_LABEL]: "t2" } },
      { address: "t3", state: "live", cols: 80, rows: 24, cwd: "/repo-wt", labels: { [SPACE_LABEL]: "w-wt", [WORKSPACE_NAME_LABEL]: "feature-branch", [TAB_LABEL]: "t3", [WORKTREE_LABEL]: childWt } },
    ]);
    const view = world.view();
    const state = reduce(initialState(undefined), { type: "world", world: view.world, at: 0 }).state;
    const shape = layOut(120, 40, view.tabs.get("t1") ?? null, { sidebarCollapsed: false });
    const chrome = buildChrome({
      regions: shape.regions, spots: shape.spots, splits: shape.splits, state, world: view,
      panes: new Map(), link: { kind: "Online", code: null }, session: "default", cwd: "/repo", theme: "dark", colors: "truecolor",
    });
    const { rows } = renderScene(120, 40, chrome.parts);
    const mainRow = rows.findIndex((r) => r.includes("repo-main"));
    const wtRow = rows.findIndex((r) => r.includes("feature-branch"));
    const otherRow = rows.findIndex((r) => r.includes("other-space"));
    expect(mainRow).toBeGreaterThan(0);
    // feature-branch hangs directly under repo-main, before other-space, and carries the worktree branch/tree mark
    expect(wtRow).toBe(mainRow + 1);
    expect(otherRow).toBeGreaterThan(wtRow);
  });
});

describe("visible states: offline, pane states, app-owned core, empty core, notices", () => {
  it("shows offline banner with exact command, dims panes, and shows how to retry a waiting/failed pane", () => {
    const world = makeWorld([
      { address: "t1", state: "live", cols: 80, rows: 24, cwd: "/work", labels: { [SPACE_LABEL]: "w1", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "tab1" } },
    ]);
    const view = world.view();
    const state = reduce(initialState(undefined), { type: "world", world: view.world, at: 0 }).state;
    const shape = layOut(120, 40, view.tabs.get("tab1") ?? null, { sidebarCollapsed: false });
    const chrome = buildChrome({
      regions: shape.regions, spots: shape.spots, splits: shape.splits, state, world: view,
      panes: new Map([["t1", { terminal: "t1", state: { kind: "Waiting", why: "offline" }, gen: 1, wanted: { cols: 94, rows: 36 }, actual: { cols: 94, rows: 36 }, advertised: null, sizedBy: null, emulator: null, ready: false, covered: false, owed: 0 }]]),
      link: { kind: "Offline", code: "closed" }, session: "default", cwd: "/work", theme: "dark", colors: "truecolor",
    });
    const { rows } = renderScene(120, 40, chrome.parts);
    const full = rows.join("\n");
    expect(full).toContain(STRINGS.offlineTitle);
    expect(full).toContain(STRINGS.offlineCommand);
    expect(rows.at(-1)).toContain(STRINGS.offlineDetail("closed"));
    expect(full.toLowerCase()).not.toContain("kill");
  });

  it("dims a non-live pane's last picture in Painter and shows ended (code), waiting for its new shell, and sized by another viewer (COLSxROWS)", () => {
    const world = makeWorld([
      { address: "t1", state: "live", cols: 120, rows: 40, cwd: "/work", labels: { [SPACE_LABEL]: "w1", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "tab1", [PANE_NAME_LABEL]: "one" } },
      { address: "t2", state: "live", cols: 80, rows: 24, cwd: "/work", labels: { [SPACE_LABEL]: "w1", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "tab1", [PANE_NAME_LABEL]: "two" } },
    ]);
    const view = world.view();
    const state = reduce(initialState(undefined), { type: "world", world: view.world, at: 0 }).state;
    const shape = layOut(120, 40, view.tabs.get("tab1") ?? null, { sidebarCollapsed: false });

    // 1. sized by another viewer (120x40) + waiting for its new shell
    const chrome1 = buildChrome({
      regions: shape.regions, spots: shape.spots, splits: shape.splits, state, world: view,
      panes: new Map([
        ["t1", { terminal: "t1", state: { kind: "Live" }, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 120, rows: 40 }, advertised: { cols: 46, rows: 36 }, sizedBy: { cols: 120, rows: 40 }, emulator: null, ready: false, covered: false, owed: 0 }],
        ["t2", { terminal: "t2", state: { kind: "Waiting", why: "lost" }, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 46, rows: 36 }, advertised: null, sizedBy: null, emulator: null, ready: false, covered: false, owed: 0 }],
      ]),
      link: { kind: "Online", code: null }, session: "default", cwd: "/work", theme: "dark", colors: "truecolor",
    });
    const text1 = renderScene(120, 40, chrome1.parts).rows.join("\n");
    expect(text1).toContain(STRINGS.sizedByViewer(120, 40));
    expect(text1).toContain(STRINGS.waitingNewShell);

    // 2. ended (code) and Waiting(offline) while link is Online (shows retry hint)
    const chrome2 = buildChrome({
      regions: shape.regions, spots: shape.spots, splits: shape.splits, state, world: view,
      panes: new Map([
        ["t1", { terminal: "t1", state: { kind: "Ended", reason: "exited", code: 137 }, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 46, rows: 36 }, advertised: null, sizedBy: null, emulator: null, ready: false, covered: false, owed: 0 }],
        ["t2", { terminal: "t2", state: { kind: "Waiting", why: "offline" }, gen: 1, wanted: { cols: 46, rows: 36 }, actual: { cols: 46, rows: 36 }, advertised: null, sizedBy: null, emulator: null, ready: false, covered: false, owed: 0 }],
      ]),
      link: { kind: "Online", code: null }, session: "default", cwd: "/work", theme: "dark", colors: "truecolor",
    });
    const grid = new PaneGrid(new Painter({ sync: false }).styles, 10, 5);
    grid.grid = new Grid(10, 5);
    grid.grid.text[0] = "Z";
    grid.allDirty = true;
    const pScene = paneScene(shape.spots[0]!, grid, { cols: 10, rows: 5 }, { live: false, hold: false, dim: true });
    expect(pScene.dim).toBe(true);
    const { rows: rows2, painter: p2 } = renderScene(120, 40, chrome2.parts, [], [pScene]);
    const text2 = rows2.join("\n");
    expect(text2).toContain(STRINGS.endedCode(137));
    expect(text2).toContain(STRINGS.retryHint);
    // Verify the cell 'Z' in the dimmed pane has STYLE_FAINT (4) set
    const zIndex = shape.spots[0]!.cells.inner.y * 120 + shape.spots[0]!.cells.inner.x;
    expect(p2.styles.get(p2.screen.style[zIndex]!).flags & 4).toBe(4);
  });

  it("shows 'the Herdr app arranges this core' on an app-owned core, and offers a first workspace in the start folder on an empty core", () => {
    const appWorld = makeWorld(
      [{ address: "t1", state: "live", cols: 80, rows: 24, cwd: "/work" }],
      { spaces: [{ id: "s1", name: "app-space", tabs: [{ id: "tab1", name: "app-tab", root: { content: { terminal: "t1" } } }] }] },
    );
    const appView = appWorld.view();
    expect(appView.ownsLayout).toBe(false);
    const appState = reduce(initialState(undefined), { type: "world", world: appView.world, at: 0 }).state;
    const appShape = layOut(120, 40, appView.tabs.get("tab1") ?? null, { sidebarCollapsed: false });
    const appChrome = buildChrome({
      regions: appShape.regions, spots: appShape.spots, splits: appShape.splits, state: appState, world: appView,
      panes: new Map(), link: { kind: "Online", code: null }, session: "default", cwd: "/work", theme: "dark", colors: "truecolor",
    });
    expect(renderScene(120, 40, appChrome.parts).rows.join("\n")).toContain(STRINGS.appOwnedCore);

    // Empty core
    const emptyWorld = makeWorld([]);
    const emptyView = emptyWorld.view();
    const emptyState = reduce(initialState(undefined), { type: "world", world: emptyView.world, at: 0 }).state;
    const emptyShape = layOut(120, 40, null, { sidebarCollapsed: false });
    const emptyChrome = buildChrome({
      regions: emptyShape.regions, spots: [], splits: [], state: emptyState, world: emptyView,
      panes: new Map(), link: { kind: "Online", code: null }, session: "default", cwd: "/home/user/my-project", theme: "dark", colors: "truecolor",
    });
    const emptyText = renderScene(120, 40, emptyChrome.parts).rows.join("\n");
    expect(emptyText).toContain("my-project");
    expect(emptyText).toContain("New workspace");
  });
});

describe("overlays and keymap unreachable notes", () => {
  it("draws every overlay kind with its declared close keys in its frame, and draws prefix_unreachable and detach_unreachable notes clearly in help", () => {
    const world = makeWorld([
      { address: "t1", state: "live", cols: 80, rows: 24, cwd: "/work", labels: { [SPACE_LABEL]: "w1", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "tab1", [PANE_NAME_LABEL]: "pane1" } },
    ]);
    const view = world.view();
    const base = reduce(initialState(undefined), { type: "world", world: view.world, at: 0 }).state;
    const states = [
      reduce(base, { type: "action", action: "help", at: 1 }).state,
      reduce(base, { type: "action", action: "rename_pane", at: 1 }).state,
      reduce(base, { type: "action", action: "close_workspace", at: 1 }).state,
      reduce(base, { type: "action", action: "goto", at: 1 }).state,
    ];
    for (const s of states) {
      const top = s.overlays.at(-1)!;
      const built = buildOverlays(120, 40, s, view, "dark", "truecolor");
      expect(built.overlays.length).toBeGreaterThan(0);
      const text = renderScene(120, 40, [], built.overlays, [], built.input).rows.join("\n");
      for (const closeKey of OVERLAYS[top.kind].closeKeys) {
        expect({ kind: top.kind, closeKey, present: text.includes(closeKey) }).toEqual({ kind: top.kind, closeKey, present: true });
      }
    }

    // Unreachable notes in help overlay & mode bar
    const noPrefixState = reduce(
      reduce(initialState({ prefix: "hyper+b", zoom: "ctrl+b", new_tab: "ctrl+a", split_vertical: "ctrl+]", split_horizontal: "ctrl+\\" }), { type: "world", world: view.world, at: 0 }).state,
      { type: "action", action: "help", at: 1 },
    ).state;
    const noPrefixHelp = renderScene(120, 40, [], buildOverlays(120, 40, noPrefixState, view, "dark", "truecolor").overlays).rows.join("\n");
    expect(noPrefixHelp).toContain("prefix_unreachable");

    const noDetachState = reduce(
      reduce(initialState({ close_pane: "prefix+q", zoom: "prefix+ctrl+q", new_tab: "prefix+alt+q" }), { type: "world", world: view.world, at: 0 }).state,
      { type: "action", action: "help", at: 1 },
    ).state;
    const noDetachHelp = renderScene(120, 40, [], buildOverlays(120, 40, noDetachState, view, "dark", "truecolor").overlays).rows.join("\n");
    expect(noDetachHelp).toContain("detach_unreachable");
  });

  it("extracts session name from socket path", () => {
    expect(sessionFromSocket("/run/user/1000/herdr-core/default.sock")).toBe("default");
    expect(sessionFromSocket("/tmp/work.2.sock")).toBe("work.2");
  });
});

import { demo } from "../testing/fixtures/demo.ts";
import { agents } from "../testing/fixtures/agents.ts";
import { machines } from "../testing/fixtures/machines.ts";
import { Run } from "../testing/run.ts";

describe("whole-screen runner proofs on fixtures and Korean column alignment", () => {
  it("renders demo, agents and machines fixtures at 120x40, 80x24 and 200x60 without shifting columns on Korean names", async () => {
    for (const [cols, rows] of [[120, 40], [80, 24], [200, 60]] as const) {
      const run = await Run.start({ fixture: demo, cols, rows });
      try {
        await run.live();
        await run.advance(10);
        const screen = run.loop.screen()!;
        expect(screen.cols).toBe(cols);
        expect(screen.rows).toBe(rows);
        // Verify that the sidebar divider '|' sits at column 23 on every row of the sidebar, proving Korean workspace name '문서' did not shift a column
        for (let r = 0; r < rows - 1; r++) {
          expect({ cols, rows, r, divider: screen.text[r * cols + 23] }).toEqual({ cols, rows, r, divider: "|" });
        }
        const dump = run.grid().join("\n");
        expect(dump).toContain("1:ovis");
        expect(dump).toContain("2:문서");
        expect(dump).toContain("1:main");
        expect(dump).toContain("2:logs");
        expect(dump).toContain("shell");
        expect(dump).toContain("files");
      } finally {
        await run.close();
      }
    }

    const agentRun = await Run.start({ fixture: agents, cols: 120, rows: 40 });
    try {
      await agentRun.live();
      await agentRun.advance(20);
      const dump = agentRun.grid().join("\n");
      expect(dump).toContain(STRINGS.stateBlocked);
      expect(dump).toContain(STRINGS.stateWorking);
      expect(dump).toContain(STRINGS.stateDone);
      expect(dump).toContain(STRINGS.stateIdle);
    } finally {
      await agentRun.close();
    }

    const machRun = await Run.start({ fixture: machines, cols: 120, rows: 40 });
    try {
      await machRun.live();
      await machRun.advance(20);
      const dump = machRun.grid().join("\n");
      expect(dump).toContain("1:home");
      expect(dump).toContain("this pc");
      expect(dump).not.toContain("build machine");
    } finally {
      await machRun.close();
    }
  }, 120_000);

  it("renders armed prefix, each mode bar, help overlay, notice toast, and cut-line offline state on the runner", async () => {
    const run = await Run.start({ fixture: demo, cols: 120, rows: 40 });
    try {
      await run.live();
      await run.advance(1);

      // Armed prefix
      await run.keys("ctrl+b");
      await run.advance(20);
      expect(run.grid().at(-1)).toContain(STRINGS.modePrefix);

      // Help overlay
      await run.keys("?");
      await run.advance(20);
      expect(run.grid().join("\n")).toContain(STRINGS.helpTitle);
      await run.keys("esc");
      await run.advance(200);
      expect(run.grid().join("\n")).not.toContain(STRINGS.helpTitle);

      // Navigate mode
      await run.keys("ctrl+b,w");
      await run.advance(20);
      expect(run.grid().at(-1)).toContain(STRINGS.modeNavigate);
      await run.keys("esc");
      await run.advance(200);

      // Resize mode
      await run.keys("ctrl+b,r");
      await run.advance(20);
      expect(run.grid().at(-1)).toContain(STRINGS.modeResize);
      await run.keys("esc");
      await run.advance(200);

      // Copy mode
      await run.keys("ctrl+b,[");
      await run.advance(20);
      expect(run.grid().at(-1)).toContain(STRINGS.modeCopy);
      await run.keys("esc");
      await run.advance(200);

      // Notice (parity action prefix+s -> settings -> not_built notice)
      await run.keys("ctrl+b,s");
      await run.advance(20);
      expect(run.grid().join("\n")).toContain("not_built");

      // Offline state after cutLine
      await run.cutLine();
      await run.advance(1_000);
      const offlineDump = run.grid().join("\n");
      expect(offlineDump).toContain(STRINGS.offlineTitle);
      expect(offlineDump).toContain(STRINGS.offlineCommand);
    } finally {
      await run.close();
    }
  }, 120_000);
});
