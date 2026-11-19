/**
 * The PC's own account state (P12, OD1): `account-pc.json` `{v, next_admit, binding, clears, first, others_ever}`.
 * The PC's account is this file's binding, not "some row names an account": the first link binds it in the turn that
 * writes its row (T13, T59), the last member leaving changes nothing (T30), and only Revoke all, a relay identity
 * reset or a person at the PC clears it. A clear is kept in `clears`, which is never cut, and the file is never deleted.
 * `next_admit` numbers the admissions on this PC (P22, server/account/admission-order.ts).
 *
 * Fails closed (S19): a file that cannot be read, that is missing beside a device journal, or rows of two accounts at
 * the one-time migration (T50). Read only while OVIS_ACCOUNT_OPENS_ALL is on.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { ADMISSION_FILE, type OriginFrom, type OriginHow, type RowOrigin } from "./admission-order.ts";
import { DEVICE_JOURNAL_FILE } from "./safety-log.ts";

export type ClearReason = "revoke_all" | "identity_reset" | "left_on_pc";
export interface AccountClear { readonly bind_id: string; readonly reason: ClearReason; readonly by: string }
export interface AccountBinding { readonly account: string; readonly bind_id: string }

interface PcDoc {
  v: 1;
  next_admit: number;
  binding: AccountBinding | null;
  clears: AccountClear[];
  /** the first-device fact (T67): the key of the row whose link bound the PC; `list_key` only when a link proved it */
  first: { key: string; list_key: string | null } | null;
  /** set by the first admission of another account row and never unset (H2) */
  others_ever: boolean;
  /** P14: raised by every denial and policy change; a decision that widens commits only at the gen it noted */
  gen: number;
}

const REASONS: ReadonlySet<string> = new Set(["revoke_all", "identity_reset", "left_on_pc"]);
const ID = /^[0-9a-f]{32}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

function parseDoc(value: unknown): PcDoc | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not this PC's account state";
  const doc = value as Partial<PcDoc>;
  if (doc.v !== 1) return "unknown version";
  if (!Number.isSafeInteger(doc.next_admit) || doc.next_admit! < 1) return "invalid next_admit";
  const binding = doc.binding;
  if (binding !== null && !(typeof binding === "object" && binding !== undefined && ACCOUNT.test(binding.account) && ID.test(binding.bind_id))) return "invalid binding";
  if (!Array.isArray(doc.clears) || !doc.clears.every((clear) => typeof clear === "object" && clear !== null && ID.test(clear.bind_id) && REASONS.has(clear.reason) && typeof clear.by === "string")) return "invalid clears";
  if (binding !== null && doc.clears.some((clear) => clear.bind_id === binding.bind_id)) return "a cleared binding stands";
  const first = doc.first;
  if (first !== null && !(typeof first === "object" && first !== undefined && typeof first.key === "string" && (first.list_key === null || typeof first.list_key === "string"))) return "invalid first";
  if (typeof doc.others_ever !== "boolean") return "invalid others_ever";
  if (doc.gen === undefined) return { ...doc, gen: 0 } as PcDoc;
  if (!Number.isSafeInteger(doc.gen) || doc.gen < 0) return "invalid gen";
  return doc as PcDoc;
}

export class PcAccountState {
  private doc: PcDoc = { v: 1, next_admit: 1, binding: null, clears: [], first: null, others_ever: false, gen: 0 };
  private problem: string | null = null;
  /** no file and no journal: this folder's rows predate the release, and are migrated once (T50) */
  private fresh = false;

  private constructor(private readonly path: string) {}

