import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, type SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { REMOVAL_FILE, RemovalEvidence } from "./removal-evidence.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

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
      expect(devices.failsClosed).toBe(true);
      expect(readFileSync(join(dir, REMOVAL_FILE), "utf8")).toBe(text);
    }
  });

  test("S19: a pending tombstone file that cannot be read is strict and kept", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "account-tombstones.pending.json"), "not json", { mode: 0o600 });
    const devices = open(dir);
    expect(devices.failsClosed).toBe(true);
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
    expect(devices.failsClosed).toBe(true);
  });

  test("P13, S19: a Revoke made while the tombstone file is damaged stands as evidence, and its row stays out after a stop", async () => {
    const dir = stateDir();
    const k = await key();
    const devices = open(dir);
    const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
    const kept = readFileSync(join(dir, "devices.json"));
    rmSync(join(dir, "account-tombstones.json"), { force: true });
    mkdirSync(join(dir, "account-tombstones.json"));
    const damaged = open(dir);
    expect(damaged.failsClosed).toBe(true);
    damaged.revoke(id);
    expect((JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: unknown[] }).revokes).toHaveLength(1);
    // a stop before the row left the registry
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    rmSync(join(dir, "account-tombstones.json"), { recursive: true, force: true });
    const restarted = open(dir);
    expect(restarted.has(id)).toBe(false);
    expect((JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: { id: string }[] }).revokes).toHaveLength(1);
  });

  test("P13: a Revoke is imported once: its own id is the one a restart reads it back under", async () => {
    const dir = stateDir();
    const devices = open(dir);
    const id = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    devices.revoke(id);
    open(dir);
    expect((JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: unknown[] }).revokes).toHaveLength(1);
  });

  function startAt(dir: string, accountOpensAll: boolean) {
    const fixture = relayFixture(false, { stateDir: dir, accountOpensAll });
    fixtures.push(fixture);
    const at = dirs.indexOf(dir);
    if (at >= 0) dirs.splice(at, 1);
    return fixture;
  }
  function stopAt(fixture: ReturnType<typeof relayFixture>) {
    fixture.app.stop();
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }
  async function signsIn(fixture: ReturnType<typeof relayFixture>, device: Awaited<ReturnType<typeof relayDevice>>): Promise<boolean> {
    const link = await relayConnection(fixture);
    return link.auth(device).then(() => true, () => false);
  }
  const damageFile = (path: string) => { rmSync(path, { recursive: true, force: true }); mkdirSync(path); };

  test("PB1: with the tombstone file damaged, a Revoke and a stop before its row goes leave that key refused at sign-in", async () => {
    const dir = stateDir();
    const first = startAt(dir, true);
    const device = await relayDevice(first);
    const kept = readFileSync(join(dir, "devices.json"));
    stopAt(first);
    damageFile(join(dir, "account-tombstones.json"));
    const second = startAt(dir, true);
    second.app.context.services.devices.revoke(device.id);
    stopAt(second);
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    expect(await signsIn(startAt(dir, true), device)).toBe(false);
  });

  test("PB3: a Revoke held only in main's tombstone file holds at the first flag-on start, though the pending file is damaged", async () => {
    const dir = stateDir();
    const before = startAt(dir, false);
    const device = await relayDevice(before);
    const kept = readFileSync(join(dir, "devices.json"));
    before.app.context.services.devices.revoke(device.id);
    stopAt(before);
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    writeFileSync(join(dir, "account-tombstones.pending.json"), "not json", { mode: 0o600 });
    expect(await signsIn(startAt(dir, true), device)).toBe(false);
  });

  test("PB4: a Revoke leaves a damaged pending file byte for byte", async () => {
    const dir = stateDir();
    const devices = open(dir);
    const id = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    writeFileSync(join(dir, "account-tombstones.pending.json"), "not json", { mode: 0o600 });
    open(dir).revoke(id);
    expect(readFileSync(join(dir, "account-tombstones.pending.json"), "utf8")).toBe("not json");
  });

  test("with the flag off a damaged pending file is read as empty, as main reads it", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "account-tombstones.pending.json"), "not json", { mode: 0o600 });
    expect(new DeviceStore(dir).accountError).toBeNull();
  });

  test("P13, rule 1: a Revoke made while the removal evidence cannot be trusted leaves a tombstone, which holds once the evidence file is deleted", async () => {
    if (process.platform === "win32") return;
    const dir = stateDir();
    const k = await key();
    const devices = open(dir);
    const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
    chmodSync(join(dir, REMOVAL_FILE), 0o666);
    open(dir).revoke(id);
    rmSync(join(dir, REMOVAL_FILE));
    const repaired = open(dir);
    expect(repaired.isTombstoned(k)).toBe(true);
  });

  test("P13, G6: a Revoke made while the removal evidence cannot be trusted keeps its key out at relay sign-in after each repair", async () => {
    if (process.platform === "win32") return;
    const repairs: [string, (path: string, before: Buffer) => void, (path: string, before: Buffer) => void][] = [
      ["0666, deleted", (path) => chmodSync(path, 0o666), (path) => rmSync(path)],
      ["0666, chmod 0600", (path) => chmodSync(path, 0o666), (path) => chmodSync(path, 0o600)],
      ["v 9, restored", (path) => writeFileSync(path, JSON.stringify({ v: 9 }), { mode: 0o600 }), (path, before) => writeFileSync(path, before, { mode: 0o600 })],
    ];
    for (const [, damage, repair] of repairs) {
      const dir = stateDir();
      const first = startAt(dir, true);
      const device = await relayDevice(first);
      stopAt(first);
      const path = join(dir, REMOVAL_FILE);
      const before = readFileSync(path);
      damage(path, before);
      const damaged = startAt(dir, true);
      damaged.app.context.services.devices.revoke(device.id);
      stopAt(damaged);
      repair(path, before);
      const repaired = startAt(dir, true);
      expect(repaired.app.context.services.devices.isTombstoned(device.publicKey)).toBe(true);
      expect(await signsIn(repaired, device)).toBe(false);
    }
  });

  test("PB2: with the tombstone file damaged, a Revoke takes every row of its key, and the second row's sign-in is refused", async () => {
    const dir = stateDir();
    const first = startAt(dir, true);
    const one = await relayDevice(first);
    const store = first.app.context.services.devices;
    const second = store.pairRelay(store.startPairing().code, "Second", one.publicKey)!.device.id;
    stopAt(first);
    damageFile(join(dir, "account-tombstones.json"));
    const damaged = startAt(dir, true);
    damaged.app.context.services.devices.revoke(one.id);
    stopAt(damaged);
    rmSync(join(dir, "account-tombstones.json"), { recursive: true, force: true });
    expect(await signsIn(startAt(dir, true), { ...one, id: second })).toBe(false);
  });

  test("P13: with the registry blocked, a row a local tombstone newer than it covers is refused at relay sign-in", async () => {
    const dir = stateDir();
    const first = startAt(dir, true);
    const device = await relayDevice(first);
    stopAt(first);
    put(dir, "account-tombstones.json", tombstones([{ key: device.publicKey, account: "", record_id: "local", removed_at: new Date(Date.now() + 60_000).toISOString() }]));
    // a sibling folder whose registry will not parse: the merge fails, and the registry is blocked
    const sibling = stateDir();
    writeFileSync(join(sibling, "devices.json"), "not json", { mode: 0o600 });
    const fixture = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(fixture.app.context.services.devices.hasKey(device.publicKey)).toBe(false);
    expect(await signsIn(fixture, device)).toBe(false);
  });


  test("P13: with the registry blocked, a row whose Revoke fell back to main's tombstone under untrusted evidence is refused at relay sign-in", async () => {
    if (process.platform === "win32") return;
    const dir = stateDir();
    const first = startAt(dir, true);
    const device = await relayDevice(first);
    const kept = readFileSync(join(dir, "devices.json"));
    stopAt(first);
    chmodSync(join(dir, REMOVAL_FILE), 0o666);
    const damaged = startAt(dir, true);
    damaged.app.context.services.devices.revoke(device.id);
    stopAt(damaged);
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    chmodSync(join(dir, REMOVAL_FILE), 0o600);
    const sibling = stateDir();
    writeFileSync(join(sibling, "devices.json"), "not json", { mode: 0o600 });
    const fixture = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(await signsIn(fixture, device)).toBe(false);
  });

  test("T26: a re-pair in the very millisecond of its Revoke is still later than it: a stop before the unrevoke keeps the row", async () => {
    const dir = stateDir();
    const k = await key();
    setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    try {
      const devices = open(dir);
      const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
      devices.revoke(id);
      const revoked = readFileSync(join(dir, REMOVAL_FILE));
      const again = devices.pairRelay(devices.startPairing().code, "Again", k)!.device.id;
      writeFileSync(join(dir, REMOVAL_FILE), revoked, { mode: 0o600 });
      expect(open(dir).has(again)).toBe(true);
    } finally { setSystemTime(); }
  });

  test("P13: a Revoke made after the wall clock stepped back is still later than the row it revoked, which stays out after a stop", async () => {
    const dir = stateDir();
    const k = await key();
    try {
      setSystemTime(new Date("2026-10-01T00:00:05.000Z"));
      const devices = open(dir);
      const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
      const kept = readFileSync(join(dir, "devices.json"));
      setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
      devices.revoke(id);
      writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
      expect(open(dir).has(id)).toBe(false);
    } finally { setSystemTime(); }
  });

  test("S19, P13: a time past year 9999 in a sibling's tombstone fails the PC closed; the revoked row stays out and the re-paired row is kept", async () => {
    const dir = stateDir();
    const first = startAt(dir, true);
    const device = await relayDevice(first);
    const store = first.app.context.services.devices;
    store.revoke(device.id);
    const revoked = readFileSync(join(dir, REMOVAL_FILE));
    const again = store.pairRelay(store.startPairing().code, "Again", device.publicKey)!.device.id;
    stopAt(first);
    // the stop came before the re-pair's unrevoke
    writeFileSync(join(dir, REMOVAL_FILE), revoked, { mode: 0o600 });
    const sibling = stateDir();
    put(sibling, "account-tombstones.json", tombstones([{ key: await key(), account: "", record_id: "local", removed_at: "+010000-01-01T00:00:00.000Z" }]));
    const fixture = relayFixture(false, { stateDir: dir, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    const devices = fixture.app.context.services.devices;
    expect(devices.failsClosed).toBe(true);
    expect(devices.has(again)).toBe(true);
    expect(await signsIn(fixture, device)).toBe(false);
  });

  test("with the flag off, a row a tombstone covers stays out whatever form its times take, as on main", async () => {
    for (const [created, removed] of [["2026-10-01T00:00:00.000Z", "not-a-time"], ["+010000-01-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]] as const) {
      const dir = stateDir();
      const k = await key();
      put(dir, "devices.json", { gate_closed_at: AT, devices: [row("aaaaaaaaaaaaaaaa", k, created)] });
      put(dir, "account-tombstones.json", tombstones([{ key: k, account: "", record_id: "local", removed_at: removed }]));
      expect(new DeviceStore(dir).hasKey(k)).toBe(false);
    }
  });

  test("P13, T61: a removal arriving while the safety log cannot be read is taken in once it can be, outranking the forgets it held", async () => {
    const dir = stateDir();
    const k = await key();
    open(dir);
    // an old forget of this key's removal in the account, already in the log
    const forgot = SafetyLog.open(dir).append({ record: { v: 1, id: pcRecordId(), kind: "forget", account: "acct", target: k, signer: "pc", signed_at: AT, signature: "" } as SafetyRecord, got: "pc" });
    expect(forgot).toMatchObject({ outcome: "applied" });
    const log = readFileSync(join(dir, "account-log.json"));
    // the removal arrives while the log cannot be read
    put(dir, "account-tombstones.json", tombstones([{ key: k, account: "acct", record_id: "r".repeat(32), removed_at: LATER }]));
    writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 });
    // a restart: this process keeps one handle per folder, so the old one goes first
    SafetyLog.open(dir).close();
    expect(open(dir).failsClosed).toBe(true);
    SafetyLog.open(dir).close();
    // repaired: the old forget is read again, and the removal still stands
    writeFileSync(join(dir, "account-log.json"), log, { mode: 0o600 });
    expect(open(dir).removedByAccount(k)).toBe(true);
  });

  test("LEDGER S2-38 L1 (gate r3 at 2dd91119): with a tombstone file damaged, the revoked row leaves devices.json at once, not only after the repair", async () => {
    const dir = stateDir();
    const devices = open(dir);
    const id = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    const kept = readFileSync(join(dir, "devices.json"));
    damageFile(join(dir, "account-tombstones.json"));
    open(dir).revoke(id);
    writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
    open(dir);
    expect(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices.map((d: { id: string }) => d.id)).not.toContain(id);
  });

  test("LEDGER S2-38 L2 (gate r3 at 2dd91119): a damaged pending file refuses account records but does not fail the whole PC closed", () => {
    const dir = stateDir();
    open(dir);
    writeFileSync(join(dir, "account-tombstones.pending.json"), "not json", { mode: 0o600 });
    const devices = open(dir);
    expect(devices.accountError).not.toBeNull();
    expect(devices.failsClosed).toBe(false);
  });

  test("LEDGER S2-38 L3 (gate r3 at 2dd91119): Revokes and unrevokes a re-pair ended do not grow without bound", async () => {
    const dir = stateDir();
    const devices = open(dir);
    const k = await key();
    for (let i = 0; i < 5; i++) {
      const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
      devices.revoke(id);
    }
    devices.pairRelay(devices.startPairing().code, "Phone", k);
    const doc = JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: unknown[]; unrevokes: unknown[] };
    expect(doc.revokes.length + doc.unrevokes.length).toBeLessThan(10);
  });



  test("LEDGER S2-38 L4 (dori LOW 1 at c9b1a699): removal evidence that is a link to another file is not trusted, as no private state is", () => {
    if (process.platform === "win32") return;
    const dir = stateDir();
    open(dir);
    const elsewhere = stateDir();
    const target = join(elsewhere, "evidence.json");
    writeFileSync(target, readFileSync(join(dir, REMOVAL_FILE)), { mode: 0o600 });
    rmSync(join(dir, REMOVAL_FILE));
    symlinkSync(target, join(dir, REMOVAL_FILE));
    expect(open(dir).failsClosed).toBe(true);
  });

  test("LEDGER S2-38 L5 (dori LOW 2 at c9b1a699, MUST-CLOSE): removal evidence written once and then missing is strict, even with no device journal", async () => {
    const dir = stateDir();
    const devices = open(dir);
    devices.revoke(devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id);
    rmSync(join(dir, REMOVAL_FILE));
    expect(open(dir).failsClosed).toBe(true);
  });

  test("LEDGER S2-38 L6 (dori LOW 3 at c9b1a699, MUST-CLOSE): a ninth removal of one key does not evict a removal still standing", async () => {
    const dir = stateDir();
    const evidence = RemovalEvidence.open(dir, null);
    const k = await key();
    for (let n = 0; n < 9; n++) evidence.addRemoval(k, "acct", { id: String(n).padStart(32, "0"), at: new Date(Date.UTC(2026, 9, 1 + n)).toISOString() });
    expect(evidence.standingMarkers(k).flatMap((m) => m.standing.map((r) => r.id))).toContain("0".repeat(32));
  });

  test("LEDGER S2-38 L7 (dori LOW 4 at c9b1a699): ended Revoke and unrevoke pairs are bounded (see L3)", async () => {
    const dir = stateDir();
    const devices = open(dir);
    const k = await key();
    for (let i = 0; i < 12; i++) devices.revoke(devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id);
    const doc = JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: unknown[] };
    expect(doc.revokes.length).toBeLessThanOrEqual(8);
  });

  test("LEDGER S2-38 L8 (dori LOW 5 at c9b1a699): with the flag on, an account tombstone of an account this PC is not in keeps no row of it out", async () => {
    const dir = stateDir();
    const devices = open(dir);
    const k = await key();
    devices.pairRelay(devices.startPairing().code, "Phone", k);
    put(dir, "account-tombstones.json", tombstones([{ key: k, account: "acct_x", record_id: "r".repeat(32), removed_at: new Date(Date.now() + 60_000).toISOString() }]));
    expect(open(dir).hasKey(k)).toBe(true);
  });

  test("LEDGER S2-38 L9 (dori MEDIUM at 16a85de1, MUST-CLOSE): a row paired while the clock ran two days ahead does not fail the PC closed, and a Revoke after it still keeps it out", async () => {
    const dir = stateDir();
    const k = await key();
    try {
      setSystemTime(new Date("2026-10-03T00:00:00.000Z"));
      const devices = open(dir);
      const id = devices.pairRelay(devices.startPairing().code, "Phone", k)!.device.id;
      setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
      const reopened = open(dir);
      expect(reopened.failsClosed).toBe(false);
      const kept = readFileSync(join(dir, "devices.json"));
      reopened.revoke(id);
      writeFileSync(join(dir, "devices.json"), kept, { mode: 0o600 });
      expect(open(dir).has(id)).toBe(false);
    } finally { setSystemTime(); }
  });

  test("LEDGER S2-38 CR2 (CodeRabbit at 4868c76e): Revoke all writes the Revokes of every key in one write, so a failure writes none", async () => {
    const dir = stateDir();
    const devices = open(dir);
    for (let i = 0; i < 2; i++) devices.pairRelay(devices.startPairing().code, "Phone", await key());
    const rename = privateStateFs.renameSync;
    let writes = 0;
    privateStateFs.renameSync = (from, to) => {
      if (to === join(dir, REMOVAL_FILE) && ++writes === 2) throw new Error("simulated EIO");
      return rename(from, to);
    };
    try { try { devices.revokeAll(); } catch { /* the second write fails */ } } finally { privateStateFs.renameSync = rename; }
    expect((JSON.parse(readFileSync(join(dir, REMOVAL_FILE), "utf8")) as { revokes: unknown[] }).revokes).toHaveLength(0);
  });
});
