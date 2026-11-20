import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { privateStateFs } from "../private-state.ts";
import { askRecovery } from "./recovery.ts";
import { parseEvidence } from "./removal-evidence.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const FUTURE = stamp(2 * DAY);
const REVOKED = stamp(2 * DAY + 1);
const id = "a".repeat(16);
const other = "b".repeat(16);
const account = "acct_1";
const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const row = (created_at = FUTURE, k = key(), rowId = id) => ({ id: rowId, label: "Phone", role: "drive", token_hash: "c".repeat(64), relay_public_key: k, created_at, last_seen_at: null });
const tomb = (key: string, removed_at: string, record_id = "local") => ({ key, account, removed_at, record_id });
const revoke = (key: string, at: string) => ({ id: createHash("sha256").update(`${key}\n${account}\n${at}`).digest("hex").slice(0, 32), key, account, at });
const dirs: string[] = [];
const apps = new Set<ReturnType<typeof createServer>>();
const posix = test.skipIf(process.platform === "win32");

beforeEach(() => setSystemTime(NOW));
afterEach(() => {
  setSystemTime();
  for (const app of apps) app.stop();
  apps.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir() {
  const path = mkdtempSync(join(tmpdir(), "ovis-restamp-"));
  dirs.push(path);
  return path;
}
const put = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value), { mode: 0o600 });
const bytes = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const registry = (dir: string, ...devices: ReturnType<typeof row>[]) => put(dir, "devices.json", { gate_closed_at: stamp(-DAY), devices });
const tombstones = (dir: string, ...tombstones: ReturnType<typeof tomb>[]) => put(dir, "account-tombstones.json", { v: 1, tombstones });
const evidence = (dir: string) => parseEvidence(JSON.parse(bytes(dir, "account-removed.json")));
const pending = (dir: string) => existsSync(join(dir, "restamp.json"));

function start(stateDir: string, siblingStateDir?: string) {
  const app = createServer({ stateDir, ...(siblingStateDir === undefined ? {} : { siblingStateDir }), accountOpensAll: true, port: 0, hostname: "127.0.0.1", tailscaleOwner: null, sidecar: false });
  apps.add(app);
  return { devices: app.context.services.devices, stop() { app.stop(); apps.delete(app); } };
}

