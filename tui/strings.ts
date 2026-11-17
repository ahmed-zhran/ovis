/**
 * Every user-facing English string of the terminal screen, kept in one module so translations can
 * follow later and the wording conventions scan (src/conventions.test.ts) checks them in one place.
 */

export const STRINGS = {
  // Sidebar & header
  sessionHeader: (session: string): string => `hc:${session}`,
  spacesSection: "Spaces",
  agentsSection: "Agents",
  noSpaces: "No workspaces",
  noAgents: "No agents",
  sidebarToggleCollapse: "<<",
  worktreeMark: "|-",

  // Tab bar
  zoomMark: "ZOOM",
  tabZoomSuffix: " Z",
  noTabs: "No tabs",

  // State words (matching src/lib/inboxRow.ts and DESIGN.md)
  stateBlocked: "Needs you",
  stateWorking: "Working",
  stateDone: "Done",
  stateIdle: "Ready",

  // State glyphs (never colour alone)
  glyphBlocked: "!",
  glyphDone: "*",
  glyphWorking: "~",
  glyphIdle: "-",
  glyphUnknown: "·",

  // Mode bar labels
  modeTerminal: "TERMINAL",
  modePrefix: "PREFIX",
  modeNavigate: "NAVIGATE",
  modeResize: "RESIZE",
  modeCopy: "COPY",
  modeLocked: "LOCKED",
  errorBadge: "ERROR",

  // Visible states & banners
  offlineTitle: "herdr-core is not answering",
  offlineCommand: "hc server start",
  offlineDetail: (code: string | null): string => `${STRINGS.offlineTitle}: ${STRINGS.offlineCommand}${code ? ` (${code})` : ""}`,
  offlinePaneBanner: (): string => `${STRINGS.offlineTitle} · ${STRINGS.offlineCommand}`,
  appOwnedCore: "the Herdr app arranges this core",
  emptyCoreTitle: "No workspaces yet",
  emptyCoreOffer: (folder: string, key: string): string => `New workspace in ${folder} (${key})`,

  // Pane states & border notices
  endedCode: (code: number | null): string => `ended (${code ?? "none"})`,
  waitingNewShell: "waiting for its new shell",
  sizedByViewer: (cols: number, rows: number): string => `sized by another viewer (${cols}x${rows})`,
  waitingOffline: "waiting for herdr-core",
  waitingClosed: "stream closed",
  openingPane: "opening terminal",
  paintingPane: "loading screen",
  closingPane: "closing stream",
  failedPane: (reason: string): string => `failed: ${reason}`,
  retryHint: "retry",

  // Overlays
  helpTitle: "Keyboard Shortcuts",
  helpUnset: "unset",
  helpCloseLabel: (keys: readonly string[]): string => `close: ${keys.join(" / ")}`,
  helpParityPrefix: "not built",
  helpRefusalsTitle: "Config Diagnostics",
  helpMoreRefusals: (more: number): string => `+${more} more config diagnostics`,
  textRenameWorkspace: "Rename workspace",
  textRenameTab: "Rename tab",
  textRenamePane: "Rename pane",
  textNewTab: "New tab name",
  textPromptHint: "Enter to save · Ctrl+U to clear",
  confirmCloseWorkspace: (id: string): string => `Close workspace ${id}? [y/N]`,
  gotoTitle: "Go to",
  gotoPromptHint: "Type to filter · Enter to jump",

  // Keymap notes in help & mode bar
  notePrefixFallback: (binding: string, fallback: string): string =>
    `prefix_fallback: ${binding} cannot be typed; using ${fallback}`,
  notePrefixUnreachable: (binding: string, skipped: string): string =>
    `prefix_unreachable: ${binding} cannot be typed and all fallbacks are held (${skipped}); use menu or close terminal`,
  noteDetachFallback: (fallback: string): string =>
    `detach_fallback: detach uses ${fallback}`,
  noteDetachUnreachable: (skipped: string): string =>
    `detach_unreachable: no key can detach (${skipped}); use action detach or close terminal`,
  noteLockTaken: (holder: string): string => `lock_taken: lock key held by ${holder}`,
  noteTaken: (action: string, binding: string, holder: string): string =>
    `taken: ${action} (${binding}) held by ${holder}`,
  noteDropped: (code: string, action: string, binding: string): string =>
    `${code}: ${action} (${binding}) cannot fire`,
  noteIndexedLegacy: (entry: string): string => `indexed_legacy: [keys.indexed].${entry} is ignored`,
  noteBlankBinding: (action: string): string => `blank_binding: ${action} unbound by blank entry`,

  // Notice messages by code
  noticeText: (code: string, data: Readonly<Record<string, string | number>>): string => {
    switch (code) {
      case "ime_prefix":
        return "ime_prefix: switch to the English keyboard for prefix keys";
      case "not_built":
        return `not_built: ${data["action"] ?? "action"} is not built in this screen`;
      case "input_refused":
        return `input_refused: pane is ${data["reason"] ?? "not ready"}`;
      case "paste_refused":
        return `paste_refused: paste over limit (${data["length"] ?? 0} bytes)`;
      case "keys_unread":
        return "keys_unread: herdr config could not be read; using defaults";
      case "keys_refused":
        return `keys_refused: ${data["count"] ?? 0} key bindings refused or dropped`;
      case "unlocked":
        return "unlocked: lock key was unbound on reload";
      case "lock_unbound":
        return "lock_unbound: lock key is not bound";
      case "locked":
        return `locked: screen is locked (${data["action"] ?? ""})`;
      case "nothing_focused":
        return `nothing_focused: no target for ${data["action"] ?? "action"}`;
      case "target_gone": {
        const detail = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ");
        return `target_gone: ${detail || "target closed"}`;
      }
      default: {
        const detail = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ");
        return detail ? `${code}: ${detail}` : code;
      }
    }
  },
} as const;
