/**
 * The terminal screen's chrome, following herdr's client screen (src/AGENTS.md):
 * the sidebar (session header with collapse toggle, Spaces with rollupStatus dots and linked
 * worktree grouping, Agents ordered by shared/attention.ts with name, folder and state glyph/word),
 * the tab bar (focused accent, bold when custom-named, zoom mark, overflow reveal keeping the last
 * tab's full label), pane borders with focus colour, title (name, folder, agent), state notices and
 * divider hit targets, the mode bar and hint line generated from the one keymap table, and the
 * overlays (help generated from the same keymap table with unreachable/fallback notes, text modal,
 * confirm dialog, goto picker, and notice toasts).
 */

import { knownStatus, type KnownStatus } from "../../shared/attention.ts";
import type { LinkState } from "../core/link.ts";
import type { PaneView } from "../core/pane.ts";
import type { CoreView } from "../core/world.ts";
import { STYLE_BOLD, STYLE_INVERSE, type WrittenColor } from "../emulator/index.ts";
import type { ColorDepth } from "../host/index.ts";
import { focused } from "../model/focus.ts";
import { helpRows, modeBar, shownRefusals } from "../model/hints.ts";
import type { KeymapNote } from "../model/keymap.ts";
import { type Field, type Overlay, OVERLAYS } from "../model/overlays.ts";
import type { ModelState, Notice } from "../model/reduce.ts";
import { STRINGS } from "../strings.ts";
import { TUI_THEMES, type TuiColorRole, type TuiThemeMode } from "../theme.generated.ts";
import type { Rect, Regions, SplitCells } from "./geometry.ts";
import { hostLayout, type LaidCell } from "./host-layout.ts";
import { nearest256, type Canvas, type Part, type Scene } from "./paint.ts";
import type { PaneSpot } from "./screen.ts";

type ThemeColors = Readonly<Record<TuiColorRole, WrittenColor>>;

/** Theme tokens resolved for the host's colour depth: RGB on truecolor, nearest xterm-256 index on 256-colour hosts. */
export function themeColors(mode: TuiThemeMode = "dark", depth: ColorDepth = "truecolor"): ThemeColors {
  const palette = TUI_THEMES[mode];
  const entries = (Object.keys(palette) as TuiColorRole[]).map((role) => {
    const rgb = palette[role];
    return [role, depth === "256" ? nearest256(rgb) : rgb] as const;
  });
  return Object.fromEntries(entries) as ThemeColors;
}

