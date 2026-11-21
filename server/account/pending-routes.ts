/**
 * /api/devices/pending (docs/account.md, "Confirmed on this PC"): the devices waiting for this PC's screen, for whoever
 * may drive this PC, and a decline of one, which only narrows. An approval is a confirm of its key on this PC's screen:
 * the confirm page or the desktop app, or this PC's own window (`approve`, refused to every other window).
 */
import type { Access } from "../access.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { approveKeyOnOwnWindow, type LocalConfirms } from "./local-confirm.ts";
import type { PendingRedemptions } from "./pending.ts";

/** What the routes act on, and who asks: `ownWindow` is dispatch.ts's judgement of the request, never the client's. */
export interface PendingContext { pending: PendingRedemptions; confirms: LocalConfirms | undefined; access: Access; ownWindow: boolean }

export async function handlePendingRequest(request: Request, pathname: string, { pending, confirms, access, ownWindow }: PendingContext): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  setRequestRoute(pathname === "/api/devices/pending" ? pathname : "/api/devices/pending/*");
  if (access.level !== "full" || access.role !== "drive") return fail("read_only", "this device can only watch", 403);
  if (pathname === "/api/devices/pending") {
    if (request.method !== "GET") return fail("method_not_allowed", "use GET", 405);
    return reply({ pending: pending.view() });
  }
  if (pathname !== "/api/devices/pending/decline" && pathname !== "/api/devices/pending/approve") return fail("not_found", "no such route", 404);
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  const approving = pathname === "/api/devices/pending/approve";
  // told before anything else: no other window learns whether such a device waits
  if (approving && !ownWindow) return fail("local_required", "Approve this device on this PC's own screen.", 403);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", approving ? "Approve from this app" : "Decline from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (typeof body.id !== "string" || !/^[0-9a-f]{32}$/.test(body.id)) return fail("request_invalid", "Name the waiting device by its id", 400);
  if (!approving) {
    pending.decline(body.id);
    return reply({ pending: pending.view() });
  }
  if (confirms === undefined || !approveKeyOnOwnWindow(confirms, body.id)) return fail("pending_gone", "That device is no longer waiting.", 404);
  return reply({ ok: true });
}
