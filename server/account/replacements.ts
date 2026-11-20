import type { LinkReplacement, ReplacementProof } from "../../shared/account-devices-api.ts";
import { pairFingerprint, verifyPairProof } from "../../shared/pair-fingerprint.ts";
import type { DeviceStore } from "../devices.ts";
import type { DeviceJournal } from "./device-journal.ts";
import { ConfirmsFullError, type LocalConfirms } from "./local-confirm.ts";
import { PENDING_MS } from "./pending.ts";

type Subject = { readonly row: string; readonly key: string; readonly label: string };
type Owner = { readonly deviceId: string; readonly sessionId: string; readonly serverId: string; readonly sessionKey: string };
interface Hold extends Subject {
  readonly challenge: string;
  readonly owner: Owner;
  readonly until: number;
  readonly timer: ReturnType<typeof setTimeout>;
  spent: boolean;
  screen?: string;
}

/** Track A owns the held key and its mutation. This PC owns the one connection and screen act that may authorize it. */
export class Replacements {
  readonly #holds = new Map<string, Hold>();

  constructor(private readonly devices: DeviceStore, private readonly confirms: LocalConfirms, private readonly journal: DeviceJournal) {
    for (const subject of journal.replacementSubjects()) {
      // A crash can land between the approved row write and clearing its audit subject.
      if (devices.sessionRow(subject.row)?.key === subject.key) journal.trackReplacement(subject.row, null);
      else this.#journalDrop(subject, "restart");
    }
  }

  #journalDrop(subject: Subject, how: string): void {
    this.journal.append({ kind: "drop", how, key: subject.key, no: null, row: subject.row, label: subject.label, by: "pc", account: null });
  }

  #end(hold: Hold, how?: string): void {
    if (this.#holds.get(hold.row) !== hold) return;
    try {
      if (how) this.#journalDrop(hold, how);
      else this.journal.trackReplacement(hold.row, null);
    } finally {
      // A failed audit write leaves its restart subject, never a usable challenge or screen approval.
      this.#holds.delete(hold.row);
      clearTimeout(hold.timer);
      if (this.devices.pendingReplacement(hold.row)?.challenge === hold.challenge) this.devices.declineReplacement(hold.row);
      if (hold.screen) this.confirms.withdraw(hold.screen);
    }
  }

  /** In the same turn as the verified link write; a same-key link has no new hold. */
  linked(owner: Owner, label: string, changedKey: boolean): LinkReplacement | undefined {
    const previous = this.#holds.get(owner.deviceId);
    if (previous) this.#end(previous, Date.now() >= previous.until ? "expired" : "superseded");
    const held = changedKey ? this.devices.pendingReplacement(owner.deviceId) : null;
    if (!held) return undefined;
    const until = held.at + PENDING_MS;
    const subject = { row: owner.deviceId, label, key: held.key };
    this.journal.trackReplacement(subject.row, subject);
    const timer = setTimeout(() => this.#end(hold, "expired"), Math.max(0, until - Date.now()));
    timer.unref();
    const hold: Hold = { ...subject, owner, until, challenge: held.challenge, spent: false, timer };
    this.#holds.set(subject.row, hold);
    return { challenge: held.challenge };
  }

  #live(hold: Hold): boolean {
    if (this.#holds.get(hold.row) !== hold) return false;
    if (Date.now() < hold.until && this.devices.pendingReplacement(hold.row)?.challenge === hold.challenge && this.devices.sessionRow(hold.row)?.key === hold.owner.sessionKey) return true;
    this.#end(hold, Date.now() >= hold.until ? "expired" : "superseded");
    return false;
  }

  async prove(owner: Owner, proof: ReplacementProof): Promise<204 | 403 | 410 | 503> {
    if (proof.row !== owner.deviceId) return 403;
    const hold = this.#holds.get(proof.row);
    if (!hold || !this.#live(hold) || hold.challenge !== proof.challenge) return 410;
    if (hold.owner.sessionId !== owner.sessionId || hold.owner.serverId !== owner.serverId || hold.owner.sessionKey !== owner.sessionKey) return 403;
    if (hold.spent) return 410;
    hold.spent = true;
    const valid = await verifyPairProof(owner.serverId, hold.challenge, hold.key, proof.signature);
    if (!this.#live(hold)) return 410;
    if (!valid) { this.#end(hold, "declined"); return 403; }
    const fingerprint = await pairFingerprint(owner.serverId, hold.challenge, hold.key);
    if (!this.#live(hold)) return 410;
    const action = { kind: "approve_replacement" as const, row: hold.row, fingerprint };
    try {
      hold.screen = this.confirms.request(action, { title: "Approve this device's new key", lines: [`${hold.label} replaces its key`, "Compare these characters with the ones shown on the device."] }, hold.until - Date.now()).id;
    } catch (error) {
      this.#end(hold, "declined");
      if (error instanceof ConfirmsFullError) return 503;
      throw error;
    }
    const id = hold.screen;
    void this.confirms.answer(id).then((answer) => {
      if (!this.#live(hold)) return;
      if (answer === "approved" && this.confirms.consume(id, action) && this.devices.replaceConfirmed({ row: hold.row, key: hold.key, source: "screen" })) this.#end(hold);
      else this.#end(hold, answer === "expired" ? "expired" : "declined");
    });
    return 204;
  }

  stop(): void { for (const hold of this.#holds.values()) this.#end(hold, "restart"); }
}
