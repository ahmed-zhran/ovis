/**
 * The size rules of a pane, as values: pure, with no clock and no core. The pane machine (pane.ts)
 * holds one PaneSize per pane and asks these functions what to advertise and when to attach again.
 *
 * The screen never claims a terminal's size by itself. Every attach is a resumed plain viewer, so
 * herdr-core's own rule decides: alone, the terminal takes what this viewer advertises; beside a
 * viewer that drives it, theirs stays. Three sizes are kept apart:
 * - `wanted`: the pane's rectangle on this screen;
 * - `actual`: the terminal's real size, from the attach reply and then from `size` events. The pane's
 *   emulator always has this one;
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
 * - `foreignAt`, another viewer changed the size: set while the terminal's size differs from the
 *   rectangle after a `size` event on the attach in use. It ends when the repaint left, when the
 *   user's input took the terminal, when the sizes are equal again (a later event, or a changed
 *   rectangle), and with the attach itself. The new attach advertises the terminal's current size,
 *   so it only repaints and can change nothing.
 * Both wait REATTACH_SETTLE_MS after the last such change; when both wait, the first kind is made.
 * A wait that outlived its cause would be counted again by a later attach: an attach with the
 * rectangle that nobody asked for, which between two idle screens takes the terminal back.
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
  /** when a `size` event on the attach in use last left `actual` different from `wanted`, while it still is; else null */
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
 * The core said the terminal's size. `onChannel`: the event came on an attach whose reply is in, so
 * the bytes on that stream may be laid out for another grid than the pane wanted; before the reply
 * the coming first paint is drawn for the reply's size anyway. An event that brings the terminal to
 * the rectangle ends the wait an earlier one began.
 */
export function sizeTold(size: PaneSize, actual: Size, now: number, onChannel: boolean): PaneSize {
  return { ...size, actual, foreignAt: sameSize(actual, size.wanted) ? null : onChannel ? now : size.foreignAt };
}

/**
 * What the next attach advertises: the terminal's current size when it is a repaint after another
 * viewer's resize and no change of the rectangle waits, else the rectangle.
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
