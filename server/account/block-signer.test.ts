import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord, type BlockRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { bounded, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { AccountHolds } from "./holds.ts";
import { AccountMailbox } from "./mailbox.ts";
import { PcAccountState } from "./pc-binding.ts";
import { applyAccountRecords } from "./records.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function open(dir: string) {
  const log = SafetyLog.open(dir);
  return { log, devices: new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) }) };
}
function pc() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-block-signer-"));
  dirs.push(dir);
  return { dir, ...open(dir) };
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

const block = (target: string, by: Key): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 9, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
const lift = (blockId: string, by: Key): Promise<SafetyRecord> =>
  signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: blockId, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString() }, by.keys.privateKey);

const blocksInForce = (log: SafetyLog) => log.state().blocks.map((entry) => entry.record.id);

describe("a block holds only while its signer is a member here (P16, P19, T73)", () => {
  test("T17: only an authorized waiting remove can hold a key and a full queue cannot gate the list", async () => {
    const { dir, devices } = pc();
    await member(devices);
    const [k, own, stranger] = [await key(), await key(), await key()];
    const removal = (target: string, signer: Key) => signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: target, issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.keys.privateKey);
    // a remove of another key from a signer that is no member here, and one a key signed of itself, both waiting
    writeFileSync(join(dir, "account-pending.json"), JSON.stringify([await removal(k.spki, stranger), await removal(own.spki, own)]), { mode: 0o600 });
    const holds = new AccountHolds({ heldPath: join(dir, "account-held.json") });
    const mailbox = new AccountMailbox({ devices, identity: () => undefined, service: "https://account.test", pendingPath: join(dir, "account-pending.json"), holds });
    expect(mailbox.gates().held(k.spki)).toBe(false);
    expect(mailbox.gates().held(own.spki)).toBe(true);
    // a queue that overflowed holds every add back, but never the account's list
    holds.overflow();
    expect(mailbox.gates().held(k.spki)).toBe(true);
    expect(mailbox.listHeld(k.spki)).toBe(false);
    expect(mailbox.listHeld(own.spki)).toBe(true);
  });

  test("T18: loss of signer authority discards its waiting removes", async () => {
    const { dir, devices } = pc();
    const signer = await member(devices);
    const k = await key();
    const removal = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: k.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.keys.privateKey);
    writeFileSync(join(dir, "account-pending.json"), JSON.stringify([removal]), { mode: 0o600 });
    const mailbox = new AccountMailbox({ devices, identity: () => undefined, service: "https://account.test", pendingPath: join(dir, "account-pending.json") });
    expect(mailbox.listHeld(k.spki)).toBe(true);
    devices.revoke(signer.id);
    expect(mailbox.listHeld(k.spki)).toBe(false);
    expect(mailbox.waitingRemoveKeys()).toEqual([]);
  });

  test("T51: a queued block rechecks the signer at apply and writes nothing if it was removed", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const later = await key();
    // the target is not here yet: the block waits and ends nobody
    const record = await block(later.spki, signer);
    expect(await devices.applyBlock(record, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
    expect(log.waitingBlocks().map((waiting) => waiting.record.id)).toEqual([record.id]);
    expect(log.entries()).toHaveLength(0);
    // its signer is removed here before the target appears: applying the queue writes nothing and empties it
    devices.revoke(signer.id);
    const target = devices.pairRelayApproved("Later", later.spki, { path: "code" });
    expect(log.state().blocks).toHaveLength(0);
    expect(log.waitingBlocks()).toHaveLength(0);
    expect(target).not.toBeNull();
    expect(devices.hasKey(later.spki)).toBe(true);
  });

  test.each(["relay pairing", "account add", "startup"] as const)("T51: %s applies a waiting block before relay sign-in", async (path) => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-waiting-relay-"));
    dirs.push(stateDir);
    const target = await key();
    const id = accountDeviceId(SERVER, target.spki);
    let queued: BlockRecord | undefined;
    if (path === "startup") {
      const { devices, log } = open(stateDir);
      const signer = await member(devices);
      expect(devices.pairRelayApproved("Joining", target.spki, { path: "code", id })).not.toBeNull();
      queued = await block(target.spki, signer);
      // P19: startup can find the row and the waiting block together after a merge.
      expect(log.wait({ record: queued, got: "mailbox", signer_removed: false })).toBe(true);
    }
    const fixture = relayFixture(false, { stateDir, accountOpensAll: true });
    fixtures.push(fixture);
    const { devices, safetyLog } = fixture.app.context.services;
    if (path !== "startup") {
      const signer = await relayDevice(fixture);
      devices.linkAccountKey(signer.id, signer.publicKey, signer.publicKey, ACCOUNT);
      queued = await block(target.spki, { keys: signer.keys, spki: signer.publicKey });
      expect(await devices.applyBlock(queued, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
      if (path === "account add") {
        const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key: target.spki, label: "Joining", role: "drive", id: newRecordId(), issued_at: new Date().toISOString(), signer: signer.publicKey }, signer.keys.privateKey);
        await applyAccountRecords(devices, [add], SERVER);
      }
    }
    const link = await relayConnection(fixture);
    const signIn = path === "relay pairing"
      ? link.pair(devices.startPairing().code, target.spki)
      : link.auth({ id, keys: target.keys, publicKey: target.spki });
    expect(await bounded(Promise.race([link.serverError, signIn.then(() => "auth_ok")]))).toBe("auth_failed");
    if (!queued || !safetyLog) throw new Error("Waiting block fixture did not initialize");
    expect(safetyLog.receipt(queued.id)).toMatchObject({ outcome: "applied" });
    expect(safetyLog.waitingBlocks()).toEqual([]);
  });

  test("T73, S29: a blocked start lifts nothing at load, though a block's signer is no member here", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    // the signer's row goes without the store, as a merge from another folder would take it
    const registry = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices: { id: string }[] };
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ ...registry, devices: registry.devices.filter((d) => d.id !== signer.id) }), { mode: 0o600 });
    const before = readFileSync(join(dir, "account-log.json"), "utf8");
    const reopened = SafetyLog.open(dir);
    new DeviceStore(dir, "the order is damaged", null, { safety: reopened, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, reopened), journal: DeviceJournal.open(dir, () => reopened.ensureFile()) });
    expect(readFileSync(join(dir, "account-log.json"), "utf8")).toBe(before);
    expect(blocksInForce(log)).toEqual([record.id]);
  });

  test("T73: local signer removal appends durable lifts while markers, local Revokes and locks survive", async () => {
    const { dir, devices, log } = pc();
    const [signer, target, revoked] = [await member(devices), await member(devices), await member(devices)];
    devices.revoke(revoked.id);
    const lock = { v: 1, id: pcRecordId(), kind: "lock", account: ACCOUNT, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" } as SafetyRecord;
    log.append({ record: lock, got: "pc" });
    const record = await block(target.spki, signer);
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    expect(blocksInForce(log)).toEqual([record.id]);
    devices.revoke(signer.id);
    // the block and its freeze end by a lift the PC wrote; the target stays removed, the Revoke and the lock stand
    expect(blocksInForce(log)).toEqual([]);
    expect(log.entries().some((entry) => entry.record.kind === "lift" && entry.record.target === record.id && entry.record.signer === "pc")).toBe(true);
    expect(devices.removedByAccount(target.spki)).toBe(true);
    expect(devices.isTombstoned(revoked.spki)).toBe(true);
    expect(log.state().locked).toBe(true);
    // durable: a restart keeps it lifted
    expect(blocksInForce(open(dir).log)).toEqual([]);
  });

  test("T73, seam for S2-27: every lift is heard with its target key and its cause, once it is on disk", async () => {
    const { devices, log } = pc();
    const heard: [string, string][] = [];
    devices.onLifted((target, cause) => heard.push([target, cause]));
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    devices.revoke(signer.id);
    expect(heard).toEqual([[target.spki, "orphan"]]);
    expect(log.entries().some((entry) => entry.record.kind === "lift" && entry.record.target === record.id)).toBe(true);
  });

  test("T73: later signer reentry never changes those local endings", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    devices.revoke(signer.id);
    // the signer pairs here again: what was lifted stays lifted, and the target stays out
    devices.pairRelay(devices.startPairing().code, "Back", signer.spki);
    expect(blocksInForce(log)).toEqual([]);
    expect(devices.removedByAccount(target.spki)).toBe(true);
    // a start re-reads the same endings; nothing of the service takes part
    const reopened = open(dir);
    expect(blocksInForce(reopened.log)).toEqual([]);
    expect(reopened.devices.removedByAccount(target.spki)).toBe(true);
  });

  test("T73: startup preserves a block when its signer row is missing without a removal", async () => {
    const { dir, devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    await devices.applyBlock(record, "handed");
    const rows = JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) as { devices: { id: string }[] };
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ ...rows, devices: rows.devices.filter((row) => row.id !== signer.id) }), { mode: 0o600 });
    const reopened = open(dir);
    expect(blocksInForce(reopened.log)).toEqual([record.id]);
    expect(reopened.log.state().freezes.map((entry) => entry.record.id)).toEqual([record.id]);
    expect(reopened.log.entries()).toEqual(log.entries());
  });

  test("T73: a signed account removal lifts only blocks of the key removed here", async () => {
    const { devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const local = await block(target.spki, signer);
    expect(await devices.applyBlock(local, "handed")).toMatchObject({ outcome: "applied" });
    const service = await block((await key()).spki, await key());
    // the service block freezes nobody here: every row joined before its cutoff (S2-09 refuses a freeze of unknown age)
    expect(log.append({ record: service, got: "snapshot", asof: { signer_no: null, target_no: 1000, after: 1000, joined: 1000, signer_removed: false } }).outcome).toBe("applied");
    const removal = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: signer.spki, id: newRecordId(), issued_at: new Date().toISOString(), signer: signer.spki }, signer.keys.privateKey);
    expect(await applyAccountRecords(devices, [removal], SERVER)).toEqual([{ id: removal.id, outcome: "applied" }]);
    expect(blocksInForce(log)).toEqual([service.id]);
  });

  test("P23: Revoke all ends no standing block or freeze and emits no lift", async () => {
    const { devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    const record = await block(target.spki, signer);
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    const heard: string[] = [];
    devices.onLifted((key) => heard.push(key));
    expect(devices.revokeAll()).toContain(signer.id);
    expect([blocksInForce(log), log.state().freezes.map((entry) => entry.record.id), heard]).toEqual([[record.id], [record.id], []]);
  });

  test("P23: a device lift counts only from a signer older here than the blocked key", async () => {
    const { devices } = pc();
    const [older, target, newer] = [await member(devices), await member(devices), await member(devices)];
    const record = await block(target.spki, older);
    await devices.applyBlock(record, "handed");
    expect(await devices.liftAuthority(await lift(record.id, older))).toBe(true);
    expect(await devices.liftAuthority(await lift(record.id, newer))).toBe(false);
    expect(await devices.liftAuthority(await lift(record.id, await key()))).toBe(false);
    const forged = { ...(await lift(record.id, older)), signature: (await lift(record.id, newer)).signature };
    expect(await devices.liftAuthority(forged)).toBe(false);
    // a signer admitted after the block came is late (T52): its row is newer than the blocked key, so it lifts nothing
    const late = await key();
    const lateRow = devices.pairRelay(devices.startPairing().code, "Late", late.spki, Date.now(), () => true);
    expect(lateRow).toBeNull();
    expect(await devices.liftAuthority(await lift(record.id, late))).toBe(false);
  });

  test("P23: a lift gives no authority when this PC has no admission number for its signer or its target", async () => {
    const { devices, log } = pc();
    const [signer, target] = [await member(devices), await member(devices)];
    // a block whose target has no number here (joined unknown): no lift ends it
    const unknownTarget = await block(target.spki, signer);
    log.append({ record: unknownTarget, got: "handed", asof: { signer_no: null, target_no: null, after: null, joined: null, signer_removed: false } });
    expect(await devices.liftAuthority(await lift(unknownTarget.id, signer))).toBe(false);
    // a signer whose row has no origin here, however old its row is
    const other = pc();
    const [s2, t2] = [await member(other.devices), await member(other.devices)];
    const record = await block(t2.spki, s2);
    await other.devices.applyBlock(record, "handed");
    (other.devices as unknown as { devices: { id: string; origin?: unknown }[] }).devices.find((row) => row.id === s2.id)!.origin = undefined;
    expect(await other.devices.liftAuthority(await lift(record.id, s2))).toBe(false);
  });

  test("P23: a lift from a key with no member row here, of a block whose target has no number here, lifts nothing", async () => {
    const { devices, log } = pc();
    const [stranger, target] = [await key(), await key()];
    const record = await block(target.spki, stranger);
    log.append({ record, got: "handed", asof: { signer_no: null, target_no: null, after: null, joined: null, signer_removed: false } });
    expect(await devices.liftAuthority(await lift(record.id, stranger))).toBe(false);
  });
});