/** The hc session name inferred from a socket path when no explicit session name was handed in. */
export function sessionFromSocket(socket: string): string {
  const base = socket.split(/[\\/]/).at(-1) ?? "default";
  const stripped = base.replace(/\.sock$/, "");
  if (stripped === "hc" || stripped === "") return "default";
  return stripped.replace(/^herdr-core-[^-]*-/, "") || "default";
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Lays `text` out through the engine's HostLayout (never Bun.stringWidth). */
function measure(text: string): { cells: LaidCell[]; width: number } {
  if (text === "") return { cells: [], width: 0 };
  const laid = hostLayout.layout(text.replace(CONTROL, "\ufffd"));
  return { cells: laid.cells, width: laid.end };
}

/** Prints `text` at `(col, row)` clipped to at most `maxCols` display columns, using Canvas.put with each cell's real width. */
function printClipped(canvas: Canvas, col: number, row: number, text: string, maxCols: number, style: number, ellipsis = false): number {
  if (maxCols <= 0 || text === "") return col;
  const { cells, width } = measure(text);
  if (width <= maxCols) {
    for (const cell of cells) canvas.put(col + cell.col, row, cell.text, cell.width, style);
    return col + width;
  }
  const limit = ellipsis && maxCols >= 2 ? maxCols - 1 : maxCols;
  let end = 0;
  for (const cell of cells) {
    if (cell.col + cell.width > limit) break;
    canvas.put(col + cell.col, row, cell.text, cell.width, style);
    end = cell.col + cell.width;
  }
  if (ellipsis && maxCols >= 2 && end < maxCols) {
    canvas.put(col + end, row, "…", 1, style);
    end += 1;
  }
  return col + end;
}

/** Fills a horizontal span of cells on `row` from `col` for `width` columns. */
function fillSpan(canvas: Canvas, col: number, row: number, width: number, style: number, char = " "): void {
  for (let c = col; c < col + width; c++) canvas.put(c, row, char, 1, style);
}

/** Fills a sub-rectangle on `canvas`. */
function fillBox(canvas: Canvas, rect: Rect, style: number, char = " "): void {
  for (let r = rect.y; r < rect.y + rect.height; r++) fillSpan(canvas, rect.x, r, rect.width, style, char);
}

function stateVisual(status: KnownStatus | string | undefined, colors: ThemeColors): { glyph: string; word: string; color: WrittenColor } {
  const known = knownStatus(status);
  switch (known) {
    case "blocked":
      return { glyph: STRINGS.glyphBlocked, word: STRINGS.stateBlocked, color: colors.statusBlocked };
    case "done":
      return { glyph: STRINGS.glyphDone, word: STRINGS.stateDone, color: colors.statusDone };
    case "working":
    case "waiting":
      return { glyph: STRINGS.glyphWorking, word: STRINGS.stateWorking, color: colors.statusWorking };
    case "idle":
      return { glyph: STRINGS.glyphIdle, word: STRINGS.stateIdle, color: colors.statusIdle };
    case "unknown":
      return { glyph: STRINGS.glyphUnknown, word: "", color: colors.indicatorUnknown };
  }
}

interface ChromeInput {
  readonly regions: Regions;
  readonly spots: readonly PaneSpot[];
  readonly splits: readonly SplitCells[];
  readonly state: ModelState;
  readonly world: CoreView;
  readonly panes: ReadonlyMap<string, PaneView>;
  readonly link: { readonly kind: LinkState["kind"]; readonly code: string | null };
  readonly session: string;
  readonly cwd: string;
  readonly theme?: TuiThemeMode;
  readonly colors?: ColorDepth;
}

interface BuiltChrome {
  readonly parts: Part[];
  readonly overlays: Part[];
  readonly input: Scene["input"];
}

function folderBase(path: string): string {
  if (!path) return "~";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function keyForAction(state: ModelState, action: string, fallback: string): string {
  const row = state.keymap.rows.find((r) => r.action === action);
  return row?.bindings[0]?.text ?? fallback;
}

/** Builds the sidebar part (header with session + collapse toggle, Spaces with rollupStatus and worktrees, Agents). */
function buildSidebarPart(input: ChromeInput, colors: ThemeColors): Part {
  const { regions, state, world, link, session } = input;
  const rect = regions.sidebar;
  const shown = focused(state.world, state.focus);
  const activeWsId = state.mode.name === "navigate" && state.mode.preview !== null ? state.mode.preview : shown.workspace?.id ?? null;
  const version = JSON.stringify({
    rect,
    session,
    ownsLayout: world.ownsLayout,
    linkKind: link.kind,
    activeWsId,
    focusedPane: shown.pane?.id ?? null,
    groups: world.workspaceGroups,
    agents: world.agents,
  });

  return {
    key: "sidebar",
    rect,
    version,
    draw(canvas) {
      if (rect.width <= 0 || rect.height <= 0) return;
      const baseStyle = canvas.style({ fg: colors.text, bg: colors.bgPanel });
      const dimStyle = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
      const headStyle = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD });
      const ruleStyle = canvas.style({ fg: colors.border, bg: colors.bgPanel });
      canvas.fill(baseStyle);

      const contentW = Math.max(1, rect.width - 1);
      // Right border column separating sidebar from panes
      for (let r = rect.y; r < rect.y + rect.height; r++) {
        canvas.put(rect.x + rect.width - 1, r, "|", 1, ruleStyle);
      }

      let row = rect.y;
      // Row 0: Session header + collapse toggle
      fillSpan(canvas, rect.x, row, contentW, headStyle);
      const toggleText = STRINGS.sidebarToggleCollapse;
      const headerRoom = Math.max(0, contentW - toggleText.length - 1);
      printClipped(canvas, rect.x, row, STRINGS.sessionHeader(session), headerRoom, headStyle, true);
      if (contentW >= toggleText.length) {
        const toggleX = rect.x + contentW - toggleText.length;
        printClipped(canvas, toggleX, row, toggleText, toggleText.length, canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD }));
        canvas.hit({ x: toggleX, y: row, width: toggleText.length, height: 1 }, "toggle_sidebar");
      }
      row++;

      // Optional app-owned line in sidebar when herdr-app arranges the core
      if (!world.ownsLayout && row < rect.y + rect.height) {
        const noteStyle = canvas.style({ fg: colors.notice, bg: colors.bgPanel });
        printClipped(canvas, rect.x, row, STRINGS.appOwnedCore, contentW, noteStyle, true);
        row++;
      }

      if (row >= rect.y + rect.height) return;

      // Spaces section header
      const sectionStyle = canvas.style({ fg: colors.textDim, bg: colors.bgPanel, flags: STYLE_BOLD });
      printClipped(canvas, rect.x, row, STRINGS.spacesSection, contentW, sectionStyle);
      row++;

      // Flatten workspace rows (top-level + indented linked worktrees)
      interface WsItem {
        id: string;
        name: string;
        number: number;
        status: KnownStatus;
        indented: boolean;
      }
      const wsItems: WsItem[] = [];
      for (const group of world.workspaceGroups) {
        wsItems.push({ id: group.id, name: group.name, number: group.number, status: group.status, indented: false });
        for (const child of group.children) {
          wsItems.push({ id: child.id, name: child.name, number: child.number, status: child.status, indented: true });
        }
      }

      // Reserve space for Agents section (at least header + up to half remaining rows when agents exist)
      const totalRemaining = rect.y + rect.height - row;
      const agentCount = world.agents.length;
      const agentSectionNeed = agentCount > 0 ? Math.min(agentCount + 1, Math.max(2, Math.floor(totalRemaining / 2))) : 2;
      const wsBudget = Math.max(1, totalRemaining - agentSectionNeed);

      if (wsItems.length === 0 && row < rect.y + rect.height) {
        printClipped(canvas, rect.x, row, ` ${STRINGS.noSpaces}`, contentW, dimStyle, true);
        row++;
      } else {
        const focusedIdx = Math.max(0, wsItems.findIndex((item) => item.id === activeWsId));
        const startIdx = wsItems.length <= wsBudget ? 0 : Math.min(Math.max(0, focusedIdx - Math.floor(wsBudget / 2)), wsItems.length - wsBudget);
        const visibleWs = wsItems.slice(startIdx, startIdx + wsBudget);
        for (const item of visibleWs) {
          if (row >= rect.y + rect.height) break;
          const selected = item.id === activeWsId;
          const rowBg = selected ? colors.bgHover : colors.bgPanel;
          const rowFg = selected ? colors.textStrong : colors.text;
          const rowStyle = canvas.style({ fg: rowFg, bg: rowBg, flags: selected ? STYLE_BOLD : 0 });
          fillSpan(canvas, rect.x, row, contentW, rowStyle);

          const vis = stateVisual(item.status, colors);
          const dotStyle = canvas.style({ fg: vis.color, bg: rowBg, flags: STYLE_BOLD });
          const wordStyle = canvas.style({ fg: vis.color, bg: rowBg });

          let col = rect.x;
          const mark = selected ? ">" : " ";
          col = printClipped(canvas, col, row, mark, 1, canvas.style({ fg: colors.accent, bg: rowBg, flags: STYLE_BOLD }));
          col = printClipped(canvas, col, row, vis.glyph, 1, dotStyle);
          const prefix = item.indented ? `${STRINGS.worktreeMark}${item.number}:` : `${item.number}:`;
          col = printClipped(canvas, col, row, prefix, Math.max(0, rect.x + contentW - col), rowStyle);

          const wordSuffix = vis.word ? ` ${vis.word}` : "";
          const wordWidth = measure(wordSuffix).width;
          const nameBudget = Math.max(1, rect.x + contentW - col - (rect.x + contentW - col > wordWidth + 3 ? wordWidth : 0));
          col = printClipped(canvas, col, row, item.name, nameBudget, rowStyle, true);
          if (vis.word && rect.x + contentW - col >= wordWidth) {
            printClipped(canvas, rect.x + contentW - wordWidth, row, wordSuffix, wordWidth, wordStyle);
          }
          canvas.hit({ x: rect.x, y: row, width: contentW, height: 1 }, `workspace:${item.id}`);
          row++;
        }
      }

      if (row >= rect.y + rect.height) return;
      // Agents section header
      printClipped(canvas, rect.x, row, STRINGS.agentsSection, contentW, sectionStyle);
      row++;

      if (world.agents.length === 0) {
        if (row < rect.y + rect.height) {
          printClipped(canvas, rect.x, row, ` ${STRINGS.noAgents}`, contentW, dimStyle, true);
        }
        return;
      }

      const focusedPaneId = shown.pane?.id ?? null;
      const agentRowsLeft = rect.y + rect.height - row;
      const focusedAgentIdx = Math.max(0, world.agents.findIndex((a) => a.paneId === focusedPaneId));
      const agentStart = world.agents.length <= agentRowsLeft ? 0 : Math.min(Math.max(0, focusedAgentIdx - Math.floor(agentRowsLeft / 2)), world.agents.length - agentRowsLeft);
      for (const agent of world.agents.slice(agentStart, agentStart + agentRowsLeft)) {
        if (row >= rect.y + rect.height) break;
        const selected = agent.paneId === focusedPaneId;
        const rowBg = selected ? colors.bgHover : colors.bgPanel;
        const rowStyle = canvas.style({ fg: selected ? colors.textStrong : colors.text, bg: rowBg, flags: selected ? STYLE_BOLD : 0 });
        const subStyle = canvas.style({ fg: colors.textDim, bg: rowBg });
        fillSpan(canvas, rect.x, row, contentW, rowStyle);

        const vis = stateVisual(agent.status, colors);
        const dotStyle = canvas.style({ fg: vis.color, bg: rowBg, flags: STYLE_BOLD });
        let col = rect.x;
        col = printClipped(canvas, col, row, agent.helper ? " +" : " ", 2, subStyle);
        col = printClipped(canvas, col, row, `${vis.glyph} `, 2, dotStyle);
        // Show name, agent, folder and state word where it fits
        const statePart = vis.word ? ` ${vis.word}` : "";
        const stateW = measure(statePart).width;
        const room = Math.max(0, rect.x + contentW - col);
        const mainRoom = room > stateW + 4 ? room - stateW : room;
        const folderPart = agent.folder ? ` ${agent.folder === "/" ? "/" : `/${agent.folder}`}` : "";
        const agentPart = agent.agent && agent.agent !== agent.name ? ` ${agent.agent}` : "";
        const mainText = `${agent.name}${folderPart}${agentPart}`;
        col = printClipped(canvas, col, row, mainText, mainRoom, rowStyle, true);
        if (vis.word && rect.x + contentW - col >= stateW) {
          printClipped(canvas, rect.x + contentW - stateW, row, statePart, stateW, dotStyle);
        }
        canvas.hit({ x: rect.x, y: row, width: contentW, height: 1 }, `agent:${agent.paneId}`);
        row++;
      }
    },
  };
}

