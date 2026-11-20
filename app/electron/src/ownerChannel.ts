/**
 * The desktop-owner channel (device table R8, T68, T72; server/account/local-confirm.ts): the server lists the
 * actions waiting for the person at this PC's screen, one JSON object per line, after every change; the app
 * answers `{approve: id}` or `{decline: id}`, once, and only for an action the latest list still holds, so an
 * answer can neither be replayed onto another action nor outlive the PC taking one back.
 */
import type { Readable } from "node:stream";

/** The descriptor the server's `serve` gets the channel on (`--desktop-owner-fd`), the first after stderr. */
export const DESKTOP_OWNER_FD = 3;

export interface OwnerShown { readonly title: string; readonly lines: readonly string[]; readonly fingerprint?: string }
export interface OwnerPending { readonly id: string; readonly action: { readonly kind: string }; readonly shown: OwnerShown }

function pendingOf(line: string): OwnerPending[] | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { pending?: unknown }).pending)) return null;
  const pending: OwnerPending[] = [];
  for (const item of (value as { pending: unknown[] }).pending) {
    if (typeof item !== "object" || item === null) return null;
    const { id, action, shown } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof action !== "object" || action === null || typeof (action as { kind?: unknown }).kind !== "string") return null;
    if (typeof shown !== "object" || shown === null) return null;
    const { title, lines, fingerprint } = shown as Record<string, unknown>;
    if (typeof title !== "string" || !Array.isArray(lines) || !lines.every((entry) => typeof entry === "string")) return null;
    if (fingerprint !== undefined && typeof fingerprint !== "string") return null;
    pending.push(item as unknown as OwnerPending);
  }
  return pending;
}

/** The longest owner-channel line kept; a longer one is dropped whole up to its newline (R8). */
export const OWNER_LINE_MAX = 1 << 20;

export function ownerChannel(input: Readable, output: { write(line: string): boolean }, onPending: (pending: readonly OwnerPending[]) => void) {
  let listed = new Set<string>();
  let buffered = "";
  let skipping = false;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffered += chunk;
    if (skipping) {
      const end = buffered.indexOf("\n");
      if (end < 0) { buffered = ""; return; }
      buffered = buffered.slice(end + 1);
      skipping = false;
    }
    if (buffered.length > OWNER_LINE_MAX && !buffered.slice(0, OWNER_LINE_MAX + 1).includes("\n")) {
      console.error("Ovis: the server sent a desktop-owner line past the size cap");
      const end = buffered.indexOf("\n");
      if (end < 0) { buffered = ""; skipping = true; return; }
      buffered = buffered.slice(end + 1);
    }
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const pending = pendingOf(line);
      if (pending === null) {
        console.error("Ovis: the server sent a desktop-owner line that does not read");
        continue;
      }
      listed = new Set(pending.map((item) => item.id));
      onPending(pending);
    }
  });
  return {
    /** True when sent: the action is listed now and was not answered before. */
    answer(id: string, approve: boolean): boolean {
      if (!listed.delete(id)) return false;
      return output.write(`${JSON.stringify(approve ? { approve: id } : { decline: id })}\n`);
    },
  };
}
