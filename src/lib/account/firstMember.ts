import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import { indexedDeviceStore } from "../relay/device.ts";
import { deviceLabel } from "../phone.ts";
import { accountDevice } from "./accountDevice.ts";
import { AddPcWaitOver, directoryEntry } from "./addThisPc.ts";
import { AccountPcError, enrollPc, planEnroll, post } from "./join.ts";
import { pcAccountServiceOf, sameSignIn, type AccountService } from "./service.ts";
import { indexedAccountStore, type AccountSession } from "./store.ts";
import { forgedOffer, offerOf } from "../relay/shellState.ts";
import { openRelayTransport } from "../relay/transport.ts";
import { PEER_STATUS_MS } from "./join.ts";

/** Deliberately not the selected PC transport: a window's bearer never goes through a relay, a machine proxy or a redirect. */
const local = (path: string, init?: RequestInit) => fetch(path, { ...init, mode: "same-origin", redirect: "error", cache: "no-store" });
export interface FirstEnrollment { readonly account: string; finish(): Promise<void> }

export async function firstMember(service: AccountService, session: AccountSession, running: () => boolean): Promise<FirstEnrollment | null> {
  if (session.service !== pcAccountServiceOf(document, window.isSecureContext)) return null;
  const account = session.account;
  const own = async () => {
    const now = await service.session();
    if (!now || !sameSignIn(session, now) || now.account !== account) throw new AddPcWaitOver("sign-in");
    if (!running()) throw new AddPcWaitOver("ended");
  };
  const label = deviceLabel(navigator.userAgent, navigator.maxTouchPoints);
  const base = "/api/account/first-member";
  const { challenge } = await (await post(local, base + "/challenge", { label })).json();
  if (typeof challenge !== "string" || !/^[0-9a-f]{32}$/.test(challenge)) throw new AccountPcError(400, "challenge_invalid");
  const response = await local("/api/relay/link");
  if (!response.ok) throw new AccountPcError(response.status, "link_unavailable");
  const offer = decodeOffer((await response.json()).url);
  if (!offer || offer.code || forgedOffer(offer)) throw new AccountPcError(400, "record_invalid");
  const key = await indexedAccountStore.key();
  const device = { ...accountDevice(offer, key), label, account };
  const serverId = offer.server_id;
  const id = accountDeviceId(serverId, key.public_spki);
  const record = await signAccountRecord({ v: 1, kind: "link", account, key: key.public_spki, signer: key.public_spki, old_key: key.public_spki,
    server_id: serverId, device_id: id, issued_at: new Date().toISOString(), id: challenge }, key.private_key);
  await own();
  // Same transaction as leaveAccount's snapshot: a concurrent leave names an in-flight first link,
  // and a leave that got there first sends no claim.
  const link = newRecordId();
  let reserved = false;
  await indexedAccountStore.updateMany(["session", "leaving", "linking"], current => {
    reserved = current.session !== undefined && sameSignIn(current.session, session) && !Object.values(current.leaving ?? {}).includes(key.public_spki);
    return reserved ? { ...current, linking: { ...current.linking, [link]: serverId } } : current;
  });
  if (!reserved) throw new AddPcWaitOver("sign-in");
  const admitted = await post(local, base, { account, record, token: session.access_token }).finally(() =>
    indexedAccountStore.update("linking", current => {
      const { [link]: _ended, ...rest } = current ?? {};
      return Object.keys(rest).length ? rest : undefined;
    }));
  const grant = admitted.headers.get("x-ovis-first-enroll");
  const row = (await admitted.json()).device;
  const directory = service.forSignIn(session);
  return { account, async finish() {
    await own();
    if (!grant || row?.id !== id || row.role !== "drive") throw new AccountPcError(403, "account_required");
    // Keep the pairing and enrollment plan before touching the directory: the usual member can resume them over AUTH.
    await indexedDeviceStore.update(serverId, current => {
      if (current && current.server_public_key !== offer.server_public_key) throw new AddPcWaitOver("pc");
      return device;
    });
    if (!(await indexedAccountStore.get("enrolls"))?.[serverId]) await planEnroll(indexedAccountStore, serverId, account);
    await directory.putPc(serverId, directoryEntry(offer));
    const others = (await directory.listPcs()).filter(pc => pc.server_id !== serverId);
    const paired = (await indexedDeviceStore.list()).filter(pc => pc.server_id !== serverId && pc.device_id !== null && pc.account === account && pc.public_spki === key.public_spki);
    const peers = paired.map(peer => ({ serverId: peer.server_id, fetch: async (path: string, init?: RequestInit) => {
      await own();
      const signal = AbortSignal.timeout(PEER_STATUS_MS);
      const transport = await openRelayTransport(offerOf(peer), { signal });
      try { return await transport.fetch(path, { ...init, signal }).then(async res => new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers })); }
      finally { transport.close(); }
    } }));
    const result = await enrollPc({ store: indexedAccountStore, account, serverId, listed: others.length, others: peers,
      pc: { ...offer, name: directoryEntry(offer).label }, fetch: async (path, init) => {
      await own();
      if (path !== "/api/account/enroll") throw new AccountPcError(403, "account_required");
      const headers = new Headers(init?.headers);
      headers.set("x-ovis-first-enroll", grant);
      return local(path, { ...init, headers });
    } });
    if (!result.finished) throw new AccountPcError(409, "enrolling");
  } };
}
