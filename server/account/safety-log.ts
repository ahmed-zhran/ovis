/**
 * The PC's safety log (rule R2, row P24 of the account-opens-all design): blocks, freezes, lifts, locks, unlocks and
 * forgettings in one append-only, numbered file of this PC's own state, `account-log.json`. Entries are only ever
 * appended: none is edited or deleted, and an ending is a record of the same log that names what it ends. What is in
 * force (locked, the blocks, the freezes, the markers of blocks) is worked out from the log alone, at every open, and
 * is never kept anywhere as a second truth.
 *
 * Fails closed (S19 in its strict form): a log that cannot be read, that is missing from a state folder that keeps a
 * device journal, or that holds one id with two records, makes `strict` say why; a strict log appends nothing, so the
 * file it could not read is never written over. Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 *
 * One writer: the server process, through the one handle open() gives per folder. `ovis recover` and every other tool
 * change the log through the server's recovery socket (S2-15), never by writing this file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DeviceLiftRecord, PcLiftRecord, SafetyRecord, SafetyRecordKind } from "../../shared/account-records.ts";
import { parseLog, sameRecord, stageAppend, WAITING_MAX, type FoldedRecord, type LogFile, type SafetyAppend, type SafetyEntry, type SafetyReceipt, type SafetyState, type WaitingBlock, type WaitingRecord } from "./safety-log-file.ts";
export { WAITING_MAX, type BlockAsOf, type FoldedRecord, type SafetyEntry, type SafetyGot, type SafetyReceipt, type SafetyState, type WaitingBlock } from "./safety-log-file.ts";
import { privateStateRefusal, writePrivateState } from "../private-state.ts";

export const SAFETY_LOG_FILE = "account-log.json";
/** The device journal (P15, S2-07). A state folder that has one has had a log since, so a missing log there is damage. */
export const DEVICE_JOURNAL_FILE = "device-journal.json";


/** The id of a record this PC writes: random, made then, in the form shared/account-records.ts accepts. */
export function pcRecordId(): string {
  return randomBytes(16).toString("hex");
}


/**
 * Why another account may have written the log, or null: owned by another uid, or group- or other-writable. Such a
 * file is refused as it is, never repaired, since what it holds may already be someone else's (S19).
 */
function writableByOthers(path: string): string | null {
  if (process.platform === "win32") return null;
  let stats: Stats;
  try { stats = statSync(path); } catch { return null; }
  if (stats.uid !== process.getuid?.()) return `it is owned by uid ${stats.uid}`;
  return (stats.mode & 0o022) !== 0 ? `another account can write it (chmod 600 ${path} once it is known to be this PC's own)` : null;
}

/** What a strict log reads as: locked, so nothing that reads it before checking `strict` takes it as open. */
const STRICT_STATE: SafetyState = { locked: true, locks: [], blocks: [], freezes: [], markers: [] };

/** The one handle of each folder's log in this process (P24: one writer, one numbering). */
const HANDLES = new Map<string, SafetyLog>();

export class SafetyLog {
  private file: LogFile = { v: 1, next: 1, base: [], entries: [], waiting: [] };
  private readError: string | null = null;
  private writeError: string | null = null;

  /** What is in force, worked out at open and after every append: the replay runs before anything is served (T41). */
  inForce: SafetyState = { locked: false, locks: [], blocks: [], freezes: [], markers: [] };

  private constructor(private readonly path: string, private readonly stateDir: string) {}

  /**
   * The one handle of `stateDir`'s log in this process, read and replayed again from disk: a second open is the same
   * handle, so no two handles of one folder ever give numbers. Never throws: a log that cannot be trusted makes
   * `strict` say why, and so does `mergeProblem`, a merge with a sibling folder that could not be made (mergeSafetyLogs).
   */
  static open(stateDir: string, mergeProblem: string | null = null): SafetyLog {
    const path = resolve(stateDir, SAFETY_LOG_FILE);
    const log = HANDLES.get(path) ?? new SafetyLog(path, stateDir);
    HANDLES.set(path, log);
    log.readError = mergeProblem;
    log.writeError = null;
    if (mergeProblem === null) log.load();
    else log.inForce = STRICT_STATE;
    return log;
  }

  /**
   * The server that held this folder's handle stopped: the next open starts a fresh one. One server per state folder
   * runs in a process (createServer), so the handle is not counted; two servers on one folder are not supported.
   */
  close(): void {
    if (HANDLES.get(this.path) === this) HANDLES.delete(this.path);
  }

