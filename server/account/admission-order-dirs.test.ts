import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { readDeviceRegistry, type StoredDevice } from "../devices.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ADMISSION_FILE, AdmissionOrder } from "./admission-order.ts";

const AT = "2026-10-01T00:00:00.000Z";
const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-order-dirs-"));
  dirs.push(made);
  return made;
}
const row = (id: string, extra: Partial<StoredDevice> = {}): StoredDevice =>
  ({ id, label: "Phone", role: "drive", token_hash: "a".repeat(64), created_at: AT, last_seen_at: null, ...extra }) as StoredDevice;
const put = (at: string, devices: StoredDevice[]) => writeFileSync(join(at, "devices.json"), JSON.stringify({ gate_closed_at: AT, devices }), { mode: 0o600 });
const persisted = (at: string) => {
  const read = readDeviceRegistry(join(at, "devices.json"));
  return read.kind === "ok" ? Object.fromEntries(read.devices.map((d) => [d.id, d.origin])) : null;
};
function start(at: string, sibling: string | undefined, accountOpensAll: boolean) {
  const fixture = relayFixture(false, { stateDir: at, ...(sibling ? { siblingStateDir: sibling } : {}), accountOpensAll });
  fixtures.push(fixture);
  dirs.splice(dirs.indexOf(at), 1);
  return fixture;
}
/** Stops a server and keeps its folder, as a restart does. */
function stop(fixture: ReturnType<typeof relayFixture>, at: string): void {
  fixture.app.stop();
  fixtures.splice(fixtures.indexOf(fixture), 1);
  dirs.push(at);
}

