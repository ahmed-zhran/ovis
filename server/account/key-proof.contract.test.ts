/**
 * A relay pairing that proves its key (device-row-states rows T71, T72, S31; the hub's and security-triage's S2-13
 * conditions), end to end through a relay session: HELLO with key-proof-1, PAIR, KEY_CHALLENGE, KEY_PROVE,
 * KEY_PENDING, and a row only when this PC's screen approves that very key.
 */
import { afterEach, expect, test } from "bun:test";
import { FrameType, KEY_PROOF_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { pairingPc, phone, SERVER_ID, type Pc } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(accountOpensAll: boolean) {
  const told: { pending: { id: string; action: { kind: string; pending?: string; fingerprint?: string } }[] }[] = [];
  let push!: (line: string) => void;
  const input = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  const made = await pairingPc({ server: { accountOpensAll, desktopOwner: { input, write: (line) => { told.push(JSON.parse(line)); } } } });
  pcs.push(made);
  const screen = {
    told,
    approve: (id: string) => push(`${JSON.stringify({ approve: id })}\n`),
    decline: (id: string) => push(`${JSON.stringify({ decline: id })}\n`),
    keyConfirm: () => told.at(-1)?.pending.find((entry) => entry.action.kind === "approve_key"),
  };
  return Object.assign(made, { screen });
}

/** A device that offers the proof: it pairs, answers the challenge, and reports what it saw. */
async function provingDevice(made: Pc, code: string) {
  const device = await phone();
  const link = await relayConnection(made);
  const challenge = deferred<string>();
  const pending = deferred<MuxFrame>();
  link.onFrame = (frame) => {
    if (frame.type === FrameType.KEY_CHALLENGE) challenge.resolve(frame.payload.challenge);
    if (frame.type === FrameType.KEY_PENDING) pending.resolve(frame);
  };
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  const sent = await bounded(challenge.promise);
  link.mux.sendSession({ type: FrameType.KEY_PROVE, flags: 0, stream_id: 0, payload: { signature: await signPairProof(SERVER_ID, sent, device.spki, device.keys.privateKey) } });
  return { device, link, challenge: sent, pending: bounded(pending.promise), fingerprint: await pairFingerprint(SERVER_ID, sent, device.spki) };
}

test("T71/T72: the device proves its key, waits, and is let in only when the PC's screen approves that key", async () => {
  const made = await pc(true);
  const code = await made.offerCode();
  const paired = await provingDevice(made, code);
  expect((await paired.pending).payload).toEqual({});
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
  const asked = made.screen.keyConfirm();
  expect(asked?.action).toEqual({ kind: "approve_key", pending: expect.any(String), fingerprint: paired.fingerprint });
  const admitted = deferred<void>();
  paired.link.onFrame = (frame) => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(); };
  made.screen.approve(asked!.id);
  await bounded(admitted.promise);
  expect(made.stored().find((row) => row.relay_public_key === paired.device.spki)).toBeDefined();
});

test("T72: a decline on the screen ends the pairing and lets nobody in", async () => {
  const made = await pc(true);
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  made.screen.decline(made.screen.keyConfirm()!.id);
  expect(await bounded(paired.link.serverError)).toBe("auth_failed");
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
});

test("T71: an app that does not offer the proof is refused key_proof_required, not left waiting", async () => {
  const made = await pc(true);
  const device = await phone();
  const link = await relayConnection(made);
  await link.hello();
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code: await made.offerCode(), label: "Old app", public_key: device.spki } });
  expect(await bounded(link.serverError)).toBe("key_proof_required");
});

test("T71: with the release flag off, pairing is today's: no challenge, the device is let in", async () => {
  const made = await pc(false);
  const device = await phone();
  const link = await relayConnection(made);
  const types: number[] = [];
  link.onFrame = (frame) => { types.push(frame.type); };
  const admitted = await link.pair(await made.offerCode(), device.spki);
  expect(admitted.device_id).toMatch(/^[0-9a-f]{16}$/);
  expect(types).not.toContain(FrameType.KEY_CHALLENGE);
});