  /** Reads the file as open() does; false, with the log strict, when it is missing where it must exist or untrusted. */
  private load(): boolean {
    this.inForce = STRICT_STATE;
    // PC-written endings carry no signature: a log another account could write ends blocks and locks with one line
    const refused = writableByOthers(this.path) ?? privateStateRefusal(this.path);
    if (refused !== null) { this.readError = `${this.path} cannot be trusted: ${refused}`; return false; }
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.readError = `Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(this.stateDir, DEVICE_JOURNAL_FILE))) this.readError = `${this.path} is missing beside the device journal`;
      else if (this.file.next !== 1 || this.file.waiting.length !== 0) this.readError = `${this.path} is missing after this PC wrote it`;
      else { this.inForce = this.state(); return true; }
      return false;
    }
    let parsed: LogFile | string;
    try { parsed = parseLog(JSON.parse(text)); } catch { parsed = "it is not JSON"; }
    if (typeof parsed === "string") { this.readError = `${this.path} cannot be trusted: ${parsed}`; return false; }
    this.file = parsed;
    this.inForce = this.state();
    return true;
  }

  /**
   * Why this PC fails closed, or null: nothing but this PC itself signs in until the log is put right. A failed append
   * counts until a reload finds the log whole (S19): nothing else is appended on this handle meanwhile.
   */
  get strict(): string | null {
    const why = this.readError ?? this.writeError;
    return why === null ? null : `${why}: only this PC itself gets in until the account safety log is restored.`;
  }

  entries(): readonly SafetyEntry[] { return this.file.entries; }

  /** Writes the log as it stands when there is no file yet: a folder with a journal always has one (P24). */
  ensureFile(): void {
    if (this.readError === null && !existsSync(this.path)) writePrivateState(this.path, this.file);
  }

  /** The ids of the `forget` records of `key` under `account`, folded ones included: what P13 asks of each removal. */
  forgets(key: string, account: string): string[] {
    return [...this.file.entries.map((entry) => entry.record), ...this.file.base]
      .filter((record) => record.kind === "forget" && record.target === key && record.account === account).map((record) => record.id);
  }

  /** The receipts of every block of `key` this log knows (T60): applied with its number while whole, already_applied once folded. */
  receipts(key: string): SafetyReceipt[] {
    const whole = this.file.entries.filter((entry) => entry.record.kind === "block" && entry.record.target === key).map((entry): SafetyReceipt => ({ outcome: "applied", id: entry.record.id, n: entry.n }));
    const folded = this.file.base.filter((line) => line.kind === "block" && line.target === key).map((line): SafetyReceipt => ({ outcome: "already_applied", id: line.id }));
    return [...whole, ...folded];
  }

  /**
   * The receipts of every block `key` signed that this log holds whole (T60 (2)): a refused sign-in of that key carries
   * them. A folded line keeps no signer, so a block folded here is no longer named this way.
   */
  receiptsBySigner(key: string, account?: string): Extract<SafetyReceipt, { outcome: "applied" }>[] {
    return this.file.entries.filter(({ record }) => record.kind === "block" && record.signer === key && (account === undefined || record.account === account)).map((entry) => ({ outcome: "applied", id: entry.record.id, n: entry.n }));
  }

  /** Every block id this log knows, whole or folded: a snapshot's blocks this PC already holds. */
  blockIds(): string[] {
    return [...this.file.entries.filter((entry) => entry.record.kind === "block").map((entry) => entry.record.id), ...this.file.base.filter((line) => line.kind === "block").map((line) => line.id)];
  }

  /**
   * The lock (P11): written by the log itself, signed `pc`, under the account this PC is bound to; refused with no
   * binding, since a PC in no account has no strict mode in this release.
   */
  appendLock(binding: { readonly account: string } | null): SafetyReceipt {
    if (binding === null) return { outcome: "refused", id: "", code: "record_invalid" };
    return this.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: binding.account, target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
  }

  /** Ends the lock `lockId` (P11, T47), written by the log itself like the lock. */
  appendUnlock(lockId: string, binding: { readonly account: string } | null): SafetyReceipt {
    if (binding === null) return { outcome: "refused", id: "", code: "record_invalid" };
    return this.append({ record: { v: 1, id: pcRecordId(), kind: "unlock", account: binding.account, target: lockId, signer: "pc", signed_at: new Date().toISOString(), signature: "" }, got: "pc" });
  }

  /** The receipt of a record this log holds (T51): the same `applied` as often as it is asked, until it is folded. */
  receipt(id: string): SafetyReceipt | null {
    const entry = this.file.entries.find((candidate) => candidate.record.id === id);
    if (entry !== undefined) return { outcome: "applied", id, n: entry.n };
    return this.file.base.some((line) => line.id === id) ? { outcome: "already_applied", id } : null;
  }

  /**
   * Appends one record with the next number, on disk before it counts. A record this log already holds answers its
   * receipt and appends nothing; another record under a known id is refused, and the log keeps what it holds.
   */
  append(input: SafetyAppend): SafetyReceipt {
    const draft = this.draft();
    const unavailable = { outcome: "refused", id: input.record?.id ?? "", code: "log_unavailable" } as const;
    if (draft === null) return unavailable;
    const receipt = stageAppend(draft, input);
    if (draft.next !== this.file.next && !this.publish(draft)) return unavailable;
    return receipt;
  }

  /** All accepted lifts and the disposition of their waiting records share one durable replacement. */
  commitLifts(lifts: readonly DeviceLiftRecord[], listed: readonly DeviceLiftRecord[]): number | Extract<SafetyReceipt, { outcome: "refused" }> {
    if (listed.length === 0 && lifts.length === 0) return 0;
    const unavailable = { outcome: "refused", id: lifts[0]?.id ?? listed[0]?.id ?? "", code: "log_unavailable" } as const;
    const draft = this.draft();
    if (draft === null) return unavailable;
    for (const record of lifts) {
      const receipt = stageAppend(draft, { record, got: "snapshot" });
      if (receipt.outcome === "refused") return receipt;
    }
    const decisions = new Map(listed.map((record) => [record.id, record]));
    draft.waiting = draft.waiting.filter(({ record }) => {
      const decision = decisions.get(record.id);
      return record.kind !== "lift" || !decision || !sameRecord(record, decision);
    });
    const added = draft.next - this.file.next;
    if ((added || draft.waiting.length !== this.file.waiting.length) && !this.publish(draft)) return unavailable;
    return added;
  }

  private draft(): LogFile | null {
    return this.strict === null && this.load() ? { ...this.file, entries: [...this.file.entries] } : null;
  }

  private publish(next: LogFile): boolean {
    try { this.writeFile(next); } catch (error) {
      this.writeError = `Cannot write ${this.path} (${error instanceof Error ? error.message : String(error)})`;
      this.inForce = STRICT_STATE;
      return false;
    }
    this.inForce = this.state();
    return true;
  }

  /** What is in force, worked out from the log alone. Each ending ends only the record it names, and only of its kind. */
  state(): SafetyState {
    // an ending names the record it ends under that record's own account, and ends nothing of another
    const at = (account: string, id: string) => `${account}\u0000${id}`;
    const lifted = new Set<string>();
    const forgotten = new Set<string>();
    const unlocked = new Set<string>();
    // a lift or an unlock already folded still ends what it names (P24)
    for (const line of this.file.base) {
      if (line.kind === "lift" && line.target !== null) lifted.add(at(line.account ?? "", line.target));
      else if (line.kind === "unlock" && line.target !== null) unlocked.add(at(line.account ?? "", line.target));
    }
    for (const { record } of this.file.entries) {
      if (record.kind === "lift") {
        lifted.add(at(record.account, record.target));
        if (record.signer === "pc" && (record as PcLiftRecord).forget) forgotten.add(at(record.account, record.target));
      } else if (record.kind === "unlock") unlocked.add(at(record.account, record.target));
    }
    const byN = [...this.file.entries].sort((a, b) => a.n - b.n);
    const of = (kind: SafetyRecordKind) => byN.filter((entry) => entry.record.kind === kind);
    const locks = of("lock").filter((entry) => !unlocked.has(at(entry.record.account, entry.record.id)));
    const blocks = of("block").filter((entry) => !lifted.has(at(entry.record.account, entry.record.id)));
    const serviceFreezes = of("freeze").filter((entry) => !lifted.has(at(entry.record.account, entry.record.id.slice(2))));
    return {
      locked: locks.length > 0,
      locks,
      blocks,
      freezes: [...blocks, ...serviceFreezes].sort((a, b) => a.n - b.n),
      markers: of("block").filter((entry) => !forgotten.has(at(entry.record.account, entry.record.id))),
    };
  }

  /**
   * Folds what nothing rests on into `base` (P24): only while no block, freeze or lock is in force. A block folds only
   * once a lift and a forgetting lift name it, so its marker can always be worked out from the log; a lock once an
   * unlock names it; a freeze once a lift names its block; a lift or an unlock with the record it names. Every ending
   * counts only under the account of the record it names. Returns how many entries folded.
   */
  fold(): number {
    if (this.readError !== null) return 0;
    const state = this.state();
    if (state.locked || state.blocks.length > 0 || state.freezes.length > 0) return 0;
    // an ending ends only the record it names under the same account, as state() reads it (P24)
    const at = (account: string, id: string) => `${account}\u0000${id}`;
    const enders = new Map<string, string[]>();
    const forgetting = new Set<string>();
    for (const { record } of this.file.entries) {
      if (record.kind === "lift" || record.kind === "unlock") enders.set(at(record.account, record.target), [...enders.get(at(record.account, record.target)) ?? [], record.id]);
      if (record.kind === "lift" && record.signer === "pc" && (record as PcLiftRecord).forget) forgetting.add(at(record.account, record.target));
    }
    const folds = new Set<string>();
    for (const { record } of this.file.entries) {
      const key = at(record.account, record.id);
      if (record.kind === "block" && enders.has(key) && forgetting.has(key)) folds.add(key);
      else if (record.kind === "lock" && enders.has(key)) folds.add(key);
      else if (record.kind === "freeze" && enders.has(at(record.account, record.id.slice(2)))) folds.add(key);
      else if (record.kind === "forget") folds.add(key);
    }
    for (const { record } of this.file.entries) {
      if ((record.kind !== "lift" && record.kind !== "unlock")) continue;
      const named = at(record.account, record.target);
      // a lift or an unlock folds only in the pass that folds the record it ends, whose body is here: a lift kept whole
      // still ends that block when a sibling folder brings it whole (P24, T48)
      if (folds.has(named)) folds.add(at(record.account, record.id));
    }
    if (folds.size === 0) return 0;
    const folded = (record: SafetyRecord) => folds.has(at(record.account, record.id));
    const base = [...this.file.base, ...this.file.entries.filter((entry) => folded(entry.record)).map(({ record }) => ({ id: record.id, kind: record.kind, account: record.account, target: record.target, ended_by: enders.get(at(record.account, record.id)) ?? enders.get(at(record.account, record.id.slice(2))) ?? [] }))];
    const next: LogFile = { ...this.file, base, entries: this.file.entries.filter((entry) => !folded(entry.record)) };
    writePrivateState(this.path, next);
    this.file = next;
    return folds.size;
  }

  waitingBlocks(): readonly WaitingBlock[] { return this.file.waiting.filter((item): item is WaitingBlock => "signer_removed" in item); }

  /** Keep undecided evidence, not an applied receipt. A full queue never evicts another request. */
  wait(item: WaitingRecord): boolean {
    if (this.strict !== null || !this.load()) return false;
    const known = this.file.waiting.find((kept) => kept.record.id === item.record.id);
    if (known) return sameRecord(known.record, item.record);
    // No number of handed lifts can take a waiting block's slot.
    if (this.file.waiting.filter((kept) => kept.record.kind === item.record.kind).length >= WAITING_MAX) return false;
    return this.publish({ ...this.file, waiting: [...this.file.waiting, item] });
  }

  /** A waiting block was judged: applied, or refused for good. */
  unwait(id: string): void {
    if (!this.file.waiting.some((kept) => kept.record.id === id)) return;
    this.writeFile({ ...this.file, waiting: this.file.waiting.filter((kept) => kept.record.id !== id) });
  }

  private writeFile(next: LogFile): void {
    writePrivateState(this.path, next);
    this.file = next;
  }

  /** The file as it stands, for a merge. */
  snapshot(): { readonly next: number; readonly base: readonly FoldedRecord[]; readonly entries: readonly SafetyEntry[]; readonly waiting: readonly WaitingRecord[] } { return this.file; }

  /** Why the log could not be trusted, without the strict tail, or null. */
  get reason(): string | null { return this.readError ?? this.writeError; }

  /** Whether the log could be read: a merge never writes over one it could not. */
  get readable(): boolean { return this.readError === null; }

}

/**
 * Merges the safety logs of two state folders at start, before anything is served (T48, P24): the union by id. Each
 * folder keeps the numbers of the records it holds and takes the other's after its last one, in the other's order,
 * with `got: merge` and the `asof` the other noted. What the PC added (`n`, `got`, `asof`) is never compared. A record
 * either folder folded is known and ended in both. One id with two different records is a damaged log: nothing is
 * written to either folder, and the returned reason makes the PC fail closed. Null when merged.
 */
export function mergeSafetyLogs(active: string, sibling: string): string | null {
  const [own, other] = [SafetyLog.open(active), SafetyLog.open(sibling)];
  // the sibling folder is no server's: its handle goes once the merge is made
  try {
    for (const [log, dir] of [[own, active], [other, sibling]] as const) {
      if (!log.readable) return `Cannot merge the account safety log of ${dir}: ${log.reason}`;
    }
    const [a, b] = [own.snapshot(), other.snapshot()];
    const records = new Map<string, SafetyRecord>();
    for (const entry of [...a.entries, ...b.entries]) {
      const known = records.get(entry.record.id);
      if (known !== undefined && !sameRecord(known, entry.record)) return `The account safety logs of ${active} and ${sibling} hold two different records under the id ${entry.record.id}`;
      records.set(entry.record.id, entry.record);
    }
    // folded lines under one id, in either folder, are one record only when they agree on what it was (T48)
    for (const line of a.base) {
      const theirs = b.base.find((other) => other.id === line.id);
      if (theirs !== undefined && (theirs.kind !== line.kind || theirs.account !== line.account || theirs.target !== line.target)) return `The account safety logs of ${active} and ${sibling} hold two different records under the id ${line.id}`;
    }
    // a folded line and a whole record under one id are one record only when they agree on what it was (T48)
    for (const line of [...a.base, ...b.base]) {
      const whole = records.get(line.id);
      if (whole !== undefined && (whole.kind !== line.kind || whole.account !== line.account || whole.target !== line.target)) return `The account safety logs of ${active} and ${sibling} hold two different records under the id ${line.id}`;
    }
    const base = [...a.base, ...b.base.filter((line) => !a.base.some((own) => own.id === line.id))];
    // one block noted in both folders (P21): the lower freeze line in both, and the signer not removed if either folder
    // saw it a member when the block arrived; `joined` and the numbers stay each folder's own, as admit_no is
    const lower = (x: number | null, y: number | null) => x === null ? y : y === null ? x : Math.min(x, y);
    const shared = new Map<string, { after: number | null; signer_removed: boolean }>();
    for (const entry of [...a.entries, ...b.entries]) {
      if (entry.asof === undefined) continue;
      const known = shared.get(entry.record.id);
      shared.set(entry.record.id, known === undefined ? { after: entry.asof.after, signer_removed: entry.asof.signer_removed }
        : { after: lower(known.after, entry.asof.after), signer_removed: known.signer_removed && entry.asof.signer_removed });
    }
    const strictest = (entry: SafetyEntry): SafetyEntry => entry.asof === undefined ? entry : { ...entry, asof: { ...entry.asof, ...shared.get(entry.record.id)! } };
    const folded = new Set(base.map((line) => line.id));
    const merged = (mine: typeof a, theirs: typeof a): LogFile => {
      const held = new Set(mine.entries.map((entry) => entry.record.id));
      let next = mine.next;
      const taken = [...theirs.entries].sort((x, y) => x.n - y.n)
        .filter((entry) => !held.has(entry.record.id) && !folded.has(entry.record.id))
        .map((entry) => ({ ...entry, n: next++, got: "merge" as const }));
      const waiting = [...mine.waiting, ...theirs.waiting.filter((item) => !mine.waiting.some((own) => JSON.stringify(own) === JSON.stringify(item)))];
      return { v: 1, next, base, entries: [...mine.entries.filter((entry) => !folded.has(entry.record.id)), ...taken].map(strictest), waiting };
    };
    const [forOwn, forOther] = [merged(a, b), merged(b, a)];
    const written: string[] = [];
    for (const [dir, file, before] of [[active, forOwn, a], [sibling, forOther, b]] as const) {
      if (JSON.stringify(file) === JSON.stringify({ v: 1, ...before })) continue;
      try { writePrivateState(join(dir, SAFETY_LOG_FILE), file); written.push(dir); } catch (error) {
        // a merge half written fails this PC closed rather than its start: what each dir holds stays a whole log
        return `Cannot write the merged account safety log into ${dir}${written.length ? ` (already written into ${written.join(", ")})` : ""}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  } finally { other.close(); }
}
