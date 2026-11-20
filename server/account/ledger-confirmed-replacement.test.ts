import { expect, onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore, readDeviceRegistry } from "../devices.ts";
import { ACCOUNT_ORDER_FILE, AccountOrder } from "./account-order.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const key = async () => exportAccountKey((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])).publicKey);

test("P21/H2: a screen-confirmed replacement records its first join and permanent member history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ledger-confirmed-replacement-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const account = "acct_1";
  const safety = SafetyLog.open(dir);
  const devices = new DeviceStore(dir, null, null, {
    pc: PcAccountState.open(dir),
    safety,
    removals: RemovalEvidence.open(dir, safety),
    journal: DeviceJournal.open(dir, () => safety.ensureFile()),
  });
  devices.attachAccountOrder(AccountOrder.open(dir));
  const [first, old, next] = await Promise.all([key(), key(), key()]);
  const paired = devices.pairRelay(devices.startPairing().code, "First", first);
  assert(paired);
  assert(devices.linkAccountKey(paired.device.id, first, first, account));
  const redeemed = devices.redeemCode(devices.startPairing().code, "code", old);
  assert(redeemed.ok);
  const approved = devices.admitConfirmed({ codeId: redeemed.codeId, key: old, label: "Second", source: "screen" });
  assert(approved);
  assert(devices.linkAccountKey(approved.id, old, next, account, "", false, true));

  expect(devices.replaceConfirmed({ row: approved.id, key: next, source: "screen" })).toMatchObject({ id: approved.id });
  const registry = readDeviceRegistry(join(dir, "devices.json"));
  assert(registry.kind === "ok");
  expect(registry.devices.find(row => row.id === approved.id)).toMatchObject({
    relay_public_key: next, account, origin: { admit_no: 3 },
  });

  const order: unknown = await Bun.file(join(dir, ACCOUNT_ORDER_FILE)).json();
  expect({ order, othersEver: PcAccountState.open(dir).othersEver() }).toMatchObject({
    order: { keys: { [next]: { joined: 3 } } },
    othersEver: true,
  });
});
