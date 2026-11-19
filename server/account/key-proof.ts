/**
 * Pairing by proving a key (docs/account.md, "Confirmed on this PC"), for a relay session on a PC with screen proof:
 * the device names its key with the code, the code is checked and one use of it held for that key, the PC then makes a
 * challenge, the device proves the key over it once, and waits until the PC's screen approves that very key by its
 * fingerprint. Only then is a row written, through Track A's admission (admitConfirmed), which sets the row's origin
 * from where the approval came. Every other ending gives the held use back.
 */
import type { DeviceMatch } from "../devices.ts";
import type { PendingRedemption, PendingRedemptions, PendingVia } from "./pending.ts";

/** The admission seams of server/devices.ts this flow uses (Track A, S2-08). */
export interface RedeemSeams {
  redeemCode(code: string, how: "code" | "qr", key: string): { ok: true; codeId: string; origin: "pc" | "relay" } | { ok: false; reason: string };
  releaseRedemption(codeId: string, key: string): void;
  admitConfirmed(confirm: { codeId: string; key: string; label: string; source: "screen" | "recover" }): DeviceMatch | null;
}

export type PairStart = { session: string; challenge: string } | { refuse: "key_proof_required" | "auth_failed" };
export type ProveResult = { pending: PendingRedemption } | { refuse: "auth_failed" };
export interface Decision { admitted: DeviceMatch | null }

interface Session { challenge: string; codeId: string; key: string; pendingId?: string; decide(decision: Decision): void; decided: Promise<Decision> }

export class KeyProofPairings {
  readonly #pending: PendingRedemptions;
  readonly #seams: RedeemSeams;
  readonly #sessions = new Map<string, Session>();
  readonly #byPending = new Map<string, string>();

  constructor(options: { pending: PendingRedemptions; seams: RedeemSeams }) {
    this.#pending = options.pending;
    this.#seams = options.seams;
    options.pending.onChange(() => this.#settleDropped());
  }

  /** A PAIR on a PC that needs the proof. A device that did not offer key-proof-1 is refused, never left waiting. */
  pair(request: { code: string; label: string; publicKey: string; how: "code" | "qr"; via: PendingVia; keyProof: boolean }): PairStart {
    if (!request.keyProof) return { refuse: "key_proof_required" };
    const redeemed = this.#seams.redeemCode(request.code, request.how, request.publicKey);
    if (!redeemed.ok) return { refuse: "auth_failed" };
    let named: { challenge: string };
    try { named = this.#pending.name(request.code, request.label, request.publicKey, request.via, undefined, redeemed.codeId); }
    catch {
      this.#seams.releaseRedemption(redeemed.codeId, request.publicKey);
      return { refuse: "auth_failed" };
    }
    const session = crypto.randomUUID();
    let decide!: (decision: Decision) => void;
    const decided = new Promise<Decision>((resolve) => { decide = resolve; });
    this.#sessions.set(session, { challenge: named.challenge, codeId: redeemed.codeId, key: request.publicKey, decide, decided });
    return { session, challenge: named.challenge };
  }

  /** The device's one proof over its challenge; a wrong one, or any second one, ends the pairing. */
  async prove(sessionId: string, signature: string): Promise<ProveResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.pendingId !== undefined) return this.#end(sessionId);
    const entry = await this.#pending.prove(session.challenge, signature);
    if (entry === null) return this.#end(sessionId);
    session.pendingId = entry.id;
    this.#byPending.set(entry.id, sessionId);
    return { pending: entry };
  }

  /** How the wait ends: the admitted row, or null. */
  decision(sessionId: string): Promise<Decision> {
    return this.#sessions.get(sessionId)?.decided ?? Promise.resolve({ admitted: null });
  }

  /**
   * The screen approved a waiting key by the fingerprint it showed (a confirm the caller has already used up). The
   * admission re-runs every guard; a refusal there admits nobody.
   */
  approve(pendingId: string, fingerprint: string, source: "screen" | "recover"): DeviceMatch | null {
    // taken out of the waiting list first, so the list's change does not end this session's wait as a drop
    const sessionId = this.#byPending.get(pendingId);
    this.#byPending.delete(pendingId);
    const entry = this.#pending.take(pendingId, fingerprint);
    if (entry === null || entry.codeId === undefined) {
      if (sessionId !== undefined && entry === null) this.#byPending.set(pendingId, sessionId);
      return null;
    }
    const admitted = this.#seams.admitConfirmed({ codeId: entry.codeId, key: entry.key, label: entry.label, source });
    if (admitted === null) this.#seams.releaseRedemption(entry.codeId, entry.key);
    if (sessionId !== undefined) this.#finish(sessionId, admitted);
    return admitted;
  }

  decline(pendingId: string): void {
    this.#pending.decline(pendingId);
  }

  /** The session ended (closed, timed out): whatever it held goes. */
  leave(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if (session.pendingId !== undefined) this.#pending.decline(session.pendingId);
    else this.#seams.releaseRedemption(session.codeId, session.key);
    this.#finish(sessionId, null);
  }

  #end(sessionId: string): { refuse: "auth_failed" } {
    const session = this.#sessions.get(sessionId);
    if (session !== undefined) {
      if (session.pendingId !== undefined) this.#pending.decline(session.pendingId);
      this.#finish(sessionId, null);
    }
    return { refuse: "auth_failed" };
  }

  #finish(sessionId: string, admitted: DeviceMatch | null): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    if (session.pendingId !== undefined) this.#byPending.delete(session.pendingId);
    session.decide({ admitted });
  }

  /** A waiting entry the store dropped (declined, expired, its key removed) ends its session's wait. */
  #settleDropped(): void {
    const waiting = new Set(this.#pending.list().map((entry) => entry.id));
    for (const [pendingId, sessionId] of [...this.#byPending]) if (!waiting.has(pendingId)) this.#finish(sessionId, null);
  }
}