/** Builds the tab bar part (shows focused workspace's tabs, overflow revealing focused tab & full last label, zoom mark, session header when narrow/collapsed). */
function buildTabBarPart(input: ChromeInput, colors: ThemeColors): Part {
  const { regions, state, world, session } = input;
  const rect = regions.tabBar;
  const shown = focused(state.world, state.focus);
  const ws = shown.workspace;
  const activeTabId = shown.tab?.id ?? null;
  const tabShape = activeTabId ? world.tabs.get(activeTabId) ?? null : null;
  const isZoomed = tabShape?.zoomed !== null && tabShape?.zoomed !== undefined;
  const showSessionInBar = regions.sidebar.width === 0;
  const tabs = ws?.tabs ?? [];
  const version = JSON.stringify({
    rect,
    session: showSessionInBar ? session : "",
    ownsLayout: world.ownsLayout,
    wsId: ws?.id ?? null,
    activeTabId,
    isZoomed,
    tabs: tabs.map((t) => ({ id: t.id, name: t.name, status: world.tabStatuses.get(t.id) ?? "unknown", zoomed: (world.tabs.get(t.id)?.zoomed ?? null) !== null })),
  });

  return {
    key: "tabs",
    rect,
    version,
    draw(canvas) {
      if (rect.width <= 0 || rect.height <= 0) return;
      const barStyle = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
      canvas.fill(barStyle);

      const row = rect.y;
      let left = rect.x;
      let rightEdge = rect.x + rect.width;

      // When sidebar is collapsed or screen is narrow, show session header and expand toggle at the left of the tab bar
      if (showSessionInBar) {
        const headText = `${STRINGS.sessionHeader(session)} `;
        const headStyle = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD });
        left = printClipped(canvas, left, row, headText, Math.min(measure(headText).width, Math.max(0, rightEdge - left)), headStyle);
        canvas.hit({ x: rect.x, y: row, width: left - rect.x, height: 1 }, "toggle_sidebar");
      }

      // Right-hand badges: app-owned note and ZOOM badge
      if (isZoomed) {
        const badge = ` ${STRINGS.zoomMark} `;
        const bw = measure(badge).width;
        if (rightEdge - left >= bw) {
          rightEdge -= bw;
          printClipped(canvas, rightEdge, row, badge, bw, canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD }));
        }
      }
      if (!world.ownsLayout) {
        const badge = ` ${STRINGS.appOwnedCore} `;
        const bw = measure(badge).width;
        if (rightEdge - left >= bw + 12) {
          rightEdge -= bw;
          printClipped(canvas, rightEdge, row, badge, bw, canvas.style({ fg: colors.notice, bg: colors.bgPanel }));
        }
      }

      const avail = Math.max(0, rightEdge - left);
      if (avail <= 0) return;
      if (tabs.length === 0) {
        printClipped(canvas, left, row, ` ${STRINGS.noTabs}`, avail, barStyle, true);
        return;
      }

      // Build formatted tab items
      const entries = tabs.map((tab, idx) => {
        const num = idx + 1;
        const customNamed = tab.name !== "" && tab.name !== String(num);
        const tabZoomed = (world.tabs.get(tab.id)?.zoomed ?? null) !== null;
        const status = world.tabStatuses.get(tab.id) ?? "unknown";
        const vis = stateVisual(status, colors);
        const statusMark = status !== "unknown" && status !== "idle" ? `${vis.glyph}` : "";
        const label = ` ${num}:${tab.name || String(num)}${tabZoomed ? STRINGS.tabZoomSuffix : ""}${statusMark ? ` ${statusMark}` : ""} `;
        return {
          id: tab.id,
          label,
          width: measure(label).width,
          active: tab.id === activeTabId,
          customNamed,
          status,
        };
      });

      // Overflow windowing: reveal the focused tab and ensure the last tab shows its full label when included
      const activeIdx = Math.max(0, entries.findIndex((e) => e.active));
      let start = 0;
      let end = entries.length;
      const totalWidth = entries.reduce((sum, e) => sum + e.width, 0);
      if (totalWidth > avail) {
        start = activeIdx;
        end = activeIdx + 1;
        let used = entries[activeIdx]!.width;
        while (end < entries.length || start > 0) {
          let added = false;
          if (end < entries.length && used + entries[end]!.width <= avail - (start > 0 ? 2 : 0)) {
            used += entries[end]!.width;
            end++;
            added = true;
          }
          if (start > 0 && used + entries[start - 1]!.width <= avail - (end < entries.length ? 2 : 0)) {
            start--;
            used += entries[start]!.width;
            added = true;
          }
          if (!added) break;
        }
      }

      let col = left;
      if (start > 0 && col < rightEdge) {
        col = printClipped(canvas, col, row, "< ", Math.min(2, rightEdge - col), canvas.style({ fg: colors.accent, bg: colors.bgPanel, flags: STYLE_BOLD }));
      }
      for (let i = start; i < end; i++) {
        const entry = entries[i]!;
        const room = rightEdge - col - (end < entries.length ? 2 : 0);
        if (room <= 0) break;
        const bg = entry.active ? colors.bgElevated : colors.bgPanel;
        const fg = entry.active ? colors.accent : colors.text;
        const flags = (entry.active || entry.customNamed) ? STYLE_BOLD : 0;
        const style = canvas.style({ fg, bg, flags });
        const startCol = col;
        col = printClipped(canvas, col, row, entry.label, room, style);
        canvas.hit({ x: startCol, y: row, width: col - startCol, height: 1 }, `tab:${entry.id}`);
      }
      if (end < entries.length && col < rightEdge) {
        printClipped(canvas, Math.max(col, rightEdge - 2), row, " >", Math.min(2, rightEdge - col), canvas.style({ fg: colors.accent, bg: colors.bgPanel, flags: STYLE_BOLD }));
      }
    },
  };
}

