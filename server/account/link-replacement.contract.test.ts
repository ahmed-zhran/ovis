/**
 * A link that would move the key of a row this PC's screen approved (device-row-states rows P22, T7, T11, T12, T59,
 * T72; the hub's and security-triage's S2-14 conditions), end to end through relay sessions: only an app that opts in
 * gets the replacement held for the screen, with a challenge the PC made; an old app is refused and keeps its key.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_REPLACEMENT_OPT_IN, REPLACEMENT_NEEDS_APP } from "../../shared/account-devices-api.ts";
import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { DeviceJournal } from "./device-journal.ts";
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
const replace = (session: Parameters<typeof link>[0], body: unknown) =>
  ask(session.link, "/api/account/devices/replace", { method: "POST", body });

async function replacement(made: Awaited<ReturnType<typeof pc>>) {
  const device = await approved(made), next = await phone();
  const record = await linkRecord(device.id, ACCOUNT, device.key, next);
  const answer = await link(device, record, true);
  expect(answer.status).toBe(202);
  const held = answer.body.replacement;
  if (!held || typeof held !== "object" || !("challenge" in held) || typeof held.challenge !== "string") throw new TypeError("Missing challenge");
  const signature = await signPairProof(SERVER_ID, held.challenge, next.spki, next.keys.privateKey);
  return { device, next, record, proof: { row: device.id, challenge: held.challenge, signature } };
}

function expectDrop(made: Pc, row: string, key: string, how: string) {
  expect(DeviceJournal.open(made.stateDir).entries().filter((entry) => entry.kind === "drop" && entry.row === row)).toEqual([
    expect.objectContaining({ key, how, no: null, by: "pc", account: null, label: "New phone" }),
  ]);
}

test("P22/T7: an app that does not opt in is refused replacement_needs_app, nothing changes, and its key still signs in", async () => {
  const made = await pc();
  const device = await approved(made);
  const before = rowOf(made, device.id);
  const answer = await link(device, await linkRecord(device.id, ACCOUNT, device.key, await phone()), false);
  expect([answer.status, (answer.body as { error?: { code?: string } }).error?.code]).toEqual([409, REPLACEMENT_NEEDS_APP]);
  expect(rowOf(made, device.id)).toEqual(before);
  expect((await made.status()).enrolling).toBe(false);
  expect(existsSync(join(made.stateDir, "account-enrolling.json"))).toBe(false);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expect("link" in await signIn(made, device.id, device.key)).toBe(true);
});

test("P22/T72: an app that opts in gets 202 with the PC's challenge; the key moves only on the screen's approval of that fingerprint", async () => {
  const made = await pc();
  const { device, next, proof } = await replacement(made);
  const before = rowOf(made, device.id)!;
  expect(before.relay_public_key).toBe(device.key.spki);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expect((await replace(device, proof)).status).toBe(204);
  expect((await replace(device, proof)).status).toBe(410);
  const fingerprint = await pairFingerprint(SERVER_ID, proof.challenge, next.spki);
  expect(rowOf(made, device.id)).toEqual(before);
  const asked = made.screen.open("approve_replacement");
  expect(asked?.action).toEqual({ kind: "approve_replacement", row: device.id, fingerprint });
  const moved = new Promise<void>((resolve) => made.devices.onLinked(device.id, () => resolve()));
  made.screen.approve(asked!.id);
  await bounded(moved);
  expect(rowOf(made, device.id)?.origin).toMatchObject({ from: "pc", how: "link" });
  expect(rowOf(made, device.id)!.origin!.admit_no).toBeGreaterThan(before.origin!.admit_no);
  expect("error" in await signIn(made, device.id, device.key)).toBe(true);
  expect("link" in await signIn(made, device.id, next)).toBe(true);
  expect(listKey(made)).toBeNull();
});

test("P22: a decline on the screen drops the replacement; the approved key stays and signs in", async () => {
  const made = await pc();
  const { device, next, proof } = await replacement(made);
  const before = rowOf(made, device.id);
  expect((await replace(device, proof)).status).toBe(204);
  const id = made.screen.open("approve_replacement")!.id;
  const answered = made.app.context.services.localConfirms!.answer(id);
  made.screen.decline(id);
  expect(await bounded(answered)).toBe("declined");
  expect((await replace(device, proof)).status).toBe(410);
  expectDrop(made, device.id, next.spki, "declined");
  expect(rowOf(made, device.id)).toEqual(before);
  expect("link" in await signIn(made, device.id, device.key)).toBe(true);
});

test("P22/T72: proof is accepted only from the linking session, for its row, with no body key", async () => {
  const made = await pc();
  const { device, next, proof } = await replacement(made);
  const other = await signIn(made, device.id, device.key);
  if ("error" in other) throw new Error(other.error);
  expect((await replace(other, proof)).status).toBe(403);
  expect((await replace(device, { ...proof, row: "ab".repeat(8) })).status).toBe(403);
  expect((await replace(device, { ...proof, key: next.spki })).status).toBe(400);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expect((await replace(device, proof)).status).toBe(204);
});

test("T7/T72: the link signature alone cannot authorize a stored row's replacement", async () => {
  const made = await pc();
  const { device, record, proof } = await replacement(made);
  expect((await replace(device, { ...proof, signature: record.signature })).status).toBe(403);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expect(rowOf(made, device.id)?.relay_public_key).toBe(device.key.spki);
});

test("P22/T72: a successful same-key link supersedes even a proven replacement", async () => {
  const made = await pc();
  const { device, next, proof } = await replacement(made);
  expect((await replace(device, proof)).status).toBe(204);
  expect((await link(device, await linkRecord(device.id, ACCOUNT, device.key), true)).status).toBe(200);
  expect(made.screen.open("approve_replacement")).toBeUndefined();
  expectDrop(made, device.id, next.spki, "superseded");
  expect((await replace(device, proof)).status).toBe(410);
});

test("P22/T72: the prompt survives two minutes but expires with the five-minute hold", async () => {
  const made = await pc();
  const { device, next, proof } = await replacement(made);
  expect((await replace(device, proof)).status).toBe(204);
  const id = made.screen.open("approve_replacement")!.id;
  const confirms = made.app.context.services.localConfirms!;
  const start = made.devices.pendingReplacement(device.id)!.at;
  expect(confirms.pending().find((entry) => entry.id === id)?.expiresAt).toBeCloseTo(start + 300_000, -2);
  using clock = spyOn(Date, "now");
  clock.mockReturnValue(start + 300_001);
  expect((await replace(device, proof)).status).toBe(410);
  expectDrop(made, device.id, next.spki, "expired");
});

test("P22/T72: restarting from the held state journals the loss without restoring authority", async () => {
  const made = await pc();
  const { device, next, proof } = await replacement(made);
  const restarted = await pairingPc({ prepare: (dir) => cpSync(made.stateDir, dir, { recursive: true, filter: (path) => !lstatSync(path).isSocket() }), server: { accountOpensAll: true } });
  pcs.push(restarted);
  const session = await signIn(restarted, device.id, device.key);
  if ("error" in session) throw new Error(session.error);
  expect((await replace(session, proof)).status).toBe(410);
  expectDrop(restarted, device.id, next.spki, "restart");
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

test("T59: no link sets the first device's sign-in key: plain, opted in, or a replacement the screen approved", async () => {
  const made = await pc(true, "darwin");
  const key = await phone();
  const paired = await pair(made, await made.offerCode(), key);
  if ("error" in paired) throw new Error(paired.error);
  const session = await signIn(made, paired.id, key);
  if ("error" in session) throw new Error(session.error);
  expect((await link(session, await linkRecord(paired.id, ACCOUNT, key), false)).status).toBe(200);
  expect(JSON.parse(readFileSync(join(made.stateDir, "account-pc.json"), "utf8")).binding).not.toBeNull();
  expect(listKey(made)).toBeNull();
  const again = await signIn(made, paired.id, key);
  if ("error" in again) throw new Error(again.error);
  expect((await link(again, await linkRecord(paired.id, ACCOUNT, key, await phone()), true)).status).toBe(200);
  expect(listKey(made)).toBeNull();
});