  static open(stateDir: string): PcAccountState {
    const state = new PcAccountState(join(stateDir, ADMISSION_FILE));
    let text: string;
    try { text = readFileSync(state.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") state.problem = `Cannot read ${state.path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
      else if (existsSync(join(stateDir, DEVICE_JOURNAL_FILE))) state.problem = `${state.path} is missing beside the device journal`;
      else state.fresh = true;
      return state;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { state.problem = `${state.path} is not JSON`; return state; }
    const parsed = parseDoc(value);
    if (typeof parsed === "string") state.problem = `${state.path} cannot be trusted: ${parsed}`;
    else state.doc = parsed;
    return state;
  }

  /** Why this PC fails closed, or null: no device gets in while its account state cannot be known. */
  get strict(): string | null {
    return this.problem === null ? null : `${this.problem}: only this PC itself gets in until the account state is restored.`;
  }

  get migrating(): boolean { return this.fresh && this.problem === null; }

  /**
   * The migration's check, before any row is touched: the rows' accounts. Rows of two accounts name no binding to
   * take, so the PC fails closed and nothing is written (T50).
   */
  migrationAccount(rows: readonly { account?: string | undefined }[]): string | null {
    const accounts = new Set(rows.flatMap((row) => row.account === undefined ? [] : [row.account]));
    if (accounts.size > 1) this.problem = `${this.path} is missing and this PC's devices name ${accounts.size} accounts`;
    return accounts.size === 1 ? [...accounts][0]! : null;
  }

  /** Ends the migration, once: a PC with rows has had other devices, so it never takes the first-device path (T67). */
  migrate(account: string | null, hadRows: boolean): void {
    if (!this.migrating) return;
    this.write({ ...this.doc, binding: account === null ? null : { account, bind_id: randomBytes(16).toString("hex") }, others_ever: hadRows });
    this.fresh = false;
  }

  account(): string | null { return this.doc.binding?.account ?? null; }

  binding(): AccountBinding | null { return this.doc.binding; }

  clears(): readonly AccountClear[] { return this.doc.clears; }

  gen(): number { return this.doc.gen; }

  /** A denial or a policy change reached the disk (P14): a decision that noted the old gen does not commit. */
  raiseGen(): void { this.write({ ...this.doc, gen: this.doc.gen + 1 }); }

  /** The first-device fact (T67): the key that bound the PC, and its proved sign-in key or null. */
  first(): { readonly key: string; readonly list_key: string | null } | null { return this.doc.first; }

  othersEver(): boolean { return this.doc.others_ever; }

  /** The first admission of another account row sets it; nothing unsets it (H2). */
  setOthersEver(): void {
    if (!this.doc.others_ever) this.write({ ...this.doc, others_ever: true });
  }

  /** The first link binds the PC; returns what takes this write back, should the row it belongs to not be written. */
  bind(account: string, key: string, listKey: string | null = null): () => void {
    if (this.doc.binding !== null) throw new Error("This PC is already in an account");
    const before = this.doc;
    this.write({ ...this.doc, binding: { account, bind_id: randomBytes(16).toString("hex") }, first: { key, list_key: listKey }, others_ever: this.doc.others_ever || this.doc.clears.length > 0 });
    return () => this.write(before);
  }

  /** The PC leaves its account: only for one of the three named reasons. The clear is kept, and the file stays. */
  clear(reason: ClearReason, by: string): boolean {
    const binding = this.doc.binding;
    if (binding === null) return false;
    this.write({ ...this.doc, binding: null, clears: [...this.doc.clears, { bind_id: binding.bind_id, reason, by }], gen: this.doc.gen + 1 });
    return true;
  }

  /** The origin of a row being admitted now; its number is on disk before the row is, so none is ever used twice. */
  admit(from: OriginFrom, how: OriginHow, by: string | null, now: number): RowOrigin {
    const admitNo = this.doc.next_admit;
    this.write({ ...this.doc, next_admit: admitNo + 1 });
    return { from, how, by, admit_no: admitNo, at: new Date(now).toISOString() };
  }

  private write(doc: PcDoc): void {
    if (this.problem !== null) throw new Error(this.strict!);
    writePrivateState(this.path, doc);
    this.doc = doc;
  }
}
