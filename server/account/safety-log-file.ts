/** On-disk safety-log format and the validation shared by replay and append. */
import { AccountRecordError, isDeviceSafetyRecord, parseSafetyRecord, type BlockRecord, type DeviceLiftRecord, type SafetyRecord, type SafetyRecordKind } from "../../shared/account-records.ts";

/** How the record reached this PC; noted once and never compared (P24). */
export type SafetyGot = "handed" | "mailbox" | "snapshot" | "pc" | "session" | "merge";

/** What this PC's own table said when a block arrived (P21), kept with the entry and never changed. */
export interface BlockAsOf {
  readonly signer_no: number | null;
  readonly target_no: number | null;
  readonly after: number | null;
  readonly joined: number | null;
  readonly signer_removed: boolean;
}

/**
 * An entry: the record whole as shared/account-records.ts parses it (a device-signed one with its signature, so its
 * signed bytes are those of the record and its id is their hash), and what this PC added once and never changes.
 */
export interface SafetyEntry {
  readonly n: number;
  readonly got: SafetyGot;
  readonly record: SafetyRecord;
  readonly asof?: BlockAsOf;
}

export type SafetyReceipt =
  | { outcome: "applied"; id: string; n: number }
  | { outcome: "already_applied"; id: string }
  | { outcome: "refused"; id: string; code: "record_invalid" | "conflict" | "log_unavailable" };

/** A block whose target this PC cannot place yet (P19): it ends nobody and waits for a read that names its target. */
export interface WaitingBlock { readonly record: BlockRecord; readonly got: SafetyGot; readonly signer_removed: boolean }
export interface WaitingLift { readonly record: DeviceLiftRecord; readonly got: "handed" }
export type WaitingRecord = WaitingBlock | WaitingLift;
export const WAITING_MAX = 64;

export interface SafetyState {
  readonly locked: boolean;
  readonly locks: readonly SafetyEntry[];
  readonly blocks: readonly SafetyEntry[];
  /** service freezes and blocks in force: each closes this PC to the keys newer than its target (P23) */
  readonly freezes: readonly SafetyEntry[];
  /** blocks whose marker stands: no lift that says `forget` names them, whether or not they are in force */
  readonly markers: readonly SafetyEntry[];
}

/** A folded record: known and ended, its signed bytes dropped, its id never forgotten (P24). */
export interface FoldedRecord {
  readonly id: string;
  readonly kind: SafetyRecordKind;
  readonly account: string | null;
  readonly target: string | null;
  readonly ended_by: readonly string[];
}

export interface LogFile {
  v: 1;
  next: number;
  /** folded records, one line each with no number: an id in it is known and ended (P24) */
  base: FoldedRecord[];
  entries: SafetyEntry[];
  /** P19's waiting blocks and T52's handed lifts have independent WAITING_MAX limits. */
  waiting: WaitingRecord[];
}

const GOTS: ReadonlySet<string> = new Set(["handed", "mailbox", "snapshot", "pc", "session", "merge"]);

const isNo = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Why `record` is no record of the log, or null: the shared parser decides, and a block keeps what this PC knew. */
function recordProblem(record: unknown, asof: BlockAsOf | undefined): string | null {
  let parsed: SafetyRecord;
  try { parsed = parseSafetyRecord(record); } catch (error) {
    if (error instanceof AccountRecordError) return error.message;
    throw error;
  }
  if (parsed.kind === "block") {
    if (asof === undefined) return "a block keeps what this PC knew when it arrived";
    const a = asof as unknown as Record<string, unknown>;
    if (typeof a !== "object" || a === null || Object.keys(a).length !== 5 || !isNo(a.signer_no) || !isNo(a.target_no) || !isNo(a.after) || !isNo(a.joined) || typeof a.signer_removed !== "boolean") return "invalid asof";
  } else if (asof !== undefined) return "only a block keeps asof";
  return null;
}

