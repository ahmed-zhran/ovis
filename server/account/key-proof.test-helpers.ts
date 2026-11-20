import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { FrameType, KEY_PROOF_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { phone, SERVER_ID, type Pc } from "./pairing.test-helpers.ts";

/** A device that offers the proof: it pairs, answers the challenge, and reports what it saw. */
export async function provingDevice(made: Pc, code: string) {
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