function paneStatusBanner(view: PaneView | undefined, linkKind: LinkState["kind"], _linkCode: string | null): { text: string; tone: "error" | "warn" | "info" } | null {
  if (linkKind !== "Online") {
    return { text: STRINGS.offlinePaneBanner(), tone: "warn" };
  }
  if (!view) return null;
  const { state, sizedBy } = view;
  switch (state.kind) {
    case "Ended":
      return { text: STRINGS.endedCode(state.code), tone: "info" };
    case "Waiting":
      if (state.why === "lost") return { text: STRINGS.waitingNewShell, tone: "warn" };
      if (state.why === "offline") return { text: `${STRINGS.waitingOffline} [${STRINGS.retryHint}]`, tone: "warn" };
      return { text: `${STRINGS.waitingClosed} [${STRINGS.retryHint}]`, tone: "warn" };
    case "Failed":
      return { text: `[${STRINGS.retryHint}] ${STRINGS.failedPane(state.reason)}`, tone: "error" };
    case "Opening":
      return { text: STRINGS.openingPane, tone: "info" };
    case "Painting":
      return { text: STRINGS.paintingPane, tone: "info" };
    case "Closing":
      return { text: STRINGS.closingPane, tone: "info" };
    case "Idle":
      return { text: STRINGS.retryHint, tone: "info" };
    case "Live":
      if (sizedBy !== null) return { text: STRINGS.sizedByViewer(sizedBy.cols, sizedBy.rows), tone: "warn" };
      return null;
  }
}

