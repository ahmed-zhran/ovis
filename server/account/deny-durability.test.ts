import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-deny-"));
  dirs.push(made);
  return made;
}
function store(at: string): DeviceStore {
  const log = SafetyLog.open(at);
  return new DeviceStore(at, null, null, { safety: log, pc: PcAccountState.open(at), removals: RemovalEvidence.open(at, log) });
}
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return exportAccountKey(pair.publicKey);
}

describe("a deny holds for every row and every live session (P8, S19)", () => {
  test("P8: a cookie row whose Revoke cannot be written is never acknowledged, and the PC fails closed meanwhile", () => {
    const at = dir();
    const devices = store(at);
    const cookie = devices.pair(devices.startPairing().code, "Laptop", "drive")!;
    devices.match(cookie.token);
    let closed = false;
    devices.onRevoke(cookie.device.id, () => { closed = true; });
    // the registry is its only deny: when it cannot be written the Revoke throws, its sessions end anyway, and
    // nothing but this PC gets in until a deny is written
    chmodSync(at, 0o500);
    expect(() => devices.revoke(cookie.device.id)).toThrow();
    chmodSync(at, 0o700);
    expect(closed).toBe(true);
    expect(devices.match(cookie.token)).toBeNull();
    expect(devices.accountError).not.toBeNull();
  });

  test("S19: a session signed in before the PC failed closed opens no new stream", async () => {
    const at = dir();
    const devices = store(at);
    const row = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    expect(devices.sessionRow(row)).not.toBeNull();
    const other = devices.pairRelay(devices.startPairing().code, "Tablet", await key())!.device.id;
    chmodSync(at, 0o500);
    expect(() => devices.revoke(other)).toThrow();
    chmodSync(at, 0o700);
    // the deny of the other row could not be written: the live session of this one is asked again and refused
    expect(devices.sessionRow(row)).toBeNull();
  });

  test("P8: an interrupted Revoke all is finished at start even when the old tombstone file cannot be read", async () => {
    const at = dir();
    const devices = store(at);
    devices.pairRelay(devices.startPairing().code, "Phone", await key());
    writeFileSync(join(at, "revoke-all.json"), JSON.stringify({ id: "a".repeat(32), by: "pc", at: new Date().toISOString() }), { mode: 0o600 });
    rmSync(join(at, "account-tombstones.json"), { force: true });
    mkdirSync(join(at, "account-tombstones.json"));
    const reopened = store(at);
    expect(reopened.list(null)).toEqual([]);
  });

  test("P8: a Revoke whose deny cannot be written changes nothing on disk, and only that key's own deny ends the closing", async () => {
    const at = dir();
    const devices = store(at);
    const [a, b] = [await key(), await key()];
    const rowA = devices.pairRelay(devices.startPairing().code, "A", a)!.device.id;
    const rowB = devices.pairRelay(devices.startPairing().code, "B", b)!.device.id;
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, REMOVAL_FILE)) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revoke(rowA)).toThrow(); } finally { privateStateFs.renameSync = rename; }
    // the row stays on disk, where the failed Revoke stays visible; in this run it is out and the PC fails closed
    const registry = readDeviceRegistry(join(at, "devices.json"));
    expect(registry.kind === "ok" && registry.devices.some((d) => d.id === rowA)).toBe(true);
    expect(devices.hasKey(a)).toBe(false);
    expect(devices.failsClosed).toBe(true);
    // another key's deny landing does not end it
    devices.revoke(rowB);
    expect(devices.failsClosed).toBe(true);
    expect(devices.hasKey(a)).toBe(false);
    // that key's own deny does
    devices.revoke(rowA);
    expect(devices.failsClosed).toBe(false);
    expect(store(at).isTombstoned(a)).toBe(true);
  });

  test("P8: a Revoke all that fails after its intent is on disk fails the PC closed at once", async () => {
    const at = dir();
    const devices = store(at);
    devices.pairRelay(devices.startPairing().code, "A", await key());
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(at, "devices.json")) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { expect(() => devices.revokeAll()).toThrow(); } finally { privateStateFs.renameSync = rename; }
    expect(devices.failsClosed).toBe(true);
  });
});
