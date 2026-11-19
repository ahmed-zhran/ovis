import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-redeem-"));
  dirs.push(made);
  return made;
}
function store(at: string, opensAll = true): DeviceStore {
  if (!opensAll) return new DeviceStore(at);
  const log = SafetyLog.open(at);
  return new DeviceStore(at, null, null, { safety: log, pc: PcAccountState.open(at), removals: RemovalEvidence.open(at, log), journal: DeviceJournal.open(at, () => log.ensureFile()) });
}
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return exportAccountKey(pair.publicKey);
}

describe("a code redeemed now, its key admitted on the PC's screen later (S2-13 seams, T5, T72)", () => {
  test("T72: a reservation binds one code to one named key and commits only through every guard", async () => {
    const devices = store(dir());
    const [named, other] = [await key(), await key()];
    const { code } = devices.startPairing();
    // a wrong code spends a guess like today's pairing, and reserves nothing
    expect(devices.redeemCode("000000", "code", named)).toMatchObject({ ok: false });
    const redeemed = devices.redeemCode(code, "code", named);
    expect(redeemed).toMatchObject({ ok: true });
    const codeId = (redeemed as { codeId: string }).codeId;
    // nothing is written by the redemption, and the code's one use is taken
    expect(devices.list(null)).toHaveLength(0);
    expect(devices.redeemCode(code, "code", other)).toMatchObject({ ok: false });
    // another key, or another code id, admits nobody
    expect(devices.admitConfirmed({ codeId, key: other, label: "Other", source: "screen" })).toBeNull();
    expect(devices.admitConfirmed({ codeId: "f".repeat(32), key: named, label: "Phone", source: "screen" })).toBeNull();
    // the confirmed key gets the row, with an origin the store sets from where the confirm came from
    const admitted = devices.admitConfirmed({ codeId, key: named, label: "Phone", source: "screen" });
    expect(admitted).not.toBeNull();
    expect(devices.list(null).map((row) => row.id)).toEqual([admitted!.id]);
    // the use is spent: the same reservation admits nobody again
    expect(devices.admitConfirmed({ codeId, key: named, label: "Phone", source: "screen" })).toBeNull();
    // a late release of a reservation already taken frees nothing: the next code is the only way in again
    devices.releaseRedemption(codeId, named);
    expect(devices.redeemCode(code, "code", other)).toMatchObject({ ok: false });
    // a release must name both the code and the key; a second release of the same one is a no-op
    const next = devices.startPairing();
    const { codeId: nextId } = devices.redeemCode(next.code, "code", other) as { codeId: string };
    devices.releaseRedemption(nextId, named);
    expect(devices.redeemCode(next.code, "code", named)).toMatchObject({ ok: false, reason: "in_use" });
    devices.releaseRedemption(nextId, other);
    devices.releaseRedemption(nextId, other);
    const third = await key();
    const { codeId: thirdId } = devices.redeemCode(next.code, "code", third) as { codeId: string };
    devices.releaseRedemption(nextId, other);
    expect(devices.admitConfirmed({ codeId: thirdId, key: third, label: "Tablet", source: "screen" })).not.toBeNull();
  });

  test("T72: a released or restarted reservation admits nobody, and a removed key is refused at commit", async () => {
    const at = dir();
    const devices = store(at);
    const named = await key();
    const { code } = devices.startPairing();
    const { codeId } = devices.redeemCode(code, "code", named) as { codeId: string };
    devices.releaseRedemption(codeId, named);
    expect(devices.admitConfirmed({ codeId, key: named, label: "Phone", source: "screen" })).toBeNull();
    // a restart ends every reservation
    const second = store(at);
    const fresh = second.startPairing();
    const { codeId: id2 } = second.redeemCode(fresh.code, "code", named) as { codeId: string };
    expect(store(at).admitConfirmed({ codeId: id2, key: named, label: "Phone", source: "screen" })).toBeNull();
    // a key removed between the redemption and the confirm is refused in the commit turn
    const removed: string[] = [];
    second.onKeyRemoved((gone) => removed.push(gone));
    second.removeAccountKey(named, "acct_1", { id: "a".repeat(32), issuedAt: new Date().toISOString() });
    expect(removed).toEqual([named]);
    expect(second.admitConfirmed({ codeId: id2, key: named, label: "Phone", source: "screen" })).toBeNull();
  });

  test("P22: with the release flag off the seams take no code and pairRelay is today's", async () => {
    const devices = store(dir(), false);
    const named = await key();
    const { code } = devices.startPairing();
    expect(devices.redeemCode(code, "code", named)).toMatchObject({ ok: false });
    expect(devices.pairRelay(code, "Phone", named)).not.toBeNull();
  });
});