/** Builds the panes chrome part (pane borders, titles, zoom/sizedBy/status banners, offline/empty-core states, divider hit targets). */
function buildBordersPart(input: ChromeInput, colors: ThemeColors): Part {
  const { regions, spots, splits, state, world, panes, link, cwd } = input;
  const rect = regions.panes;
  const shown = focused(state.world, state.focus);
  const focusedPaneId = shown.pane?.id ?? null;
  const activeTabId = shown.tab?.id ?? null;
  const tabShape = activeTabId ? world.tabs.get(activeTabId) ?? null : null;
  const zoomedPaneId = tabShape?.zoomed ?? null;
  const visibleSpots = spots.filter((s) => !s.covered);

  const version = JSON.stringify({
    rect,
    focusedPaneId,
    zoomedPaneId,
    ownsLayout: world.ownsLayout,
    link,
    cwd,
    spots: visibleSpots.map((s) => {
      const pv = panes.get(s.pane);
      const summary = world.panes.get(s.pane);
      return {
        pane: s.pane,
        outer: s.cells.outer,
        inner: s.cells.inner,
        state: pv?.state ?? null,
        sizedBy: pv?.sizedBy ?? null,
        summary: summary ?? null,
      };
    }),
    splits,
  });

  return {
    key: "borders",
    rect,
    version,
    draw(canvas) {
      if (rect.width <= 0 || rect.height <= 0) return;

      // Empty core / no panes in tab
      if (visibleSpots.length === 0) {
        const bgStyle = canvas.style({ fg: colors.text, bg: colors.bg });
        canvas.fill(bgStyle);
        const midY = rect.y + Math.floor(rect.height / 2);
        if (link.kind !== "Online") {
          const warnStyle = canvas.style({ fg: colors.notice, bg: colors.bgElevated, flags: STYLE_BOLD });
          printClipped(canvas, rect.x + 2, Math.max(rect.y, midY - 1), STRINGS.offlineDetail(link.code), Math.max(0, rect.width - 4), warnStyle, true);
          return;
        }
        const titleStyle = canvas.style({ fg: colors.textStrong, bg: colors.bg, flags: STYLE_BOLD });
        const offerStyle = canvas.style({ fg: colors.accent, bg: colors.bg });
        const newWsKey = keyForAction(state, "new_workspace", "prefix+Shift+N");
        const folder = folderBase(cwd);
        if (midY - 1 >= rect.y) {
          printClipped(canvas, rect.x + 2, midY - 1, STRINGS.emptyCoreTitle, Math.max(0, rect.width - 4), titleStyle, true);
        }
        printClipped(canvas, rect.x + 2, midY, STRINGS.emptyCoreOffer(folder, newWsKey), Math.max(0, rect.width - 4), offerStyle, true);
        if (!world.ownsLayout && midY + 1 < rect.y + rect.height) {
          printClipped(canvas, rect.x + 2, midY + 1, STRINGS.appOwnedCore, Math.max(0, rect.width - 4), canvas.style({ fg: colors.notice, bg: colors.bg }), true);
        }
        canvas.hit(rect, "new_workspace");
        return;
      }

      // Draw each visible pane's border, title, and status notice
      for (const spot of visibleSpots) {
        const { outer, inner } = spot.cells;
        const isFocused = spot.pane === focusedPaneId && link.kind === "Online";
        const summary = world.panes.get(spot.pane);
        const pv = panes.get(spot.pane);
        const banner = paneStatusBanner(pv, link.kind, link.code);

        if (outer.width !== inner.width && outer.height !== inner.height) {
          const borderColor = link.kind !== "Online"
            ? colors.notice
            : isFocused
              ? colors.accent
              : colors.borderStrong;
          const borderStyle = canvas.style({ fg: borderColor, bg: colors.bg, flags: isFocused ? STYLE_BOLD : 0 });
          const right = outer.x + outer.width - 1;
          const bottom = outer.y + outer.height - 1;

          for (let col = outer.x; col <= right; col++) {
            canvas.put(col, outer.y, col === outer.x || col === right ? "+" : "-", 1, borderStyle);
            canvas.put(col, bottom, col === outer.x || col === right ? "+" : "-", 1, borderStyle);
          }
          for (let row = outer.y + 1; row < bottom; row++) {
            canvas.put(outer.x, row, "|", 1, borderStyle);
            canvas.put(right, row, "|", 1, borderStyle);
          }

          // Top border title: name, folder, agent, zoom mark, and state glyph/word
          const titleRoom = Math.max(0, outer.width - 4);
          if (titleRoom > 0) {
            const namePart = summary?.label || summary?.title || spot.pane;
            const folderPart = summary?.folder && summary.folder !== namePart ? ` ${summary.folder}` : "";
            const agentPart = summary?.agent ? ` [${summary.agent}]` : "";
            const zoomPart = zoomedPaneId === spot.pane ? ` [${STRINGS.zoomMark}]` : "";
            const statusVis = summary?.status ? stateVisual(summary.status, colors) : null;
            const statePart = statusVis && statusVis.word ? ` ${statusVis.glyph} ${statusVis.word}` : "";
            const fullTitle = ` ${namePart}${folderPart}${agentPart}${zoomPart}${statePart} `;
            const titleStyle = canvas.style({
              fg: isFocused ? colors.textStrong : colors.text,
              bg: colors.bg,
              flags: isFocused ? STYLE_BOLD : 0,
            });
            printClipped(canvas, outer.x + 2, outer.y, fullTitle, titleRoom, titleStyle, true);
          }

          // Bottom border status banner (sized by another viewer, ended, waiting, offline, failed)
          if (banner && titleRoom > 0) {
            const bannerFg = banner.tone === "error" ? colors.dangerText : banner.tone === "warn" ? colors.notice : colors.textDim;
            const bannerStyle = canvas.style({ fg: bannerFg, bg: colors.bgElevated, flags: STYLE_BOLD });
            printClipped(canvas, outer.x + 2, bottom, ` ${banner.text} `, titleRoom, bannerStyle, true);
            if (pv?.state.kind === "Waiting" || pv?.state.kind === "Failed") {
              canvas.hit({ x: outer.x + 1, y: bottom, width: outer.width - 2, height: 1 }, `retry:${spot.pane}`);
            }
          }
        }
      }

      // Register divider hit targets for each split in the tab's tree (for mouse divider drag)
      for (const split of splits) {
        if (split.rect.width <= 0 || split.rect.height <= 0) continue;
        // Find panes on the first side vs second side of this split rectangle to locate the divider line
        const inside = visibleSpots.filter((s) =>
          s.cells.outer.x >= split.rect.x &&
          s.cells.outer.y >= split.rect.y &&
          s.cells.outer.x + s.cells.outer.width <= split.rect.x + split.rect.width &&
          s.cells.outer.y + s.cells.outer.height <= split.rect.y + split.rect.height,
        );
        if (split.direction === "right") {
          const seamX = inside.reduce((best, s) => {
            const right = s.cells.outer.x + s.cells.outer.width;
            return right < split.rect.x + split.rect.width ? Math.max(best, right - 1) : best;
          }, split.rect.x + Math.floor(split.rect.width / 2));
          canvas.hit({ x: seamX, y: split.rect.y, width: Math.min(2, split.rect.x + split.rect.width - seamX), height: split.rect.height }, split.id);
        } else {
          const seamY = inside.reduce((best, s) => {
            const bottom = s.cells.outer.y + s.cells.outer.height;
            return bottom < split.rect.y + split.rect.height ? Math.max(best, bottom - 1) : best;
          }, split.rect.y + Math.floor(split.rect.height / 2));
          canvas.hit({ x: split.rect.x, y: seamY, width: split.rect.width, height: Math.min(2, split.rect.y + split.rect.height - seamY) }, split.id);
        }
      }
    },
  };
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  prefix: "prefix",
  help: "help",
  new_workspace: "new space",
  rename_workspace: "rename space",
  close_workspace: "close space",
  workspace_picker: "navigate",
  goto: "go to",
  detach: "detach",
  reload_config: "reload",
  open_notification_target: "jump alert",
  previous_workspace: "prev space",
  next_workspace: "next space",
  previous_agent: "prev agent",
  next_agent: "next agent",
  focus_agent: "agent",
  new_tab: "new tab",
  rename_tab: "rename tab",
  previous_tab: "prev tab",
  next_tab: "next tab",
  move_tab_previous: "move tab <",
  move_tab_next: "move tab >",
  switch_tab: "tab",
  switch_workspace: "space",
  close_tab: "close tab",
  rename_pane: "rename pane",
  copy_mode: "copy",
  focus_pane_left: "left",
  focus_pane_down: "down",
  focus_pane_up: "up",
  focus_pane_right: "right",
  swap_pane_left: "swap <",
  swap_pane_down: "swap v",
  swap_pane_up: "swap ^",
  swap_pane_right: "swap >",
  last_pane: "last pane",
  cycle_pane_next: "next pane",
  cycle_pane_previous: "prev pane",
  split_vertical: "split |",
  split_horizontal: "split -",
  close_pane: "close pane",
  zoom: "zoom",
  resize_mode: "resize",
  resize_pane_left: "grow <",
  resize_pane_down: "grow v",
  resize_pane_up: "grow ^",
  resize_pane_right: "grow >",
  toggle_sidebar: "sidebar",
  lock: "lock",
  navigate_workspace_up: "space ^",
  navigate_workspace_down: "space v",
  navigate_pane_left: "pane <",
  navigate_pane_down: "pane v",
  navigate_pane_up: "pane ^",
  navigate_pane_right: "pane >",
  navigate_focus: "select",
  navigate_cancel: "cancel",
  navigate_index: "space 1..9",
  navigate_cycle_next: "next pane",
  navigate_cycle_previous: "prev pane",
  resize_leave: "done",
  copy_leave: "done",
};

function formatKeymapNote(note: KeymapNote): string {
  switch (note.code) {
    case "prefix_fallback":
      return STRINGS.notePrefixFallback(note.binding, note.fallback);
    case "prefix_unreachable":
      return STRINGS.notePrefixUnreachable(note.binding, note.skipped.map((s) => `${s.key}->${s.holder}`).join(", "));
    case "detach_fallback":
      return STRINGS.noteDetachFallback(note.fallback);
    case "detach_unreachable":
      return STRINGS.noteDetachUnreachable(note.skipped.map((s) => `${s.key}->${s.holder}`).join(", "));
    case "lock_taken":
      return STRINGS.noteLockTaken(note.holder);
    case "taken":
      return STRINGS.noteTaken(note.action, note.binding, note.holder);
    case "indexed_legacy":
      return STRINGS.noteIndexedLegacy(note.entry);
    case "blank_binding":
      return STRINGS.noteBlankBinding(note.action);
    case "no_such_modifier":
    case "not_typable":
    case "shift_in_text":
    case "shifted_character":
    case "cancel_key":
    case "fixed_key":
      return STRINGS.noteDropped(note.code, note.action, note.binding);
  }
}

