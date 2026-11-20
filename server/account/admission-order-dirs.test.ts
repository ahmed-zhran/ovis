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

  test("P22: twin rows whose origins disagree keep none in either folder, also when one copy moved its key", async () => {
    const [a, b] = [dir(), dir()];
    const newKey = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);
    const [keyA, firstKey, movedKey] = [await newKey(), await newKey(), await newKey()];
    const at = (admit_no: number, how: "code" | "link" = "code") => ({ from: "remote" as const, how, by: null, admit_no, at: AT });
    writeFileSync(join(a, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 9 }), { mode: 0o600 });
    writeFileSync(join(b, ADMISSION_FILE), JSON.stringify({ v: 1, next_admit: 9 }), { mode: 0o600 });
    put(a, [row("aaaaaaaaaaaaaaaa", { relay_public_key: keyA, origin: at(1) }), row("cccccccccccccccc", { relay_public_key: firstKey, origin: at(2) })]);
    put(b, [row("aaaaaaaaaaaaaaaa", { relay_public_key: keyA, origin: at(3) }), row("cccccccccccccccc", { relay_public_key: movedKey, account: "acct", linked_at: "2026-10-02T00:00:00.000Z", link_moved_key: true, origin: at(5, "link") })]);
    start(a, b, true);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: undefined, cccccccccccccccc: undefined });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: undefined, cccccccccccccccc: undefined });
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

  test("P22: with the release flag off a twin keeps this folder's own origin as main does, never the sibling's", () => {
    const [a, b] = [dir(), dir()];
    put(a, [row("aaaaaaaaaaaaaaaa")]);
    put(b, [row("aaaaaaaaaaaaaaaa", { origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    start(a, b, false);
    expect(persisted(a)).toEqual({ aaaaaaaaaaaaaaaa: undefined });
    expect(persisted(b)).toEqual({ aaaaaaaaaaaaaaaa: undefined });
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

  test("P22: with the release flag off a merge keeps every row's origin as main does, and an unreadable origin is no age, not a bad registry", () => {
    const [a, b] = [dir(), dir()];
    put(a, []);
    put(b, [row("bbbbbbbbbbbbbbbb", { origin: { from: "remote", how: "code", by: null, admit_no: 1, at: AT } })]);
    start(a, b, false);
    expect(persisted(a)?.["bbbbbbbbbbbbbbbb"]).toMatchObject({ admit_no: 1 });
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
