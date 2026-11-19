import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { applyAccountRecords } from "./records.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER_ID = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Pc { dir: string; devices: DeviceStore; log: SafetyLog }
function pc(): Pc {
  const dir = mkdtempSync(join(tmpdir(), "ovis-admission-guard-"));
  dirs.push(dir);
  const log = SafetyLog.open(dir);
  const devices = new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir) });
  return { dir, devices, log };
}

async function accountKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A drive member of the account on this PC, which signs with its key. */
async function member(devices: DeviceStore) {
  const key = await accountKey();
  const id = devices.pairRelay(devices.startPairing().code, "Member", key.spki)!.device.id;
  devices.linkAccountKey(id, key.spki, key.spki, ACCOUNT);
  return { id, key };
}

/** A block of `target` in force in this PC's log, signed by `by`; the target joined here as admission number `joined`. */
async function block(log: SafetyLog, target: string, by: Awaited<ReturnType<typeof accountKey>>, joined: number | null): Promise<void> {
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 2, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey);
  log.append({ record, got: "handed", asof: { signer_no: 1, target_no: 2, after: 2, joined, signer_removed: false } });
}

const add = (signer: Awaited<ReturnType<typeof accountKey>>, key: string) =>
  signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, label: "New phone", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.keys.privateKey);

describe("one final admission guard (G3, rule R1)", () => {
  test("T10: digits approval rechecks member authority and the freeze for this key at commit", async () => {
    const { devices, log } = pc();
    const approver = await member(devices);
    // no freeze: the approval of a new key commits
    expect(devices.pairRelayApproved("Phone", (await accountKey()).spki, { path: "account", addedBy: approver.id })).not.toBeNull();
    // a freeze stands: a new key is newer than its target, and the same approval admits nobody
    const target = await member(devices);
    await block(log, target.key.spki, approver.key, 99);
    expect(devices.pairRelayApproved("Tablet", (await accountKey()).spki, { path: "account", addedBy: approver.id })).toBeNull();
    // an approver gone by commit approves nothing
    const fresh = pc();
    const gone = await member(fresh.devices);
    fresh.devices.revoke(gone.id);
    expect(fresh.devices.pairRelayApproved("Phone", (await accountKey()).spki, { path: "account", addedBy: gone.id })).toBeNull();
  });

  test("T15: a handed or mailed add cannot widen under a freeze or after generation changes", async () => {
    const { devices, log } = pc();
    const signer = await member(devices);
    const other = await member(devices);
    // the generation changes while the add is being verified: it does not commit
    const pending = applyAccountRecords(devices, [await add(signer.key, (await accountKey()).spki)], SERVER_ID);
    devices.revoke(other.id);
    expect((await pending).map((r) => r.outcome)).toEqual(["refused"]);
    // unchanged generation: it commits
    expect((await applyAccountRecords(devices, [await add(signer.key, (await accountKey()).spki)], SERVER_ID)).map((r) => r.outcome)).toEqual(["applied"]);
    // a freeze stands: refused, and not kept for later
    await block(log, (await accountKey()).spki, signer.key, 99);
    const newKey = (await accountKey()).spki;
    expect((await applyAccountRecords(devices, [await add(signer.key, newKey)], SERVER_ID)).map((r) => r.outcome)).toEqual(["refused"]);
    expect(devices.hasKey(newKey)).toBe(false);
  });

  test("G3: admission, release and merge import share the same final guard", async () => {
    const { devices, log } = pc();
    const older = await member(devices);
    const target = await member(devices);
    // the block's target joined this PC as admission 2: keys admitted before it stay admissible, every new key is newer
    await block(log, target.key.spki, older.key, 2);
    expect(devices.admits(older.key.spki)).toBe(true);
    const newKey = (await accountKey()).spki;
    expect(devices.admits(newKey)).toBe(false);
    // every admission path asks it at commit
    expect(devices.pair(devices.startPairing().code, "Laptop", "drive")).toBeNull();
    expect(devices.pairRelay(devices.startPairing().code, "Phone", newKey)).toBeNull();
    expect(devices.pairRelayApproved("Phone", newKey, { path: "account", addedBy: older.id })).toBeNull();
    expect((await applyAccountRecords(devices, [await add(older.key, newKey)], SERVER_ID))[0]!.outcome).toBe("refused");
    expect(devices.hasKey(newKey)).toBe(false);

    // a lock admits nobody remote, a key no freeze names included
    const locked = pc();
    const keep = await member(locked.devices);
    locked.log.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: ACCOUNT, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
    expect(locked.devices.admits(keep.key.spki)).toBe(false);
    expect(locked.devices.pairRelay(locked.devices.startPairing().code, "Phone", (await accountKey()).spki)).toBeNull();
  });
});