/** Builds the bottom mode bar and hint line from `modeBar(state)`, plus offline / unreachable / error indicators. */
function buildModeBarPart(input: ChromeInput, colors: ThemeColors): Part {
  const { regions, state, link } = input;
  const rect = regions.modeBar;
  const bar = modeBar(state);
  const unreachable = state.keymap.notes.filter((n) => n.code === "prefix_unreachable" || n.code === "detach_unreachable");
  const latestNotice: Notice | undefined = state.notices.at(-1);

  const version = JSON.stringify({
    rect,
    bar,
    link,
    unreachable,
    latestNotice: latestNotice ? { id: latestNotice.id, code: latestNotice.code, data: latestNotice.data } : null,
  });

  return {
    key: "mode",
    rect,
    version,
    draw(canvas) {
      if (rect.width <= 0 || rect.height <= 0) return;
      const bgStyle = canvas.style({ fg: colors.text, bg: colors.bgPanel });
      canvas.fill(bgStyle);

      const row = rect.y;
      let col = rect.x;
      const right = rect.x + rect.width;

      // Mode badge
      const modeLabel =
        bar.mode === "prefix" ? STRINGS.modePrefix
          : bar.mode === "locked" ? STRINGS.modeLocked
            : bar.mode === "navigate" ? STRINGS.modeNavigate
              : bar.mode === "resize" ? STRINGS.modeResize
                : bar.mode === "copy" ? STRINGS.modeCopy
                  : STRINGS.modeTerminal;
      const badgeBg =
        bar.mode === "prefix" ? colors.accent
          : bar.mode === "locked" ? colors.statusBlocked
            : bar.mode !== "terminal" ? colors.statusWorking
              : colors.bgElevated;
      const badgeFg = bar.mode === "terminal" ? colors.textStrong : colors.primaryText;
      const badgeStyle = canvas.style({ fg: badgeFg, bg: badgeBg, flags: STYLE_BOLD });
      col = printClipped(canvas, col, row, ` ${modeLabel} `, Math.max(0, right - col), badgeStyle);

      // Offline state on mode bar if link is not Online
      if (link.kind !== "Online" && col < right) {
        const offStyle = canvas.style({ fg: colors.notice, bg: colors.bgPanel, flags: STYLE_BOLD });
        col = printClipped(canvas, col, row, ` ${STRINGS.offlineDetail(link.code)} `, Math.max(0, right - col), offStyle, true);
      }

      // Unreachable prefix or detach warning on mode bar
      for (const note of unreachable) {
        if (col >= right) break;
        const warnStyle = canvas.style({ fg: colors.dangerText, bg: colors.bgPanel, flags: STYLE_BOLD });
        col = printClipped(canvas, col, row, ` [${note.code}] `, Math.max(0, right - col), warnStyle, true);
      }

      // Hints from modeBar(state)
      const keyStyle = canvas.style({ fg: colors.accent, bg: colors.bgPanel, flags: STYLE_BOLD });
      const labelStyle = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
      for (const hint of bar.hints) {
        if (col >= right) break;
        const keyText = hint.keys.join("/");
        const actionName = ACTION_LABELS[hint.action] ?? hint.action.replaceAll("_", " ");
        const pieceWidth = measure(` ${keyText} ${actionName}`).width;
        if (col + pieceWidth > right && col > rect.x + measure(` ${modeLabel} `).width) {
          // If it doesn't fit completely, print clipped and stop
          col = printClipped(canvas, col, row, ` ${keyText}`, Math.max(0, right - col), keyStyle);
          col = printClipped(canvas, col, row, ` ${actionName}`, Math.max(0, right - col), labelStyle, true);
          break;
        }
        col = printClipped(canvas, col, row, ` ${keyText}`, Math.max(0, right - col), keyStyle);
        col = printClipped(canvas, col, row, ` ${actionName}`, Math.max(0, right - col), labelStyle);
      }

      // Active notice / error badge on the right side of the mode bar when Online (when Offline, the toast shows notices while the mode bar keeps the offline command visible)
      if (latestNotice && link.kind === "Online") {
        const msg = ` ${STRINGS.errorBadge}: ${STRINGS.noticeText(latestNotice.code, latestNotice.data)} `;
        const msgW = Math.min(measure(msg).width, Math.max(0, Math.floor(rect.width * 0.65)));
        if (msgW > 0) {
          const startX = Math.max(rect.x, right - msgW);
          const errStyle = canvas.style({ fg: colors.dangerText, bg: colors.bgElevated, flags: STYLE_BOLD });
          fillSpan(canvas, startX, row, right - startX, errStyle);
          printClipped(canvas, startX, row, msg, right - startX, errStyle, true);
        }
      }
    },
  };
}

function drawOverlayFrame(canvas: Canvas, rect: Rect, title: string, closeKeys: readonly string[], colors: ThemeColors): { inner: Rect } {
  const bgStyle = canvas.style({ fg: colors.text, bg: colors.bgElevated });
  const borderStyle = canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD });
  const titleStyle = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD });
  const closeStyle = canvas.style({ fg: colors.accent, bg: colors.bgElevated });

  fillBox(canvas, rect, bgStyle);
  if (rect.width < 2 || rect.height < 2) return { inner: rect };

  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  for (let col = rect.x; col <= right; col++) {
    canvas.put(col, rect.y, col === rect.x || col === right ? "+" : "-", 1, borderStyle);
    canvas.put(col, bottom, col === rect.x || col === right ? "+" : "-", 1, borderStyle);
  }
  for (let row = rect.y + 1; row < bottom; row++) {
    canvas.put(rect.x, row, "|", 1, borderStyle);
    canvas.put(right, row, "|", 1, borderStyle);
  }

  const closeLabel = ` [${STRINGS.helpCloseLabel(closeKeys)}] `;
  const closeW = measure(closeLabel).width;
  const headerRoom = Math.max(0, rect.width - 2);
  if (headerRoom > 0) {
    const titleRoom = Math.max(0, headerRoom - closeW);
    if (titleRoom > 0) {
      printClipped(canvas, rect.x + 1, rect.y, ` ${title} `, titleRoom, titleStyle, true);
    }
    const closeX = Math.max(rect.x + 1, right - closeW);
    printClipped(canvas, closeX, rect.y, closeLabel, Math.min(closeW, right - closeX), closeStyle);
    canvas.hit({ x: closeX, y: rect.y, width: Math.min(closeW, right - closeX), height: 1 }, "close");
  }

  return {
    inner: {
      x: rect.x + 1,
      y: rect.y + 1,
      width: Math.max(0, rect.width - 2),
      height: Math.max(0, rect.height - 2),
    },
  };
}

