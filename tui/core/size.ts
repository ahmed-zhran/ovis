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
 * - `advertised`: what this channel last told the core, by its attach or by a RESIZE. The core uses
 *   it the moment this viewer becomes the active one, so it says what the user's next input would
 *   set, not who owns the size. Equal sizes are never read as ownership.
 *
 * Only the user's own input sends a RESIZE (the take, in pane.ts). Everything else that leaves
 * `advertised` or the picture behind is repaired by attaching again, for one of two causes:
 * - this screen's rectangle changed: the new attach advertises the new rectangle;
 * - another viewer changed the size: the new attach advertises the terminal's current size, so it
 *   only repaints and can change nothing.
 * Both wait REATTACH_SETTLE_MS after the last such change; when both wait, the first kind is made.
 */

import { REATTACH_SETTLE_MS } from "../model/deadlines.ts";

export interface Size { cols: number; rows: number }

export const sameSize = (a: Size | null, b: Size | null): boolean => a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;

export interface PaneSize {
  readonly wanted: Size;
  readonly actual: Size | null;
  readonly advertised: Size | null;
  /** when the rectangle last changed; it counts only while `advertised` differs from `wanted` */
  readonly ownAt: number | null;
  /** when a `size` event on the attach in use last left `actual` different from `wanted` */
  readonly foreignAt: number | null;
}

export function newPaneSize(wanted: Size): PaneSize {
  return { wanted, actual: null, advertised: null, ownAt: null, foreignAt: null };
}

/** This screen gave the pane another rectangle (a host resize, a layout change); the same rectangle changes nothing. */
export function rectangleChanged(size: PaneSize, wanted: Size, now: number): PaneSize {
  return sameSize(size.wanted, wanted) ? size : { ...size, wanted, ownAt: now };
}

/**
 * The core said the terminal's size. `onChannel`: the event came on an attach whose reply is in, so
 * the bytes on that stream may be laid out for another grid than the pane wanted; before the reply
 * the coming first paint is drawn for the reply's size anyway.
 */
export function sizeTold(size: PaneSize, actual: Size, now: number, onChannel: boolean): PaneSize {
  return { ...size, actual, foreignAt: onChannel && !sameSize(actual, size.wanted) ? now : size.foreignAt };
}

/** Whether a change of the rectangle still waits to be told to the core. */
const ownWaits = (size: PaneSize): boolean => size.ownAt !== null && size.advertised !== null && !sameSize(size.wanted, size.advertised);

/**
 * What the next attach advertises: the rectangle, or, for a repaint after another viewer's resize
 * (`repaint`) with no change of the rectangle waiting, the terminal's current size.
 */
export function attachSize(size: PaneSize, repaint: boolean): Size {
  return repaint && !ownWaits(size) && size.actual ? size.actual : size.wanted;
}

/** An attach left, advertising `advertised`: nothing waits any more, and its reply alone will make nothing wait. */
export function attachSent(size: PaneSize, advertised: Size): PaneSize {
  return { ...size, advertised, ownAt: sameSize(advertised, size.wanted) ? null : size.ownAt, foreignAt: null };
}

/** The attach reply: the terminal's size once that attach was applied. It never schedules a new attach. */
export function replied(size: PaneSize, actual: Size): PaneSize {
  return { ...size, actual };
}

/**
 * The user's input left on a channel that advertises the rectangle (the take sent RESIZE first where
 * it did not): this viewer is now the active one, so the core sets the terminal to the rectangle. A
 * repaint that waited for another viewer's resize is off at once, not only when the `size` event
 * confirms it: fired in between, it would read the old size and hand the terminal back.
 */
export function took(size: PaneSize): PaneSize {
  return { ...size, advertised: size.wanted, foreignAt: null };
}

/**
 * When the pane must attach again, and whether that attach only repaints. Null when nothing waits: an
 * own change the take already told the core, or a `size` event that a later one undid, waits no more.
 */
export function reattachDue(size: PaneSize): { at: number; repaint: boolean } | null {
  if (ownWaits(size)) return { at: size.ownAt! + REATTACH_SETTLE_MS, repaint: false };
  if (size.foreignAt !== null && size.actual !== null && !sameSize(size.actual, size.wanted)) return { at: size.foreignAt + REATTACH_SETTLE_MS, repaint: true };
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