/** Two copies of one record: the same fields with the same values, whatever order JSON kept them in. */
export function sameRecord(a: SafetyRecord, b: SafetyRecord): boolean {
  const canonical = (record: SafetyRecord) => JSON.stringify(Object.entries(record).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
  return canonical(a) === canonical(b);
}

export function parseLog(value: unknown): LogFile | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not a log";
  const file = value as Partial<LogFile>;
  if (file.v !== 1) return "unknown version";
  if (!Number.isSafeInteger(file.next) || file.next! < 1) return "invalid next";
  if (!Array.isArray(file.base) || !file.base.every((line) => typeof line === "object" && line !== null && typeof line.id === "string")) return "invalid base";
  if (!Array.isArray(file.entries) || !Array.isArray(file.waiting)) return "invalid entries";
  let blocks = 0;
  let lifts = 0;
  for (const item of file.waiting) {
    if (!item || !GOTS.has(item.got)) return "invalid waiting record";
    if ("signer_removed" in item) {
      if (typeof item.signer_removed !== "boolean" || item.record?.kind !== "block" ||
        recordProblem(item.record, { signer_no: null, target_no: null, after: null, joined: null, signer_removed: false }) !== null) return "invalid waiting block";
      blocks++;
    } else {
      if (item.got !== "handed" || item.record?.kind !== "lift" || recordProblem(item.record, undefined) !== null || !isDeviceSafetyRecord(item.record)) return "invalid waiting lift";
      lifts++;
    }
  }
  if (blocks > WAITING_MAX || lifts > WAITING_MAX) return "too many waiting records";
  const seen = new Map<string, SafetyRecord>();
  const numbers = new Set<number>();
  for (const id of file.base.map((line) => line.id)) {
    if (seen.has(id)) return `the folded id ${id} is held twice`;
    seen.set(id, { id } as SafetyRecord);
  }
  // every number this log gave is a whole entry or a folded line: a history with numbers that account for nothing
  // is none this writer made (P24)
  if (file.next! - 1 > file.entries.length + file.base.length) return `next ${String(file.next)} accounts for more records than the log holds`;
  for (const entry of file.entries as SafetyEntry[]) {
    if (typeof entry !== "object" || entry === null) return "an entry is an object";
    if (!Number.isSafeInteger(entry.n) || entry.n < 1 || entry.n >= file.next! || numbers.has(entry.n)) return `entry number ${String(entry.n)} is taken twice or past next`;
    numbers.add(entry.n);
    if (!GOTS.has(entry.got)) return "invalid got";
    const problem = recordProblem(entry.record, entry.asof);
    if (problem !== null) return `entry ${entry.n}: ${problem}`;
    const known = seen.get(entry.record.id);
    // one id with two records is a damaged log; the same record twice is one record that was written twice
    if (known !== undefined) return `the id ${entry.record.id} is held ${sameRecord(known, entry.record) ? "twice" : "by two different records"}`;
    seen.set(entry.record.id, entry.record);
  }
  return file as LogFile;
}

export interface SafetyAppend { readonly record: SafetyRecord; readonly got: SafetyGot; readonly asof?: BlockAsOf }

/** Allocate numbers only on a private draft. A refused record never reaches the live log. */
export function stageAppend(draft: LogFile, { record, got, asof }: SafetyAppend): SafetyReceipt {
  const id = typeof record?.id === "string" ? record.id : "";
  if (!GOTS.has(got) || recordProblem(record, asof) !== null) return { outcome: "refused", id, code: "record_invalid" };
  const held = draft.entries.find((entry) => entry.record.id === id);
  if (held !== undefined) return sameRecord(held.record, record) ? { outcome: "applied", id, n: held.n } : { outcome: "refused", id, code: "conflict" };
  if (draft.base.some((line) => line.id === id)) return { outcome: "already_applied", id };
  const n = draft.next++;
  draft.entries.push({ n, got, record: { ...record }, ...(asof === undefined ? {} : { asof: { ...asof } }) });
  return { outcome: "applied", id, n };
}
