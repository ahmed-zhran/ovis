/**
 * A link that would move the key of a row this PC's screen approved (device-row-states rows P22, T7, T11, T12, T59,
 * T72; the hub's and security-triage's S2-14 conditions), end to end through relay sessions: only an app that opts in
 * gets the replacement held for the screen, with a challenge the PC made; an old app is refused and keeps its key.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_REPLACEMENT_OPT_IN, REPLACEMENT_NEEDS_APP } from "../../shared/account-devices-api.ts";
import { pairFingerprint } from "../../shared/pair-fingerprint.ts";
import { FrameType } from "../../shared/relay-mux.ts";
import { bounded, deferred } from "../relay/test-helpers.ts";
import { ask, linkRecord, pair, pairingPc, phone, provingDevice, screenPc, SERVER_ID, signIn, type Pc } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_1";
const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(accountOpensAll = true, platform: NodeJS.Platform = "linux") {
  const made = await screenPc(accountOpensAll, platform);
  pcs.push(made);
  return made;
}

/** A device whose key this PC's screen approved: its row has origin pc, and its session is open. */
async function approved(made: Awaited<ReturnType<typeof pc>>) {
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  const admitted = deferred<void>();
  paired.link.onFrame = (frame) => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(); };
  made.screen.approve(made.screen.keyConfirm()!.id);
  await bounded(admitted.promise);
  const row = made.stored().find((stored) => stored.relay_public_key === paired.device.spki)!;
  return { key: paired.device, id: row.id, link: paired.link };
}

const link = async (session: { link: Parameters<typeof ask>[0] }, record: unknown, optIn: boolean) =>
  ask(session.link, "/api/account/link", { method: "POST", body: optIn ? { record, replacement: LINK_REPLACEMENT_OPT_IN } : { record } });
const rowOf = (made: Pc, id: string) => made.stored().find((row) => row.id === id) as { relay_public_key: string; origin?: { from: string; how: string; admit_no: number } } | undefined;
const listKey = (made: Pc) => (JSON.parse(readFileSync(join(made.stateDir, "account-pc.json"), "utf8")) as { first: { list_key: string | null } | null }).first?.list_key ?? null;

test("P22/T7: an app that does not opt in is refused replacement_needs_app, nothing changes, and its key still signs in", async () => {
  const made = await pc();
  const device = await approved(made);
  const before = rowOf(made, device.id);
  const answer = await link(device, await linkRecord(device.id, ACCOUNT, device.key, await phone()), false);
  expect([answer.status, (answer.body as { error?: { code?: string } }).error?.code]).toEqual([409, REPLACEMENT_NEEDS_APP]);
  expect(rowOf(made, device.id)).toEqual(before);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expect("link" in await signIn(made, device.id, device.key)).toBe(true);
});

test("P22/T72: an app that opts in gets 202 with the PC's challenge; the key moves only on the screen's approval of that fingerprint", async () => {
  const made = await pc();
  const device = await approved(made);
  const before = rowOf(made, device.id)!;
  const next = await phone();
  const answer = await link(device, await linkRecord(device.id, ACCOUNT, device.key, next), true);
  expect(answer.status).toBe(202);
  const held = (answer.body as { replacement: { challenge: string; fingerprint: string } }).replacement;
  expect(held.fingerprint).toBe(await pairFingerprint(SERVER_ID, held.challenge, next.spki));
  expect(rowOf(made, device.id)).toEqual(before);
  const asked = made.screen.open("approve_replacement");
  expect(asked?.action).toEqual({ kind: "approve_replacement", row: device.id, fingerprint: held.fingerprint });
  made.screen.approve(asked!.id);
  await bounded((async () => { while (rowOf(made, device.id)?.relay_public_key !== next.spki) await new Promise((resolve) => setImmediate(resolve)); })());
  expect(rowOf(made, device.id)?.origin).toMatchObject({ from: "pc", how: "link" });
  expect(rowOf(made, device.id)!.origin!.admit_no).toBeGreaterThan(before.origin!.admit_no);
  expect("error" in await signIn(made, device.id, device.key)).toBe(true);
  expect("link" in await signIn(made, device.id, next)).toBe(true);
  expect(listKey(made)).toBeNull();
});

test("P22: a decline on the screen drops the replacement; the approved key stays and signs in", async () => {
  const made = await pc();
  const device = await approved(made);
  const before = rowOf(made, device.id);
  expect((await link(device, await linkRecord(device.id, ACCOUNT, device.key, await phone()), true)).status).toBe(202);
  made.screen.decline(made.screen.open("approve_replacement")!.id);
  await bounded((async () => { while (made.app.context.services.devices.pendingReplacement(device.id) !== null) await new Promise((resolve) => setImmediate(resolve)); })());
  expect(rowOf(made, device.id)).toEqual(before);
  expect("link" in await signIn(made, device.id, device.key)).toBe(true);
});

test("T7/T11: a row the screen did not approve links as today, opt-in or not: the key moves at once, with no screen ask", async () => {
  const made = await pc(true, "darwin");
  const key = await phone();
  const paired = await pair(made, await made.offerCode(), key);
  if ("error" in paired) throw new Error(paired.error);
  const session = await signIn(made, paired.id, key);
  if ("error" in session) throw new Error(session.error);
  const next = await phone();
  expect((await link(session, await linkRecord(paired.id, ACCOUNT, key, next), true)).status).toBe(200);
  expect(rowOf(made, paired.id)?.relay_public_key).toBe(next.spki);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expect(listKey(made)).toBeNull();
});

test("flag off: a link without the opt-in is answered as on main, never replacement_needs_app", async () => {
  const made = await pairingPc({ server: { accountOpensAll: false } });
  pcs.push(made);
  const key = await phone();
  const paired = await pair(made, await made.offerCode(), key);
  if ("error" in paired) throw new Error(paired.error);
  const session = await signIn(made, paired.id, key);
  if ("error" in session) throw new Error(session.error);
  const next = await phone();
  expect((await link(session, await linkRecord(paired.id, ACCOUNT, key, next), false)).status).toBe(200);
  expect(rowOf(made, paired.id)?.relay_public_key).toBe(next.spki);
});
