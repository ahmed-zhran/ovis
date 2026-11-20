/**
 * S2-38, gate brief step 5. Use an empty, disposable staging account that signs in with Google.
 * OVIS_QA_GOOGLE_STATE is a private Playwright storage-state file with the QA Google login cookies;
 * the browser uses no existing Ovis session. Do not use your own account or check in that file.
 *
 *   TMPDIR=$HOME/.cache/ovis-tmp/s2-track-e OVIS_ACCOUNT_OPENS_ALL=1 \
 *   OVIS_ACCOUNT_SERVICE_URL=https://account-staging.devswha.workers.dev \
 *   OVIS_RELAY_URL=wss://<staging-relay> OVIS_QA_ACCOUNT_ID=<qa-account> \
 *   OVIS_QA_GOOGLE_STATE=<path> bun scripts/account-opens-all-e2e-qa.ts
 *
 * For loopback diagnostics use --local instead of staging env vars. It runs the Bun relay,
 * uses FakeAccountService and seeds only sign-in registration (absent in that fake).
 * Add --local-google-claims to supply the Google/unknown claims missing from fake snapshots.
 * It does not replace a staging run. The PC preconditions are legacy owner rows, not the
 * admission of either browser device. Only the script's two directory entries are deleted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { accountDeviceId, newRecordId, type BlockRecord } from "../shared/account-records.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { MachineRoster } from "../shared/machines.ts";
import { encodeOffer, isWssOrigin } from "../shared/relay-offer.ts";
import { GLOBAL_APP, GLOBAL_RELAY, REGIONAL_RELAYS } from "../shared/relay-regions.ts";
import { STAGING_ACCOUNT_SERVICE } from "../server/relay/service.ts";
import { keyFingerprint } from "../src/lib/deviceNotices.ts";
import { assertFingerprintDecline, browserAccount, browserSafetyRecord, withQaApp } from "./account-opens-all-qa-browser.ts";
import { assertQueuedBlock, assertSnapshotLift, listAndStartQaPc, qaAccountWire, qaPcFixture, qaRoster, startQaPc, until } from "./account-opens-all-qa-pcs.ts";
import { runOnOwnHerdr } from "./own-herdr.ts";
import { relayServerTree } from "./relay-browser-bridge.ts";
import { closeMarked } from "./relay-qa-teardown.ts";

const STEPS = ["List admission on PC B", "Google notice: two-step not confirmed",
  "Not me: roster forwards to PC B and B refuses", "Held refusal: wait card",
  "Fingerprint pairing: pending key and Decline", "Revoke all", "Queued block before list admission",
  "Lift by older two-step signer", "Lift by Google-unknown signer refused"] as const;
type Step = typeof STEPS[number];
const reported = new Set<Step>();
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
function report(step: Step, error?: string): void {
  reported.add(step);
  if (error === undefined) console.log(`PASS ${step}`);
  else { console.error(`FAIL ${step}: ${error}`); process.exitCode = 1; }
}
function skip(step: Step, reason: string): void {
  reported.add(step);
  console.log(`SKIP ${step}: ${reason}`);
}
async function check(step: Step, run: () => Promise<void>): Promise<void> {
  try { await run(); report(step); } catch (error) { report(step, failure(error)); }
}

function qaOptions() {
  const loopback = process.argv.includes("--local");
  const googleClaims = process.argv.includes("--local-google-claims");
  assert.ok(!googleClaims || loopback, "Only supply fake snapshot claims in loopback mode");
  const accountUrl = loopback ? "https://account.test" : process.env["OVIS_ACCOUNT_SERVICE_URL"];
  assert.ok(accountUrl, "Set OVIS_ACCOUNT_SERVICE_URL to the staging account service (or use --local)");
  assert.ok(loopback || accountUrl === STAGING_ACCOUNT_SERVICE, "Use the Ovis staging account service, never production");
  const relayUrl = loopback ? "wss://relay.test" : process.env["OVIS_RELAY_URL"];
  assert.ok(relayUrl && isWssOrigin(relayUrl) && ![GLOBAL_RELAY, ...REGIONAL_RELAYS].includes(new URL(relayUrl).origin), "Set OVIS_RELAY_URL to a non-production wss:// relay origin");
  const account = loopback ? "acct_s2_38_qa" : process.env["OVIS_QA_ACCOUNT_ID"];
  const storageState = loopback ? undefined : process.env["OVIS_QA_GOOGLE_STATE"];
  assert.ok(account && (loopback || storageState), "Set OVIS_QA_ACCOUNT_ID and OVIS_QA_GOOGLE_STATE for the disposable staging Google account");
  return { loopback, googleClaims, accountUrl, relayUrl, account, storageState };
}

async function runQa(root: string, options: ReturnType<typeof qaOptions>): Promise<void> {
  const { loopback, googleClaims, accountUrl, relayUrl, account, storageState } = options;
  Object.assign(process.env, { OVIS_ACCOUNT_OPENS_ALL: "1", OVIS_ACCOUNT_SERVICE_URL: accountUrl, OVIS_ACCOUNT_PROVIDERS: "google",
    OVIS_RELAY_STAGING: loopback ? "0" : "1", OVIS_TELEMETRY: "off" });

  await import("./test-herdr.ts");
  const server = await relayServerTree(join(import.meta.dir, ".."));
  const localRelay = loopback ? startBunRelay({ port: 0, hostname: "127.0.0.1" }) : undefined;
  const socketUrl = localRelay === undefined ? undefined : (input: string): string => {
    const url = new URL(input);
    return `ws://127.0.0.1:${localRelay.port}${url.pathname}${url.search}`;
  };
  const connect = socketUrl === undefined ? undefined : (url: string) => new WebSocket(socketUrl(url));
  const fake = loopback ? new FakeAccountService() : undefined;
  if (fake !== undefined) { fake.opensAll = true; fake.signInAs("google", account); }
  const wire = fake === undefined ? undefined : qaAccountWire(fake, googleClaims);
  const stopPcs: (() => Promise<void>)[] = [];

  const pc = (target: ReturnType<typeof qaPcFixture>, key: string) => {
    const started = startQaPc(target, key, { server, relayUrl, accountUrl, account,
      ...(connect === undefined ? {} : { connect }), ...(wire === undefined ? {} : { accountFetch: wire.fetch }) });
    stopPcs.push(started.stop);
    return started;
  };

  try {
    await withQaApp({ accountUrl, ...(socketUrl && fake ? { local: { account: fake, socketUrl } } : {}),
      ...(storageState === undefined ? {} : { storageState }) }, join(root, "shell"), async (open) => {
      const signIn = async (page: Page, localOrder: number, deferRegistration = false) => {
        await page.goto(`${GLOBAL_APP}/`);
        await page.getByRole("button", { name: "Continue with Google" }).click();
        await page.locator('[data-dashboard-mode="account"]').waitFor({ timeout: 75_000 });
        if (fake !== undefined) {
          const { key } = await browserAccount(page, account, { kind: "seed", no: localOrder });
          assert.ok(key, "Local sign-in key was not saved");
          if (!deferRegistration) assert.equal(fake.registerDevice(account, key, `QA device ${localOrder}`), localOrder);
          await page.reload();
        }
        const device = await browserAccount(page, account, { kind: "read" });
        assert.ok(device.key && typeof device.no === "number" && device.provider === "google", "Google sign-in did not register its sign-in key");
        return { key: device.key, no: device.no };
      };
      const owner = await open();
      const older = await signIn(owner, 1);
      wire?.confirmTwoStep(older.key);
      const desk = qaPcFixture(root, "S2-38 PC A"), other = qaPcFixture(root, "S2-38 PC B");
      const saved = await browserAccount(owner, account, { kind: "paired", pc: {
        server_id: desk.id, server_public_key: desk.identity.public_key, relay: relayUrl, device_id: desk.deviceId, label: "Setup owner", name: desk.name,
        account, account_enrollment: { account, state: "complete" },
      } });
      assert.ok(saved.key && saved.key !== older.key, "The PC A legacy key must differ from the owner's sign-in key");
      const roster = await qaRoster(desk, other, relayUrl);
      const b = pc(other, roster.key);
      const handlers = b.services.core.socketHandlers;
      const { open: openSocket, close: closeSocket } = handlers;
      const eventSockets = new Map<string, { readonly isOpen: () => boolean; closeCode?: number }>();
      const ownerRow = accountDeviceId(b.id, older.key);
      handlers.open = (peer) => {
        if (peer.data.deviceId === ownerRow) eventSockets.set(peer.data.connectionId, { isOpen: () => peer.readyState === WebSocket.OPEN });
        return openSocket(peer);
      };
      handlers.close = (peer, code, reason) => {
        const eventSocket = eventSockets.get(peer.data.connectionId);
        if (eventSocket !== undefined) eventSocket.closeCode = code;
        closeSocket(peer, code, reason);
      };
      const paths: string[] = [];
      const scope = (id: string) => `${GLOBAL_APP}/s/${id}/`;
      const inApp = (page: Page) => page.locator(".app").waitFor({ timeout: 45_000 });
      try {
        const listAndStart = (target: ReturnType<typeof pc>) => listAndStartQaPc(target, { page: owner, account, key: older.key }, { relayUrl, paths });
        await listAndStart(b);
        await check(STEPS[0], async () => {
          await owner.reload();
          await owner.locator(`[data-pc-id="${b.id}"] [data-pc-action="open"]`).first().click();
          await owner.waitForURL(scope(b.id));
          await inApp(owner);
          assert.ok(b.services.devices.has(ownerRow), "PC B never admitted the owner's registered sign-in key");
          await until(() => eventSockets.size > 0, "PC B never opened the owner's app event socket");
        });

        const a = pc(desk, saved.key);
        await listAndStart(a);
        await until(async () => {
          const { machines }: MachineRoster = await (await a.request("/api/machines")).json();
          return machines.some((machine) => machine.id === roster.id && machine.state === "connected");
        }, "PC A's roster did not connect to PC B through the relay");
        const [firstEventSocket] = eventSockets.values();
        if (firstEventSocket !== undefined) {
          const codes = [...eventSockets.values()].flatMap(({ closeCode }) => closeCode === undefined ? [] : [closeCode]);
          console.log(`${firstEventSocket.isOpen() && !codes.includes(1008) ? "PASS" : "FAIL"} PC B event socket: initial open=${firstEventSocket.isOpen()}, close codes=${JSON.stringify(codes)}`);
          if (!firstEventSocket.isOpen() || codes.includes(1008)) process.exitCode = 1;
        }
        await owner.goto(scope(a.id));
        await inApp(owner);

        if (fake !== undefined && wire !== undefined) {
          let block: BlockRecord | undefined;
          await check(STEPS[6], async () => {
            const queued = await open();
            try {
              const target = await signIn(queued, 2, true);
              const record = await browserSafetyRecord(owner, { v: 1, kind: "block", account, target: target.key,
                target_no: target.no, signer: older.key, signer_no: older.no, signed_at: new Date().toISOString(), nonce: newRecordId() });
              wire.queue(b.id, record);
              await assertQueuedBlock(b, record, () => {
                assert.equal(fake.registerDevice(account, target.key, "QA queued target"), target.no);
              });
              block = record;
              await queued.goto(scope(b.id));
              await queued.locator('[data-add-pc-mode="join"], main[data-relay-state="revoked"]').first().waitFor();
              assert.equal(await queued.locator(".app").count(), 0, "The queued block let the browser into PC B");
            } finally { await closeMarked(queued.context()); }
          });
          await check(STEPS[7], async () => {
            assert.ok(block, "The queued-block fixture did not apply");
            const lift = await browserSafetyRecord(owner, { v: 1, kind: "lift", account, target: block.id,
              signer: older.key, signer_no: older.no, signed_at: new Date().toISOString() });
            await assertSnapshotLift(b, { fake, accountUrl }, { block, lift });
          });
        } else {
          skip(STEPS[6], "This ordering fixture is loopback-only");
          skip(STEPS[7], "The fixture needs an older staging sign-in with confirmed two-step");
        }
        skip(STEPS[8], "Needs staging: the local fake checks eligibility, not the signer's Google two-step status");

        const newcomer = await open();
        const newer = await signIn(newcomer, loopback ? 3 : 2);
        assert.ok(newer.no > older.no && newer.key !== older.key, "The new Google sign-in needs a distinct, later key");
        const row = accountDeviceId(b.id, newer.key);
        assert.equal((await a.services.accountMailbox.readSnapshot())?.committed, true, "Read the new registration on PC A");
        const notice = owner.getByTestId("device-notice").filter({ hasText: `Key ${keyFingerprint(newer.key)}` });
        await check(STEPS[1], async () => {
          await notice.waitFor();
          const text = await notice.innerText();
          assert.match(text, googleClaims ? /Google sign-in, two-step sign-in not confirmed/i : /two-step sign-in not confirmed/i,
            "The admission notice omitted the expected unknown two-step status");
          console.log(`NOTICE ${text.split("\n").find((line) => /two-step sign-in not confirmed/i.test(line))}`);
        });
        await check(STEPS[3], async () => {
          assert.equal((await b.services.accountMailbox.readSnapshot())?.committed, true, "Read the new registration on PC B");
          await newcomer.goto(scope(b.id));
          await newcomer.locator(".join-wait").getByText(/opens in \d+ s|telling your other devices first/).waitFor();
        });
        await check(STEPS[2], async () => {
          await inApp(newcomer);
          assert.ok(b.services.devices.has(row), "PC B must allow this same device before the block");
          await notice.getByRole("button", { name: "Not me", exact: true }).click();
          await until(() => b.services.safetyLog?.entries().some(({ record, got }) => record.kind === "block" && record.target === newer.key && got === "handed") === true,
            "PC B did not record a handed block from the roster route (mailbox/snapshot delivery does not count)");
          assert.equal(b.services.devices.has(row), false, "The forwarded block left the device admitted on PC B");
          await newcomer.goto(scope(b.id));
          await newcomer.locator('[data-add-pc-mode="join"], main[data-relay-state="revoked"]').first().waitFor();
          assert.equal(await newcomer.locator(".app").count(), 0, "Blocked device reopened PC B");
        });

        await check(STEPS[4], async () => {
          const offer = encodeOffer(await a.offer(), GLOBAL_APP);
          await assertFingerprintDecline({ visitor: await open(), owner }, offer, a.request);
        });
        await check(STEPS[5], async () => {
          assert.ok(b.services.devices.has(accountDeviceId(b.id, older.key)), "PC B must have an account device to revoke");
          assert.equal((await b.request("/api/devices/revoke-all", {})).status, 200);
          assert.equal(b.services.devices.account(), null, "Revoke all did not clear PC B's binding");
          assert.equal(b.services.devices.has(accountDeviceId(b.id, older.key)), false, "Revoke all left PC B's account row admitted");
        });
      } finally {
        const cleanup = await Promise.allSettled(paths.map((path) => browserAccount(owner, account, { kind: "delete", path })));
        assert.ok(cleanup.every((result) => result.status === "fulfilled"), "Could not remove both QA directory entries; check the disposable staging account");
      }
    });
  } finally {
    try { await Promise.all(stopPcs.map((stop) => stop())); } finally { await localRelay?.stop(); }
  }
}

try {
  // Validate before starting the herdr harness. Never fall back to production or /tmp.
  const options = qaOptions();
  assert.ok(process.env["TMPDIR"] && !/^\/tmp(?:\/|$)/.test(tmpdir()), "Set TMPDIR to a directory under $HOME/.cache/ovis-tmp");
  const root = mkdtempSync(join(tmpdir(), "s238-"));
  try { await runOnOwnHerdr("S2-38 QA", () => runQa(root, options)); } finally { rmSync(root, { recursive: true, force: true }); }
} catch (error) {
  const why = failure(error);
  if (reported.size === STEPS.length) console.error(`S2-38 run error: ${why}`);
  for (const step of STEPS) if (!reported.has(step)) report(step, why);
  process.exitCode = 1;
}