function drawFieldLine(
  canvas: Canvas,
  col: number,
  row: number,
  width: number,
  field: Field,
  colors: ThemeColors,
): { col: number; row: number } {
  const fieldStyle = canvas.style({ fg: colors.textStrong, bg: colors.bgInput, flags: field.fresh ? STYLE_INVERSE : 0 });
  fillSpan(canvas, col, row, width, fieldStyle);
  const before = field.graphemes.slice(0, field.cursor).join("");
  const after = field.graphemes.slice(field.cursor).join("");
  const text = before + after;
  const beforeW = measure(before).width;
  const maxCursorOffset = Math.max(0, width - 1);
  const scrollCols = beforeW > maxCursorOffset ? beforeW - maxCursorOffset : 0;
  // Slice graphemes from start until width fits
  let skipped = 0;
  let startIdx = 0;
  while (startIdx < field.graphemes.length && skipped < scrollCols) {
    skipped += measure(field.graphemes[startIdx]!).width;
    startIdx++;
  }
  const visibleText = startIdx === 0 ? text : field.graphemes.slice(startIdx).join("");
  printClipped(canvas, col, row, visibleText, width, fieldStyle);
  const cursorCol = col + Math.max(0, Math.min(maxCursorOffset, beforeW - skipped));
  return { col: cursorCol, row };
}

