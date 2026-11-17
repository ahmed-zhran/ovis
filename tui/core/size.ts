/**
 * The size rules of a pane, as values: pure, with no clock and no core. The pane machine (pane.ts)
 * holds one PaneSize per pane and asks these functions what to advertise and when to attach again.
 *
 * The screen never claims a terminal's size by itself. Every attach is a resumed plain viewer, so
 * herdr-core's own rule decides: alone, the terminal takes what this viewer advertises; beside a
 * viewer that drives it, theirs stays. Three sizes are kept apart:
 * - `wanted`: the pane's rectangle on this screen;
 * - `actual`: the terminal's size as the attach in use was told it: by its reply, then by the `size`
 *   events that came on it. The pane's emulator has this one. A `size` event that comes while no attach
 *   is in use is not taken: the next reply names the size, and until then `actual` stays the grid of
 *   the picture the pane still shows;
 * - `advertised`: what the attach in use last told the core, by its attach or by a RESIZE; null when
 *   no attach is in use. The core uses it the moment this viewer becomes the active one, so it says
 *   what the user's next input would set, not who owns the size. Equal sizes are never read as
 *   ownership.
 *
 * Only the user's own input sends a RESIZE (the take, in pane.ts). Everything else that leaves
 * `advertised` or the picture behind is repaired by attaching again, for one of two causes, each a
 * wait that exists only as long as what it describes:
 * - `ownAt`, this screen's rectangle changed: set while the attach in use advertises another size
 *   than the rectangle. It ends when the core was told (an attach left, or the take sent RESIZE),
 *   when the rectangle came back to what the channel advertises, and with the attach itself. The new
 *   attach advertises the rectangle;
 * - `foreignAt`, another viewer changed the size: set after a `size` event on the attach in use, while
 *   the terminal's size is neither the rectangle nor what that attach advertises. It ends when the
 *   repaint left, when the user's input took the terminal, when the terminal has one of those two
 *   sizes again (a later event, or a changed rectangle), and with the attach itself. The new attach
 *   advertises the size the terminal had when the repaint was decided, so it only repaints.
 * Both wait REATTACH_SETTLE_MS after the last such change; when both wait, the first kind is made.
 * A wait that outlived its cause would be counted again by a later attach: an attach with the
 * rectangle that nobody asked for, which between two idle screens takes the terminal back.
 *
 * A repaint never changes the terminal's size, and one that has nothing to repaint is not made:
 * - when another viewer leaves, the core hands the terminal to a viewer that stays, at the size its
 *   attach advertises. For that viewer's pane the emulator already has that grid: no repaint is owed;
 * - every new attach needs a CLOSE first, and when this screen is the terminal's only viewer that
 *   CLOSE leaves the terminal with nobody: the core runs it at its own size for such a terminal
 *   (200x120) until the attach arrives. Nobody chose that size. It is told in a `size` event while no
 *   attach is in use, so it never becomes `actual`: the repaint advertises the size the terminal had
 *   when it was decided, and a lone viewer's resumed attach gets what it advertises (both measured on
 *   hc 0.1.17 and 0.1.18, core.fake.live.test.ts "k1"), so the terminal is back where it was.
 * So "alone, the terminal takes the pane's rectangle" holds at every attach that carries the rectangle
 * (the first, and each one after a change of the rectangle) and at the user's next input. In between
 * a pane can be alone at another size in one way only: it repainted at the size another viewer chose,
 * and that viewer left. It is then drawn clipped at that size until the user types into it.
 */

import { REATTACH_SETTLE_MS } from "../model/deadlines.ts";

export interface Size { cols: number; rows: number }

export const sameSize = (a: Size | null, b: Size | null): boolean => a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;

export interface PaneSize {
  readonly wanted: Size;
  readonly actual: Size | null;
  readonly advertised: Size | null;
  /** when the rectangle last changed, while the attach in use advertises another size; else null */
  readonly ownAt: number | null;
  /** when a `size` event on the attach in use last left `actual` neither `wanted` nor `advertised`, while it still is; else null */
  readonly foreignAt: number | null;
}

