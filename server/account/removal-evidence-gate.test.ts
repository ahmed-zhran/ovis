import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { REMOVAL_FILE, RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const AT = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-02T00:00:00.000Z";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-removal-gate-"));
  dirs.push(dir);
  return dir;
}
const key = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
const row = (id: string, k: string, created_at = AT) => ({ id, label: "Phone", role: "drive", token_hash: "a".repeat(64), relay_public_key: k, created_at, last_seen_at: null });
const put = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value), { mode: 0o600 });
const tombstones = (list: unknown[]) => ({ v: 1, tombstones: list });
function open(dir: string) {
  const log = SafetyLog.open(dir);
  return new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log) });
}
function start(dir: string, sibling?: string) {
  const fixture = relayFixture(false, { stateDir: dir, accountOpensAll: true, ...(sibling ? { siblingStateDir: sibling } : {}) });
  fixtures.push(fixture);
  dirs.splice(dirs.indexOf(dir), 1);
  return fixture.app.context.services.devices;
}

describe("removal evidence holds through crashes, siblings and damaged files (P13, T26, T48, S19)", () => {
  test("P13, T48: a local Revoke stands beside a sibling's account tombstone of the same key; the revoked row stays out", async () => {
    const [active, sibling] = [stateDir(), stateDir()];
    const k = await key();
    // a stop after the Revoke's tombstone was written and before the row left the registry
    put(active, "devices.json", { gate_closed_at: AT, devices: [row("aaaaaaaaaaaaaaaa", k)] });
    put(active, "account-tombstones.json", tombstones([{ key: k, account: "", record_id: "local", removed_at: LATER }]));
    put(sibling, "account-tombstones.json", tombstones([{ key: k, account: "acct", record_id: "r".repeat(32), removed_at: LATER }]));
    const devices = start(active, sibling);
    expect(devices.has("aaaaaaaaaaaaaaaa")).toBe(false);
    expect((JSON.parse(readFileSync(join(active, REMOVAL_FILE), "utf8")) as { revokes: unknown[] }).revokes).toHaveLength(1);
  });

  test("T26: a stop between a re-pair's row and its unrevoke keeps the row; a stop before the row keeps the Revoke", async () => {
    const dir = stateDir();
    const k = await key();
    const devices = open(dir);
    const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
    devices.revoke(id);
    const revoked = readFileSync(join(dir, REMOVAL_FILE));
    const again = devices.pairRelay(devices.startPairing().code, "Again", k)!.device.id;
    // the unrevoke never reached the disk
    writeFileSync(join(dir, REMOVAL_FILE), revoked, { mode: 0o600 });
    expect(open(dir).has(again)).toBe(true);
    const before = stateDir();
    const other = open(before);
    const gone = other.pairRelay(other.startPairing().code, "Phone", k)!.device.id;
    other.revoke(gone);
    expect(open(before).isTombstoned(k)).toBe(true);
  });

  test("S19: removal evidence that will not parse, or is of another version, is strict and kept byte for byte", () => {
    for (const text of ["not json", JSON.stringify({ v: 9, markers: [], revokes: [], unrevokes: [] })]) {
      const dir = stateDir();
      writeFileSync(join(dir, REMOVAL_FILE), text, { mode: 0o600 });
      const devices = open(dir);
      expect(devices.failsClosed || devices.accountError !== null).toBe(true);
      expect(readFileSync(join(dir, REMOVAL_FILE), "utf8")).toBe(text);
    }
  });

  test("S19: a pending tombstone file that cannot be read is strict and kept", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "account-tombstones.pending.json"), "not json", { mode: 0o600 });
    const devices = open(dir);
    expect(devices.failsClosed || devices.accountError !== null).toBe(true);
    expect(readFileSync(join(dir, "account-tombstones.pending.json"), "utf8")).toBe("not json");
  });

  test("T26: a pending-only tombstone is written to the tombstone file once taken in, and an old local tombstone imports once", async () => {
    const dir = stateDir();
    const k = await key();
    put(dir, "account-tombstones.pending.json", tombstones([{ key: k, account: "", record_id: "local", removed_at: LATER }]));
    open(dir);
    expect(existsSync(join(dir, "account-tombstones.pending.json"))).toBe(false);
    expect(JSON.stringify(JSON.parse(readFileSync(join(dir, "account-tombstones.json"), "utf8")))).toContain(k);
    open(dir);
    expect((JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: unknown[] }).revokes).toHaveLength(1);
  });

  test("S19: removal evidence others can write is not trusted", () => {
    if (process.platform === "win32") return;
    const dir = stateDir();
    open(dir);
    chmodSync(join(dir, REMOVAL_FILE), 0o666);
    const devices = open(dir);
    expect(devices.failsClosed || devices.accountError !== null).toBe(true);
  });
});