/** Builds the overlays (modal overlay on top of the stack + corner notice toast when notices exist). */
export function buildOverlays(
  width: number,
  height: number,
  state: ModelState,
  world: CoreView,
  theme: TuiThemeMode = "dark",
  depth: ColorDepth = "truecolor",
): { overlays: Part[]; input: Scene["input"] } {
  const colors = themeColors(theme, depth);
  const overlays: Part[] = [];
  let input: Scene["input"] = null;

  // Toast overlay in top-right corner for active notices
  if (state.notices.length > 0 && width >= 16 && height >= 3) {
    const shownNotices = state.notices.slice(-3);
    const lines = shownNotices.map((n) => `${STRINGS.glyphBlocked} ${STRINGS.noticeText(n.code, n.data)}`);
    const maxLineW = Math.max(...lines.map((l) => measure(l).width));
    const toastW = Math.min(width, Math.max(20, maxLineW + 4));
    const toastH = Math.min(height, lines.length + 2);
    const toastRect: Rect = { x: Math.max(0, width - toastW), y: Math.min(1, height - toastH), width: toastW, height: toastH };
    overlays.push({
      key: "toast",
      rect: toastRect,
      version: JSON.stringify(shownNotices),
      draw(canvas) {
        const bgStyle = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated });
        const borderStyle = canvas.style({ fg: colors.notice, bg: colors.bgElevated, flags: STYLE_BOLD });
        fillBox(canvas, toastRect, bgStyle);
        const right = toastRect.x + toastRect.width - 1;
        const bottom = toastRect.y + toastRect.height - 1;
        for (let c = toastRect.x; c <= right; c++) {
          canvas.put(c, toastRect.y, c === toastRect.x || c === right ? "+" : "-", 1, borderStyle);
          canvas.put(c, bottom, c === toastRect.x || c === right ? "+" : "-", 1, borderStyle);
        }
        for (let r = toastRect.y + 1; r < bottom; r++) {
          canvas.put(toastRect.x, r, "|", 1, borderStyle);
          canvas.put(right, r, "|", 1, borderStyle);
        }
        lines.forEach((line, idx) => {
          const r = toastRect.y + 1 + idx;
          if (r < bottom) {
            printClipped(canvas, toastRect.x + 2, r, line, Math.max(0, toastRect.width - 4), bgStyle, true);
          }
        });
      },
    });
  }

  const top: Overlay | undefined = state.overlays.at(-1);
  if (!top) return { overlays, input };

  const closeKeys = OVERLAYS[top.kind].closeKeys;
  if (top.kind === "help") {
    input = "overlay";
    const boxW = Math.max(1, Math.min(width, Math.max(44, width - 8)));
    const boxH = Math.max(1, Math.min(height, Math.max(12, height - 4)));
    const rect: Rect = {
      x: Math.floor((width - boxW) / 2),
      y: Math.floor((height - boxH) / 2),
      width: boxW,
      height: boxH,
    };
    const rows = helpRows(state.keymap);
    const refusals = shownRefusals(state.keymap);
    const notes = state.keymap.notes;

    overlays.push({
      key: "overlay:help",
      rect,
      version: JSON.stringify({ rect, rows, refusals, notes, ownsLayout: world.ownsLayout }),
      draw(canvas) {
        const { inner } = drawOverlayFrame(canvas, rect, STRINGS.helpTitle, closeKeys, colors);
        if (inner.width <= 0 || inner.height <= 0) return;

        let r = inner.y;
        const bottom = inner.y + inner.height;
        const keyStyle = canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD });
        const textStyle = canvas.style({ fg: colors.text, bg: colors.bgElevated });
        const dimStyle = canvas.style({ fg: colors.textDim, bg: colors.bgElevated });
        const warnStyle = canvas.style({ fg: colors.dangerText, bg: colors.bgElevated, flags: STYLE_BOLD });
        const noteStyle = canvas.style({ fg: colors.notice, bg: colors.bgElevated });

        if (!world.ownsLayout && r < bottom) {
          printClipped(canvas, inner.x + 1, r++, STRINGS.appOwnedCore, Math.max(0, inner.width - 2), noteStyle, true);
        }

        // Draw keymap notes first (unreachable notes and fallbacks clearly visible at the top)
        for (const note of notes) {
          if (r >= bottom) break;
          const isUnreachable = note.code === "prefix_unreachable" || note.code === "detach_unreachable";
          printClipped(
            canvas,
            inner.x + 1,
            r++,
            formatKeymapNote(note),
            Math.max(0, inner.width - 2),
            isUnreachable ? warnStyle : noteStyle,
            true,
          );
        }

        // Draw config refusals if any
        if (refusals.shown.length > 0 && r < bottom) {
          printClipped(canvas, inner.x + 1, r++, STRINGS.helpRefusalsTitle, Math.max(0, inner.width - 2), warnStyle, true);
          for (const ref of refusals.shown) {
            if (r >= bottom) break;
            const holderPart = ref.holder ? ` (held by ${ref.holder})` : "";
            printClipped(
              canvas,
              inner.x + 1,
              r++,
              `${ref.code}: ${ref.action} = ${ref.binding}${holderPart}`,
              Math.max(0, inner.width - 2),
              noteStyle,
              true,
            );
          }
          if (refusals.more > 0 && r < bottom) {
            printClipped(canvas, inner.x + 1, r++, STRINGS.helpMoreRefusals(refusals.more), Math.max(0, inner.width - 2), dimStyle, true);
          }
        }

        // Draw keymap help rows (in two columns when wide enough, else one column)
        const availRows = Math.max(0, bottom - r);
        if (availRows <= 0) return;
        const twoCols = inner.width >= 76 && rows.length > availRows;
        const colW = twoCols ? Math.floor((inner.width - 3) / 2) : Math.max(1, inner.width - 2);
        const keyColW = Math.min(18, Math.max(8, Math.floor(colW * 0.42)));

        rows.forEach((helpRow, idx) => {
          const colIdx = twoCols ? Math.floor(idx / availRows) : 0;
          const rowIdx = twoCols ? idx % availRows : idx;
          if (colIdx > (twoCols ? 1 : 0) || r + rowIdx >= bottom) return;
          const x = inner.x + 1 + colIdx * (colW + 1);
          const y = r + rowIdx;
          const keysText = helpRow.keys.length > 0 ? helpRow.keys.join(", ") : STRINGS.helpUnset;
          const kStyle = helpRow.keys.length > 0 ? keyStyle : dimStyle;
          printClipped(canvas, x, y, keysText, keyColW, kStyle, true);
          const descX = x + keyColW + 1;
          const descRoom = Math.max(0, x + colW - descX);
          const label = ACTION_LABELS[helpRow.action] ?? helpRow.action.replaceAll("_", " ");
          const parityNote = helpRow.status === "parity" ? ` (${STRINGS.helpParityPrefix})` : helpRow.mode !== "terminal" ? ` [${helpRow.mode}]` : "";
          printClipped(canvas, descX, y, `${label}${parityNote}`, descRoom, helpRow.status === "parity" ? dimStyle : textStyle, true);
        });
      },
    });
    return { overlays, input };
  }

  if (top.kind === "text") {
    const boxW = Math.max(1, Math.min(width, 52));
    const boxH = Math.max(1, Math.min(height, 5));
    const rect: Rect = {
      x: Math.floor((width - boxW) / 2),
      y: Math.floor((height - boxH) / 2),
      width: boxW,
      height: boxH,
    };
    const title =
      top.purpose === "rename_workspace" ? STRINGS.textRenameWorkspace
        : top.purpose === "rename_tab" ? STRINGS.textRenameTab
          : top.purpose === "rename_pane" ? STRINGS.textRenamePane
            : STRINGS.textNewTab;
    const fieldY = rect.y + Math.min(1, Math.max(0, rect.height - 1));
    const fieldX = rect.x + Math.min(2, Math.max(0, rect.width - 1));
    const fieldW = Math.max(1, rect.width - 4);
    const beforeW = measure(top.field.graphemes.slice(0, top.field.cursor).join("")).width;
    input = { col: fieldX + Math.min(Math.max(0, fieldW - 1), beforeW), row: fieldY };

    overlays.push({
      key: "overlay:text",
      rect,
      version: JSON.stringify({ rect, top }),
      draw(canvas) {
        const { inner } = drawOverlayFrame(canvas, rect, title, closeKeys, colors);
        if (inner.width <= 0 || inner.height <= 0) return;
        drawFieldLine(canvas, inner.x + 1, inner.y, Math.max(1, inner.width - 2), top.field, colors);
        if (inner.height >= 2) {
          const hintStyle = canvas.style({ fg: colors.textDim, bg: colors.bgElevated });
          printClipped(canvas, inner.x + 1, inner.y + 1, STRINGS.textPromptHint, Math.max(0, inner.width - 2), hintStyle, true);
        }
      },
    });
    return { overlays, input };
  }

  if (top.kind === "confirm") {
    input = "overlay";
    const boxW = Math.max(1, Math.min(width, 54));
    const boxH = Math.max(1, Math.min(height, 5));
    const rect: Rect = {
      x: Math.floor((width - boxW) / 2),
      y: Math.floor((height - boxH) / 2),
      width: boxW,
      height: boxH,
    };
    const ws = state.world.workspaces.find((w) => w.id === top.target.id);
    const label = ws?.name || top.target.id;
    overlays.push({
      key: "overlay:confirm",
      rect,
      version: JSON.stringify({ rect, top, label }),
      draw(canvas) {
        const { inner } = drawOverlayFrame(canvas, rect, STRINGS.confirmCloseWorkspace(label), closeKeys, colors);
        if (inner.width <= 0 || inner.height <= 0) return;
        const warnStyle = canvas.style({ fg: colors.dangerText, bg: colors.bgElevated, flags: STYLE_BOLD });
        printClipped(canvas, inner.x + 1, inner.y, STRINGS.confirmCloseWorkspace(label), Math.max(0, inner.width - 2), warnStyle, true);
      },
    });
    return { overlays, input };
  }

  // goto overlay
  const boxW = Math.max(1, Math.min(width, 64));
  const boxH = Math.max(1, Math.min(height, 14));
  const rect: Rect = {
    x: Math.floor((width - boxW) / 2),
    y: Math.floor((height - boxH) / 2),
    width: boxW,
    height: boxH,
  };
  const fieldY = rect.y + Math.min(1, Math.max(0, rect.height - 1));
  const fieldX = rect.x + Math.min(2, Math.max(0, rect.width - 1));
  const fieldW = Math.max(1, rect.width - 4);
  const beforeW = measure(top.field.graphemes.slice(0, top.field.cursor).join("")).width;
  input = { col: fieldX + Math.min(Math.max(0, fieldW - 1), beforeW), row: fieldY };

  overlays.push({
    key: "overlay:goto",
    rect,
    version: JSON.stringify({ rect, top, workspaces: state.world.workspaces }),
    draw(canvas) {
      const { inner } = drawOverlayFrame(canvas, rect, STRINGS.gotoTitle, closeKeys, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      drawFieldLine(canvas, inner.x + 1, inner.y, Math.max(1, inner.width - 2), top.field, colors);
      if (inner.height >= 2) {
        const hintStyle = canvas.style({ fg: colors.textDim, bg: colors.bgElevated });
        printClipped(canvas, inner.x + 1, inner.y + 1, STRINGS.gotoPromptHint, Math.max(0, inner.width - 2), hintStyle, true);
      }
    },
  });
  return { overlays, input };
}

/** Builds all chrome parts and overlays for one frame pass. */
export function buildChrome(input: ChromeInput): BuiltChrome {
  const theme = input.theme ?? "dark";
  const depth = input.colors ?? "truecolor";
  const colors = themeColors(theme, depth);
  const parts: Part[] = [
    buildSidebarPart(input, colors),
    buildTabBarPart(input, colors),
    buildBordersPart(input, colors),
    buildModeBarPart(input, colors),
  ];
  const { overlays, input: sceneInput } = buildOverlays(
    input.regions.screen.width,
    input.regions.screen.height,
    input.state,
    input.world,
    theme,
    depth,
  );
  return { parts, overlays, input: sceneInput };
}