export function newPaneSize(wanted: Size): PaneSize {
  return { wanted, actual: null, advertised: null, ownAt: null, foreignAt: null };
}

/** This screen gave the pane another rectangle (a host resize, a layout change); the same rectangle changes nothing. */
export function rectangleChanged(size: PaneSize, wanted: Size, now: number): PaneSize {
  if (sameSize(size.wanted, wanted)) return size;
  return {
    ...size,
    wanted,
    // nothing waits when the channel advertises this rectangle already (it came back), or when no attach is in use (the next one carries it)
    ownAt: size.advertised !== null && !sameSize(wanted, size.advertised) ? now : null,
    // a rectangle that is the terminal's own size owes no repaint
    foreignAt: sameSize(size.actual, wanted) ? null : size.foreignAt,
  };
}

/**
 * The core said the terminal's size on the attach in use: the bytes on that stream may now be laid
 * out for another grid than the one its first paint was drawn for, which a repaint puts right. None
 * is owed when the terminal comes to the rectangle, or to the size this attach itself advertises
 * (another viewer left and the core fell back to it): either ends the wait an earlier event began.
 */
export function sizeTold(size: PaneSize, actual: Size, now: number): PaneSize {
  const settled = sameSize(actual, size.wanted) || sameSize(actual, size.advertised);
  return { ...size, actual, foreignAt: settled ? null : now };
}

/**
 * What the next attach advertises: the rectangle, or, when it is a repaint after another viewer's
 * resize and no change of the rectangle waits, the size the terminal had when the repaint was decided
 * (`actual`, which nothing changes between the CLOSE of the attach before and this one).
 */
export function attachSize(size: PaneSize): Size {
  return size.ownAt === null && size.foreignAt !== null && size.actual ? size.actual : size.wanted;
}

/** An attach left, advertising `advertised`: whatever waited was for it, and its reply alone will make nothing wait. */
export function attachSent(size: PaneSize, advertised: Size): PaneSize {
  return { ...size, advertised, ownAt: null, foreignAt: null };
}

/** The attach reply: the terminal's size once that attach was applied. It never schedules a new attach. */
export function replied(size: PaneSize, actual: Size): PaneSize {
  return { ...size, actual };
}

/**
 * The user's input left on a channel that advertises the rectangle (the take sent RESIZE first where
 * it did not): the core was told, and this viewer is now the active one, so the core sets the
 * terminal to the rectangle. Both waits end at once, not only when the `size` event confirms it: a
 * repaint fired in between would read the old size and hand the terminal back.
 */
export function took(size: PaneSize): PaneSize {
  return { ...size, advertised: size.wanted, ownAt: null, foreignAt: null };
}

/**
 * The attach in use is over for another reason than the pane's own new attach (its line ended, its
 * program ended or lost its shell, the pane left the tab or failed): nothing is advertised any more,
 * and what waited for that attach waits no longer. The next attach starts from the rectangle.
 */
export function detached(size: PaneSize): PaneSize {
  return { ...size, advertised: null, ownAt: null, foreignAt: null };
}

/** When the pane must attach again, or null when nothing waits. `attachSize` says what that attach advertises. */
export function reattachDue(size: PaneSize): number | null {
  if (size.ownAt !== null) return size.ownAt + REATTACH_SETTLE_MS;
  if (size.foreignAt !== null) return size.foreignAt + REATTACH_SETTLE_MS;
  return null;
}

/** The real grid's size when another viewer sized the terminal (the pane is then drawn clipped, with that size in its notice), else null. */
export function sizedBy(size: PaneSize): Size | null {
  return size.actual !== null && !sameSize(size.actual, size.wanted) ? size.actual : null;
}

/**
 * The first row of the real grid a clipped pane draws: the part that holds the cursor, as far down as
 * the grid goes; columns are drawn from 0. The mouse is mapped through the same offset.
 */
export function clipTop(cursorRow: number, actualRows: number, shownRows: number): number {
  return Math.max(0, Math.min(cursorRow - shownRows + 1, actualRows - shownRows));
}
