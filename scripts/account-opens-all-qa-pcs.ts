import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { RelayPcKey } from "../server/relay-pc.ts";
import { rotateRelayIdentity } from "../server/relay/identity.ts";
import type { createServer } from "../server/index.ts";
import type { RelayService } from "../server/relay/service.ts";
import { accountDeviceId, type BlockRecord, type DeviceLiftRecord } from "../shared/account-records.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { GLOBAL_APP } from "../shared/relay-regions.ts";
import { parseSnapshotPage } from "../shared/account-snapshot.ts";
import type { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { browserAccount } from "./account-opens-all-qa-browser.ts";

export function qaPcFixture(root: string, name: string) {
  const stateDir = mkdtempSync(join(root, "pc-"));
  const identity = rotateRelayIdentity(stateDir);
  return { name, stateDir, identity, id: identity.server_id, deviceId: randomBytes(8).toString("hex") };
}

type PcFixture = ReturnType<typeof qaPcFixture>;

type PcOptions = {
  readonly server: { readonly createServer: typeof createServer; readonly RelayService: typeof RelayService };
  readonly relayUrl: string;
  readonly accountUrl: string;
  readonly account: string;
  readonly connect?: (url: string) => WebSocket;
  readonly accountFetch?: (request: Request) => Promise<Response>;
};

export function startQaPc(target: PcFixture, key: string, options: PcOptions) {
  const { name, stateDir, deviceId } = target;
  const { server: { createServer, RelayService }, relayUrl, accountUrl, account, connect, accountFetch } = options;
  // Both PCs start bound with a legacy row, distinct from the browser sign-in key.
  const at = new Date().toISOString();
  const legacy = { id: deviceId, label: "Setup owner", role: "drive", account, token_hash: randomBytes(32).toString("hex"),
    relay_public_key: key, created_at: at, last_seen_at: null };
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [legacy] }), { mode: 0o600 });
  const relay = new RelayService({ stateDir, relay: relayUrl, app: GLOBAL_APP, accountService: accountUrl, ...(connect === undefined ? {} : { connect }) });
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false, machines: true, relay,
    ...(connect === undefined ? {} : { relayPcSocket: connect }),
    accountService: { url: accountUrl, ...(accountFetch === undefined ? {} : { fetch: accountFetch }) } });
  const base = `http://127.0.0.1:${app.port}`;
  const request = (path: string, body?: object): Promise<Response> => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const offer = async () => {
    const response = await request("/api/relay/offer", {});
    assert.equal(response.status, 200, `${name}: create relay offer`);
    const body: { url?: unknown } = await response.json();
    const link = typeof body.url === "string" ? decodeOffer(body.url) : null;
    assert.ok(link?.code, `${name}: offer did not carry a code`);
    return { ...link, name };
  };
  const stop = async () => { try { await relay.shutdown(); } finally { app.stop(); } };
  return { ...target, relay, request, offer, stop, services: app.context.services };
}

export function qaAccountWire(fake: FakeAccountService, googleClaims: boolean) {
  let queued: { readonly pcId: string; readonly block: BlockRecord } | undefined;
  let confirmedKey: string | undefined;
  return {
    queue(pcId: string, block: BlockRecord) { queued = { pcId, block }; },
    confirmTwoStep(key: string) { confirmedKey = key; },
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      const delivery = queued;
      const mailboxRequest = path === "/v1/pc/mailbox" && delivery !== undefined ? request.clone() : undefined;
      const response = await fake.fetch(request);
      if (!response.ok) return response;
      if (path === "/v1/pc/snapshot" && (googleClaims || confirmedKey !== undefined)) {
        const page = parseSnapshotPage(await response.json());
        return Response.json({ ...page, devices: page.devices.map((device) =>
          device.key === confirmedKey ? { ...device, provider: "google", two_step: "set" } :
          googleClaims ? { ...device, provider: "google", two_step: "unknown" } : device) });
      }
      if (mailboxRequest === undefined || delivery === undefined) return response;
      const body: unknown = await mailboxRequest.json();
      if (typeof body !== "object" || body === null || !("server_id" in body) || body.server_id !== delivery.pcId || queued !== delivery) return response;
      const page: unknown = await response.json();
      // The fake's legacy /v1/records writer cannot enqueue blocks. Add one signed
      // record to this PC's otherwise-empty, proof-checked mailbox response.
      assert.ok(typeof page === "object" && page !== null && "records" in page && Array.isArray(page.records));
      assert.equal(page.records.length, 0, "Expected the QA PC's mailbox to be empty before injecting the block");
      queued = undefined;
      return Response.json({ ...page, records: [{ seq: 1, record: delivery.block }] });
    },
  };
}