describe("a row's age is its own folder's word (P21, P22, T50)", () => {
  test("T50: only this folder's rows from before the upgrade are stamped legacy; a sibling's row keeps its own number there and none here", () => {
    const [a, b] = [dir(), dir()];
    put(a, [row("aaaaaaaaaaaaaaaa")]);
    writeFileSync(join(b, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 2 }), { mode: 0o600 });
    put(b, [row("bbbbbbbbbbbbbbbb", { origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    start(a, b, true);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: expect.objectContaining({ from: "legacy", admit_no: 0 }), bbbbbbbbbbbbbbbb: undefined });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: undefined, bbbbbbbbbbbbbbbb: expect.objectContaining({ from: "remote", admit_no: 1 }) });
  });

  test("P22, T27: twins with two origins for one key keep none; a folder keeps its own origin exactly when its copy holds the key the row ends up with", async () => {
    const [a, b] = [dir(), dir()];
    const newKey = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const [keyA, firstKey, movedKey, ourOld, ourNew] = [await newKey(), await newKey(), await newKey(), await newKey(), await newKey()];
    const at = (admit_no: number, how: "code" | "link" = "code") => ({ from: "remote" as const, how, by: null, admit_no, at: AT });
    writeFileSync(join(a, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 9 }), { mode: 0o600 });
    writeFileSync(join(b, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 9 }), { mode: 0o600 });
    const linked = { account: "acct", linked_at: "2026-10-02T00:00:00.000Z", link_moved_key: true };
    put(a, [row("aaaaaaaaaaaaaaaa", { relay_public_key: keyA, origin: at(1) }), row("cccccccccccccccc", { relay_public_key: firstKey, origin: at(2) }), row("dddddddddddddddd", { relay_public_key: ourNew, ...linked, origin: at(4, "link") })]);
    put(b, [row("aaaaaaaaaaaaaaaa", { relay_public_key: keyA, origin: at(3) }), row("cccccccccccccccc", { relay_public_key: movedKey, ...linked, origin: at(5, "link") }), row("dddddddddddddddd", { relay_public_key: ourOld, origin: at(6) })]);
    start(a, b, true);
    // the sibling linked c and numbered its new key; this folder linked d and numbered its own
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: undefined, cccccccccccccccc: undefined, dddddddddddddddd: expect.objectContaining({ how: "link", admit_no: 4 }) });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: undefined, cccccccccccccccc: expect.objectContaining({ how: "link", admit_no: 5 }), dddddddddddddddd: undefined });
  });

  test("T50: a row copied into a folder that never started with the flag is no row of its own there at its first start", async () => {
    const [a, b] = [dir(), dir()];
    put(a, []);
    const first = start(a, undefined, true);
    const devices = first.app.context.services.devices;
    const key = exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const aLocal = devices.pairRelay(devices.startPairing().code, "A local", await key)!.device.id;
    stop(first, a);
    stop(start(a, b, true), a);
    expect(persisted(b)).toEqual({ [aLocal]: undefined });
    const second = start(b, a, true).app.context.services.devices;
    const bKey = exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const bLocal = second.pairRelay(second.startPairing().code, "B local", await bKey)!.device.id;
    expect(persisted(b)).toEqual({ [aLocal]: undefined, [bLocal]: expect.objectContaining({ from: "remote", admit_no: 1 }) });
  });

  test("P22: a twin keeps its own folder's origin across starts with a sibling: a copy with none erases nothing", async () => {
    const [a, b] = [dir(), dir()];
    put(a, [row("aaaaaaaaaaaaaaaa")]);
    put(b, []);
    const first = start(a, b, true);
    const devices = first.app.context.services.devices;
    const key = exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const paired = devices.pairRelay(devices.startPairing().code, "Phone", await key)!.device.id;
    stop(first, a);
    for (let restart = 0; restart < 3; restart++) stop(start(a, b, true), a);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: expect.objectContaining({ from: "legacy", admit_no: 0 }), [paired]: expect.objectContaining({ from: "remote", admit_no: 1 }) });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: undefined, [paired]: undefined });
  });

  test("P21: a missing order file beside numbered rows fails closed before a sibling merge can touch them", () => {
    const [a, b] = [dir(), dir()];
    const at = (admit_no: number) => ({ from: "remote" as const, how: "code" as const, by: null, admit_no, at: AT });
    put(a, [row("aaaaaaaaaaaaaaaa", { origin: at(1) }), row("bbbbbbbbbbbbbbbb", { origin: at(2) }), row("cccccccccccccccc", { origin: at(3) })]);
    put(b, []);
    expect(start(a, b, true).app.context.services.devices.failsClosed).toBe(true);
    expect(Object.values(persisted(a)!).map((origin) => origin?.admit_no)).toEqual([1, 2, 3]);
  });

  test("T50: a key a merge brings to an old row on its first start is no key this folder held before the upgrade", async () => {
    const [a, b] = [dir(), dir()];
    const newKey = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const [oldKey, linkedKey] = [await newKey(), await newKey()];
    put(a, [row("aaaaaaaaaaaaaaaa", { relay_public_key: oldKey })]);
    writeFileSync(join(b, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 5 }), { mode: 0o600 });
    put(b, [row("aaaaaaaaaaaaaaaa", { relay_public_key: linkedKey, account: "acct", linked_at: "2026-10-02T00:00:00.000Z", link_moved_key: true, origin: { from: "remote", how: "link", by: null, admit_no: 4, at: AT } })]);
    start(a, b, true);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: undefined });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: expect.objectContaining({ how: "link", admit_no: 4 }) });
  });

  test("P22: a link that moves a key names no approver, whoever approved the key before it", async () => {
    const [a, b] = [dir(), dir()];
    const newKey = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const memberKey = await newKey();
    put(a, [row("aaaaaaaaaaaaaaaa", { relay_public_key: memberKey, account: "acct", linked_at: AT })]);
    put(b, []);
    const devices = start(a, b, true).app.context.services.devices;
    const oldKey = await newKey();
    const id = devices.pairRelay(devices.startPairing(Date.now(), { remote: true, startedBy: "aaaaaaaaaaaaaaaa", memberRequired: true, by: null }).code, "Phone", oldKey)!.device.id;
    expect(persisted(a)?.[id]).toMatchObject({ how: "member", by: memberKey, admit_no: 1 });
    devices.linkAccountKey(id, oldKey, await newKey(), "acct");
    expect(persisted(a)?.[id]).toMatchObject({ how: "link", by: null, admit_no: 2 });
  });

  test("P21: an order file missing or behind this folder's own numbered rows is strict, even when a sibling merge removes those rows", async () => {
    for (const damage of ["missing", "behind"] as const) {
      const [a, b] = [dir(), dir()];
      put(a, []);
      const first = start(a, undefined, true);
      const devices = first.app.context.services.devices;
      const ids: string[] = [];
      for (let n = 0; n < 3; n++) ids.push(devices.pairRelay(devices.startPairing().code, "Phone", await exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey))!.device.id);
      stop(first, a);
      stop(start(a, b, true), a);
      const there = start(b, undefined, true);
      for (const id of ids) there.app.context.services.devices.revoke(id);
      stop(there, b);
      if (damage === "missing") rmSync(join(a, ADMISSION_FILE));
      else writeFileSync(join(a, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 2 }), { mode: 0o600 });
      stop(start(a, b, true), a);
      // the damage holds at every later start until it is repaired: no merge took the numbered rows away meanwhile
      expect(start(a, b, true).app.context.services.devices.failsClosed).toBe(true);
      expect(Object.keys(persisted(a)!).sort()).toEqual([...ids].sort());
    }
  });

  test("P21: a key this folder numbers on an imported row makes it its own, and the order is checked against it", async () => {
    const [a, b] = [dir(), dir()];
    const newKey = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const oldKey = await newKey();
    put(a, []);
    writeFileSync(join(b, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 2 }), { mode: 0o600 });
    put(b, [row("bbbbbbbbbbbbbbbb", { relay_public_key: oldKey, origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    const first = start(a, b, true);
    first.app.context.services.devices.linkAccountKey("bbbbbbbbbbbbbbbb", oldKey, await newKey(), "acct");
    stop(first, a);
    const linked = (readDeviceRegistry(join(a, "devices.json")) as { devices: StoredDevice[] }).devices[0]!;
    expect(linked).toMatchObject({ origin: { how: "link", admit_no: 1 } });
    expect(linked.imported).toBeUndefined();
    rmSync(join(a, ADMISSION_FILE));
    expect(start(a, b, true).app.context.services.devices.failsClosed).toBe(true);
  });

  test("P22: a key replaced with the release flag off keeps no age of the key before it", async () => {
    const at = dir();
    const newKey = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const oldKey = await newKey();
    put(at, [row("aaaaaaaaaaaaaaaa", { relay_public_key: oldKey, origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    start(at, undefined, false).app.context.services.devices.linkAccountKey("aaaaaaaaaaaaaaaa", oldKey, await newKey(), "acct");
    expect(persisted(at)).toEqual({ aaaaaaaaaaaaaaaa: undefined });
  });

  test("P22: two folders that each numbered a row 1 keep only their own after a flag-off merge and a flag-on start", () => {
    const [a, b] = [dir(), dir()];
    const one = { from: "remote" as const, how: "code" as const, by: null, admit_no: 1, at: AT };
    for (const [at, id] of [[a, "aaaaaaaaaaaaaaaa"], [b, "bbbbbbbbbbbbbbbb"]] as const) {
      writeFileSync(join(at, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 2 }), { mode: 0o600 });
      put(at, [row(id, { origin: one })]);
    }
    stop(start(a, b, false), a);
    expect(start(a, b, true).app.context.services.devices.failsClosed).toBe(false);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: expect.objectContaining({ admit_no: 1 }), bbbbbbbbbbbbbbbb: undefined });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: undefined, bbbbbbbbbbbbbbbb: expect.objectContaining({ admit_no: 1 }) });
  });

  test("P22: with the release flag off a twin keeps this folder's own origin, never the sibling's", () => {
    const [a, b] = [dir(), dir()];
    put(a, [row("aaaaaaaaaaaaaaaa")]);
    put(b, [row("aaaaaaaaaaaaaaaa", { origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    start(a, b, false);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: undefined });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: expect.objectContaining({ admit_no: 1 }) });
  });

  test("P22: a merge with the flag off, then a start with it on, neither locks this PC nor takes the sibling's number, whichever dir had the flag", async () => {
    const at = (admit_no: number) => ({ from: "remote" as const, how: "code" as const, by: null, admit_no, at: AT });
    for (const flagOnFirst of ["sibling", "this"] as const) {
      const [a, b] = [dir(), dir()];
      const [numbered, plain] = flagOnFirst === "sibling" ? [b, a] : [a, b];
      writeFileSync(join(numbered, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 4 }), { mode: 0o600 });
      put(numbered, [row("bbbbbbbbbbbbbbbb", { origin: at(3) })]);
      put(plain, []);
      stop(start(plain, numbered, false), plain);
      expect(persisted(plain)).toEqual({ bbbbbbbbbbbbbbbb: undefined });
      const devices = start(plain, numbered, true).app.context.services.devices;
      expect(devices.failsClosed).toBe(false);
      expect(persisted(plain)).toEqual({ bbbbbbbbbbbbbbbb: undefined });
      expect(persisted(numbered)).toEqual({ bbbbbbbbbbbbbbbb: expect.objectContaining({ admit_no: 3 }) });
    }
  });

  test("P21: a folder opened by its real path and through a link to it is one order", () => {
    const at = dir();
    const linked = `${at}-link`;
    symlinkSync(at, linked);
    dirs.push(linked);
    expect(AdmissionOrder.open(linked)).toBe(AdmissionOrder.open(at));
  });

  test("P22: digits approved with no member name the path digits and no approver, whatever code is pending", async () => {
    const at = dir();
    const memberKey = exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    put(at, [row("aaaaaaaaaaaaaaaa", { relay_public_key: await memberKey, account: "acct", linked_at: AT })]);
    const devices = start(at, undefined, true).app.context.services.devices;
    devices.startPairing(Date.now(), { remote: true, startedBy: "aaaaaaaaaaaaaaaa", memberRequired: true, by: null });
    const key = exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const id = devices.pairRelayApproved("Digits", await key, { path: "code" })!.device.id;
    expect(persisted(at)?.[id]).toMatchObject({ how: "digits", by: null });
  });

  test("P22: with the release flag off a merge copies a sibling's row with no origin, and an unreadable origin is no age, not a bad registry", () => {
    const [a, b] = [dir(), dir()];
    put(a, []);
    put(b, [row("bbbbbbbbbbbbbbbb", { origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    start(a, b, false);
    expect(persisted(a)).toEqual({ bbbbbbbbbbbbbbbb: undefined });
    expect(persisted(b)?.["bbbbbbbbbbbbbbbb"]).toMatchObject({ admit_no: 1 });
    const c = dir();
    put(c, [row("cccccccccccccccc", { origin: { from: "nowhere" } as never })]);
    expect(readDeviceRegistry(join(c, "devices.json")).kind).toBe("ok");
  });

  test("P21: one folder has one order handle, and no number is given twice", () => {
    const at = dir();
    const first = AdmissionOrder.open(at);
    const second = AdmissionOrder.open(at);
    expect(second).toBe(first);
    first.settleFresh();
    expect([first.admit("remote", "code", null, Date.now()).admit_no, second.admit("remote", "code", null, Date.now()).admit_no]).toEqual([1, 2]);
  });

  test("P21: an order file behind the numbers its rows carry is damage", () => {
    const at = dir();
    writeFileSync(join(at, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 2 }), { mode: 0o600 });
    put(at, [row("aaaaaaaaaaaaaaaa", { origin: { from: "remote", how: "code", by: null, admit_no: 3, at: AT } })]);
    expect(start(at, undefined, true).app.context.services.devices.accountError).not.toBeNull();
  });

  test("P22: by names the member who approved, and only a member", async () => {
    const at = dir();
    mkdirSync(at, { recursive: true });
    const f = start(at, undefined, true);
    const devices = f.app.context.services.devices;
    const key = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const outsider = devices.pairRelay(devices.startPairing().code, "Outsider", await key())!.device.id;
    const added = devices.pairRelay(devices.startPairing(Date.now(), { remote: true, startedBy: outsider, memberRequired: false, by: null }).code, "By code", await key())!.device.id;
    expect(persisted(at)?.[added]).toMatchObject({ how: "code", by: null });
  });

  test("T50: the legacy pass runs at start even while the old tombstone file cannot be read", () => {
    const at = dir();
    put(at, [row("aaaaaaaaaaaaaaaa")]);
    mkdirSync(join(at, "account-tombstones.json"));
    start(at, undefined, true);
    expect(persisted(at)?.["aaaaaaaaaaaaaaaa"]).toMatchObject({ from: "legacy", admit_no: 0 });
  });
});