async function queue(dir: string) {
  const preview = await askRecovery(dir, { act: "restamp" }) as { confirm?: string; error?: string };
  expect(preview).not.toHaveProperty("error");
  expect(preview.confirm).toBeString();
  expect(await askRecovery(dir, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
}

posix("restamp 1/12: a Revoke still denies, with one derived ID shared by both tombstone copies", async () => {
  const [active, sibling] = [dir(), dir()];
  const paired = row();
  const k = paired.relay_public_key;
  registry(active, paired);
  tombstones(active, tomb(k, REVOKED));
  tombstones(sibling, tomb(k, REVOKED));
  const ended = key();
  const endedRevoke = revoke(ended, stamp(2 * DAY + 2));
  const unrevoke = { id: "e".repeat(32), revoke: endedRevoke.id, at: stamp(2 * DAY + 3), by: "pc" };
  for (const folder of [active, sibling]) put(folder, "account-removed.json", {
    v: 1, markers: [], revokes: [revoke(k, REVOKED), endedRevoke], unrevokes: [unrevoke],
  });
  const closed = start(active, sibling);
  expect(closed.devices.failsClosed).toBe(true);
  const unchanged = ["devices.json", "account-tombstones.json", "account-removed.json", "account-pc.json", "account-log.json"];
  const before = unchanged.map((file) => bytes(active, file));
  await queue(active);
  expect(unchanged.map((file) => bytes(active, file))).toEqual(before);
  closed.stop();
  const restarted = start(active, sibling);
  expect(restarted.devices.failsClosed).toBe(false);
  expect(restarted.devices.hasKey(k)).toBe(false);
  const endedAfter = revoke(ended, stamp(3));
  for (const folder of [active, sibling]) {
    expect(evidence(folder)?.revokes).toEqual([revoke(k, stamp(2)), endedAfter]);
    expect(evidence(folder)?.unrevokes).toEqual([{ ...unrevoke, at: stamp(4), revoke: endedAfter.id }]);
  }
  expect(bytes(active, "account-tombstones.json")).toContain(stamp(2));
  expect(bytes(sibling, "account-tombstones.json")).toContain(stamp(2));
});

posix("restamp 1: refuse a new Revoke ID already occupied in the ledger", async () => {
  const active = dir();
  const k = key();
  registry(active, row());
  tombstones(active, tomb(k, REVOKED));
  put(active, "account-removed.json", {
    v: 1, markers: [], unrevokes: [],
    revokes: [revoke(k, REVOKED), { ...revoke(key(), stamp(-DAY)), id: revoke(k, stamp(2)).id }],
  });
  expect(start(active).devices.failsClosed).toBe(true);
  expect(await askRecovery(active, { act: "restamp" })).toMatchObject({ error: expect.stringMatching(/collide/) });
  expect(pending(active)).toBe(false);
});

posix("restamp 2/3/10: keep own values below the floor, including a past pairing denied by a later removal", async () => {
  const active = dir();
  const past = row(stamp(-HOUR));
  const soon = row(stamp(300_000), key(), other);
  const ahead = row(FUTURE, key(), "d".repeat(16));
  registry(active, past, soon, ahead);
  tombstones(active, tomb(past.relay_public_key, stamp(HOUR), "r"));
  const closed = start(active);
  await queue(active);
  expect(JSON.parse(bytes(active, "restamp.json"))).toMatchObject({
    base: stamp(HOUR), mapping: [{ old: FUTURE, new: stamp(HOUR + 1) }],
  });
  closed.stop();
  const restarted = start(active);
  expect(restarted.devices.failsClosed).toBe(false);
  expect(restarted.devices.hasKey(past.relay_public_key)).toBe(false);
  expect(restarted.devices.list(null).find(({ id }) => id === other)?.created_at).toBe(stamp(300_000));
  expect(restarted.devices.list(null).find(({ id }) => id === ahead.id)?.created_at).toBe(stamp(HOUR + 1));
});

posix.each([
  ["a malformed own timestamp", "not ISO", null, /malformed|ISO/i],
  ["an unreadable safety log", FUTURE, "account-log.json", /log/i],
  ["a non-own time more than a day ahead", FUTURE, "account-tombstones.json", /elsewhere|non-own/i],
] as const)("restamp 4/11: refuse %s", async (_name, at, file, message) => {
  const active = dir();
  registry(active, row(at));
  if (file === "account-log.json") put(active, file, false);
  if (file === "account-tombstones.json") tombstones(active, tomb(key(), stamp(DAY + 1), "r"));
  expect(start(active).devices.failsClosed).toBe(true);
  expect(await askRecovery(active, { act: "restamp" })).toMatchObject({ error: expect.stringMatching(message) });
  expect(pending(active)).toBe(false);
});

posix("restamp 5: resume a partial rewrite without changing the approved timestamps", async () => {
  for (const partial of [false, true]) {
    const active = dir();
    const k = key();
    registry(active, row());
    tombstones(active, tomb(k, REVOKED));
    const closed = start(active);
    await queue(active);
    closed.stop();
    if (partial) {
      const { devices } = JSON.parse(bytes(active, "devices.json")) as { devices: ReturnType<typeof row>[] };
      registry(active, ...devices.map((device) => ({ ...device, created_at: stamp(1) })));
    }
    setSystemTime(NOW + 600_000);
    const restarted = start(active);
    expect(restarted.devices.failsClosed).toBe(false);
    expect(restarted.devices.list(null)[0]?.created_at).toBe(stamp(1));
    expect(evidence(active)?.revokes).toEqual([revoke(k, stamp(2))]);
    setSystemTime(NOW);
  }
});

posix("restamp 6: a later non-own time invalidates a plan without rewriting any timestamp", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const before = bytes(active, "devices.json");
  tombstones(active, tomb(key(), stamp(HOUR), "late"));
  const restarted = start(active);
  expect(restarted.devices.failsClosed).toBe(true);
  expect(restarted.devices.accountError).toContain("ovis recover --restamp again");
  expect(bytes(active, "devices.json")).toBe(before);
  expect(pending(active)).toBe(true);
  expect(bytes(active, "device-journal.json")).toContain("restamp refused");
  await queue(active);
  restarted.stop();
  const repaired = start(active);
  expect(repaired.devices.failsClosed).toBe(false);
  expect(repaired.devices.list(null)[0]?.created_at).toBe(stamp(HOUR + 1));
});

posix.each(["newer", "non-own", "bad shape", "unsafe"] as const)("restamp 7: fail closed over a %s plan", async (damage) => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  await queue(active);
  closed.stop();
  const file = "restamp.json";
  const plan = JSON.parse(bytes(active, file));
  if (damage === "unsafe") {
    rmSync(join(active, file));
    mkdirSync(join(active, file));
  } else {
    if (damage === "newer") plan.mapping[0].new = stamp(3 * DAY);
    if (damage === "non-own") plan.mapping[0].field = "last_seen_at";
    if (damage === "bad shape") plan.extra = true;
    put(active, file, plan);
  }
  const before = bytes(active, "devices.json");
  const restarted = start(active);
  expect(restarted.devices.failsClosed).toBe(true);
  expect(restarted.devices.accountError).toContain("restamp.json");
  expect(bytes(active, "devices.json")).toBe(before);
  expect(pending(active)).toBe(true);
});

posix("restamp 8: the asked audit reaches disk before publishing the plan, and applied is recorded at startup", async () => {
  const active = dir();
  registry(active, row());
  const closed = start(active);
  const rename = privateStateFs.renameSync;
  let journalAtPublish = "";
  privateStateFs.renameSync = (from, to) => {
    if (to === join(active, "restamp.json")) journalAtPublish = bytes(active, "device-journal.json");
    rename(from, to);
  };
  try { await queue(active); } finally { privateStateFs.renameSync = rename; }
  expect(journalAtPublish).toContain("restamp asked");
  expect(journalAtPublish).not.toContain("restamp applied");
  closed.stop();
  start(active);
  expect(pending(active)).toBe(false);
  expect(existsSync(join(active, "restamp-done.json"))).toBe(true);
  expect(bytes(active, "device-journal.json")).toContain("restamp applied");
});