type QaPc = ReturnType<typeof startQaPc>;

export async function until(test: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await test())) {
    assert.ok(Date.now() < deadline, description);
    await Bun.sleep(50); // bounded observation, not a delay before asserting
  }
}

export async function listAndStartQaPc(target: QaPc, owner: { readonly page: Page; readonly account: string; readonly key: string },
  directory: { readonly relayUrl: string; readonly paths: string[] }): Promise<void> {
  assert.equal(target.services.devices.has(accountDeviceId(target.id, owner.key)), false, "Browser key was present before any list read");
  const path = `/v1/pcs/${target.id}`;
  await browserAccount(owner.page, owner.account, { kind: "put", path, entry: {
    label: target.name, public_key: Buffer.from(importPublicKey(target.identity.public_key)).toString("hex"), relay: directory.relayUrl,
  } });
  directory.paths.push(path);
  assert.equal((await target.request("/api/relay/start", {})).status, 200, `${target.name}: start relay`);
  await until(() => target.relay.status().phase === "online", `${target.name}: relay did not sync`);
  assert.equal((await target.services.accountMailbox.readSnapshot())?.committed, true, `${target.name}: account snapshot did not commit`);
}

export async function assertQueuedBlock(pc: QaPc, block: BlockRecord, register: () => void): Promise<void> {
  const { devices, safetyLog, accountMailbox } = pc.services;
  const row = accountDeviceId(pc.id, block.target);
  assert.ok(safetyLog, "The flag-on PC has no safety log");
  assert.equal(devices.has(row), false, "The key was admitted before the mailbox pull");
  await accountMailbox.pull();
  assert.ok(safetyLog.waitingBlocks().some(({ record, got }) => record.id === block.id && got === "mailbox"),
    `The PC did not queue the mailbox block before listing its target (${accountMailbox.error ?? "no mailbox error"})`);
  register();
  assert.equal((await accountMailbox.readSnapshot())?.committed, true, "Read the newly eligible key");
  assert.equal(safetyLog.receipt(block.id)?.outcome, "applied", "The waiting block did not apply in the list read");
  assert.equal(devices.removedByAccount(block.target), true, "No durable denial for the blocked key");
  assert.equal(devices.has(row), false, "The blocked key survived list admission");
}

export async function assertSnapshotLift(pc: QaPc, service: { readonly fake: FakeAccountService; readonly accountUrl: string },
  records: { readonly block: BlockRecord; readonly lift: DeviceLiftRecord }): Promise<void> {
  const { devices, safetyLog, accountMailbox } = pc.services;
  const { block, lift } = records;
  assert.ok(lift.signer_no < block.target_no, "The lift fixture needs an older signer");
  assert.ok(safetyLog, "The flag-on PC has no safety log");
  assert.ok(safetyLog.inForce.freezes.some(({ record }) => record.id === block.id), "The block is not in force before the lift");
  const token = service.fake.issueToken(block.account);
  for (const record of [block, lift]) {
    const response = await service.fake.fetch(new URL("/v1/safety-records", service.accountUrl), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ record }),
    });
    assert.ok(response.ok, `The fake rejected the signed ${record.kind}: ${await response.text()}`);
  }
  const outcome = await accountMailbox.readSnapshot();
  assert.deepEqual({ committed: outcome?.committed, refused: outcome?.committed ? outcome.liftsRefused : null },
    { committed: true, refused: 0 }, "The PC refused the account snapshot lift");
  assert.ok(safetyLog.entries().some(({ record, got }) => record.id === lift.id && got === "snapshot"), "No lift receipt from the snapshot");
  assert.equal(safetyLog.inForce.freezes.some(({ record }) => record.id === block.id), false, "The lift left the freeze in force");
  assert.equal(devices.removedByAccount(block.target), true, "The lift resurrected the removed key");
}

/** Pre-pair two disposable PCs so setup doesn't spend a code or require screen approval (S2-13). */
export async function qaRoster(desk: PcFixture, other: PcFixture, relay: string) {
  const id = randomUUID();
  const link = await RelayPcKey.create(join(desk.stateDir, "relay-pcs", `${id}.json`), {
    v: 1, server_id: other.id, server_public_key: other.identity.public_key, relay, name: other.name,
  }, () => true);
  const bridge = (await link.list())[0];
  assert.ok(bridge, "Create the PC-to-PC key");
  await link.update(other.id, () => ({ ...bridge, device_id: other.deviceId }));
  writeFileSync(join(desk.stateDir, "relay-pcs.json"), JSON.stringify([{
    id, name: other.name, kind: "relay", relay: { server_id: other.id, relay }, enabled: true, snapshot: null,
  }]), { mode: 0o600 });
  return { id, key: bridge.public_spki };
}
