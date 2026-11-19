import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord, type BlockRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { AccountHolds } from "./holds.ts";
import { AccountMailbox } from "./mailbox.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function open(dir: string) {
  const log = SafetyLog.open(dir);
  return { log, devices: new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir) }) };
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
    const target = devices.pairRelayApproved("Later", later.spki, { path: "account", addedBy: signer.id })!;
    devices.revoke(signer.id);
    expect(await devices.applyWaitingBlocks()).toEqual([]);
    expect(log.state().blocks).toHaveLength(0);
    expect(log.waitingBlocks()).toHaveLength(0);
    expect(devices.has(target.device.id)).toBe(true);

    // with its signer still a member, the queued block applies once its target is here
    const fresh = pc();
    const keeper = await member(fresh.devices);
    const other = await key();
    const queued = await block(other.spki, keeper);
    await fresh.devices.applyBlock(queued, "mailbox");
    const row = fresh.devices.pairRelayApproved("Other", other.spki, { path: "account", addedBy: keeper.id })!;
    expect((await fresh.devices.applyWaitingBlocks()).map((receipt) => receipt.outcome)).toEqual(["applied"]);
    expect(fresh.devices.has(row.device.id)).toBe(false);
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

  test("T73: service-only removal or later signer reentry never changes those local endings", async () => {
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

    // a block whose signer left before the PC restarted is lifted at that load, before anything is served
    const other = pc();
    const [s2, t2] = [await member(other.devices), await member(other.devices)];
    const b2 = await block(t2.spki, s2);
    await other.devices.applyBlock(b2, "handed");
    const rows = JSON.parse(await Bun.file(join(other.dir, "devices.json")).text()) as { gate_closed_at: string; devices: { id: string }[] };
    writeFileSync(join(other.dir, "devices.json"), JSON.stringify({ ...rows, devices: rows.devices.filter((row) => row.id !== s2.id) }), { mode: 0o600 });
    expect(blocksInForce(open(other.dir).log)).toEqual([]);
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
  });
});
