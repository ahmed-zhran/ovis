/**
 * The terminal screen's one line to herdr-core. It opens the core's socket itself
 * (socket-transport.ts) and never starts a core: a socket that is missing or that nobody listens
 * on is NoCore, and the launcher, not this link, decides whether to start one.
 *
 * Coming up on a new line: `hello` (protocol generation 1 and every method in SCREEN_METHODS, else
 * Incompatible, naming what is missing), `events.subscribe {}` unfiltered so that `doc` events
 * arrive too, its snapshot applied to a fresh core model, then both layout documents read; the link
 * is then Online in a new epoch. A `missed` on that line takes the same resync path: a fresh model
 * from its snapshot, events at or below its seq dropped, both documents read again, and no stream
 * closed.
 *
 * The line ends on an EOF, on an event stream hc closed or that sent what cannot be read, and after
 * LINE_SILENCE_MS without an event or heartbeat. Then every channel on it hears `connection_lost`,
 * the link is Offline, and a new line is tried after RECONNECT_FIRST_MS, doubling to
 * RECONNECT_MOST_MS. Nothing written on the old line is written again. Every call of the screen
 * goes through `call`, `hello` or `attach` and is refused with `offline` unless the link is Online,
 * so a call never opens a line by itself (an HcConnection would).
 *
 * Time is the caller's: the link reads the injected clock, names its deadlines (`deadlines`) and
 * acts on the due ones when the loop calls `fire`; it arms no timer of its own.
 */

import { type Channel, type ChannelHandlers, HcConnection, HcError, type HcTransport, type HelloInfo } from "../../server/herdr-core/connection.ts";
import { type CoreChange, coreModel, type HcEvent } from "../../server/herdr-core/core-model.ts";
import { type MissedSnapshot, openEventStream } from "../../server/herdr-core/event-stream.ts";
import type { DocGetResult, HcMethod, HcMethods, TerminalAttachParams } from "../../server/herdr-core/hc-api.generated.ts";
import { OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { LAYOUT_DOC } from "../../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { type Deadlines, LINE_SILENCE_MS, NO_DEADLINES, RECONNECT_FIRST_MS, RECONNECT_MOST_MS, setDeadline } from "../model/deadlines.ts";

/**
 * The calls the screen makes, which a core's hello must name: the event stream, documents, attach,
 * and reading, labelling, starting and closing terminals. `doc.set` is not among them: a core that
 * writes no documents still shows the screen, without layout edits (layout-ops.ts `layoutCalls`).
 */
export const SCREEN_METHODS = ["events.subscribe", "doc.get", "terminal.attach", "terminal.get", "terminal.label", "terminal.run", "terminal.kill", "terminal.rm"] as const satisfies readonly HcMethod[];

/** The documents read on every new line and after every `missed`: the Herdr app's layout, then Ovis's own. */
export const LINK_DOCS = [LAYOUT_DOC, OVIS_LAYOUT_DOC] as const;

/** The HcError kind every call gets while the link is not Online. */
export const OFFLINE = "offline";

/** The names under which the link's deadlines appear in `deadlines()`. */
export const RECONNECT_DEADLINE = "reconnect";
export const SILENCE_DEADLINE = "silence";

/**
 * Where the link stands:
 * - NoCore: no core listens on the socket (none was there, or the file is a dead core's); nothing is retried until `connect`;
 * - Connecting: a new line is being opened and brought up;
 * - Online: the line is up; `epoch` counts the lines that came up, from 1;
 * - Offline: the line ended; a new one is tried at `retryAt` on the caller's clock (null: closed by its owner, never again);
 * - Incompatible: the core cannot serve the screen (another protocol, or without `missing`); it is not tried again.
 */
export type LinkState =
  | { kind: "NoCore"; reason: string }
  | { kind: "Connecting" }
  | { kind: "Online"; epoch: number }
  | { kind: "Offline"; retryAt: number | null; reason: string }
  | { kind: "Incompatible"; reason: string; missing: string[] };

/**
 * What the link tells its owner, in the order it happened:
 * - `state`: the link's state changed;
 * - `snapshot`: the terminals as hc gave them, as a whole, in a fresh core model (`connect`: the
 *   first on a new line, `seq` its subscribe answer's; `missed`: hc's snapshot after events were
 *   lost). `changes` are only those of events read meanwhile: each terminal's own state is in `terminals`;
 * - `doc`: a layout document as read;
 * - `event`: one hc event above the snapshot's seq, and the change records the model made of it.
 * Each carries the epoch of the line it came from.
 */
export type LinkNotice =
  | { type: "state"; state: LinkState }
  | { type: "snapshot"; epoch: number; cause: "connect" | "missed"; seq: number; terminals: unknown[]; changes: CoreChange[] }
  | { type: "doc"; epoch: number; name: string; doc: DocGetResult }
  | { type: "event"; epoch: number; seq: number | null; event: HcEvent; changes: CoreChange[] };

export interface LinkOptions {
  /** the core's socket, as the entry worked it out (core-socket.ts `coreSocket`) */
  socket: string;
  /** the loop's clock, in ms */
  now: () => number;
  /** what each fresh core model is made with: one on every new line and after every `missed` */
  model: Parameters<typeof coreModel>[0];
  /** hears every notice, in order */
  notify: (notice: LinkNotice) => void;
  /** one attempt at the socket: socket-transport.ts's own, which a test may wrap */
  connect?: (path: string) => Promise<HcTransport>;
}

/** The link as the screen uses it; `call` and `hello` stand in for an HcConnection's (seen-label.ts, layout-ops.ts). */
export interface CoreLink {
  readonly state: LinkState;
  /** One attempt at a new line now, from NoCore (a core was started) or Offline (in place of the waiting retry). */
  connect(): void;
  /** Acts on what is due by the clock: a retry, or the end of a silent line. */
  fire(): void;
  /** When `fire` has something to do next: RECONNECT_DEADLINE while Offline, SILENCE_DEADLINE while Online. */
  deadlines(): Deadlines;
  call<M extends HcMethod>(method: M, params: HcMethods[M]["params"], timeoutMs?: number): Promise<HcMethods[M]["result"]>;
  hello(): Promise<HelloInfo>;
  /** Attaches on the current line; the channel hears `connection_lost` when that line ends, and is never reopened here. */
  attach(params: TerminalAttachParams, handlers: ChannelHandlers): Promise<{ result: HcMethods["terminal.attach"]["result"]; channel: Channel }>;
  /** Closes the event stream, then the line, and opens none again. */
  close(): Promise<void>;
}

/** What one line to the core holds. */
interface Line {
  readonly hc: HcConnection;
  /** set once, when the line ended or was given up: nothing of it is acted on after */
  over: boolean;
  hello: HelloInfo | null;
  events: Channel | null;
  /** 0 until the line's first resync is published */
  epoch: number;
  model: ReturnType<typeof coreModel> | null;
  /** events at or below this seq are in the model's snapshot already */
  floor: number;
  /** what the event stream said before the subscribe answer was applied, in order */
  early: ({ event: HcEvent; seq: number | null } | { missed: MissedSnapshot })[] | null;
  /** the newest resync on this line: an older one that settles later is dropped */
  round: number;
  /** notices made while a resync reads its documents, told once it is published */
  held: ((epoch: number) => LinkNotice)[] | null;
  docs: Map<string, DocGetResult>;
  /** when the event stream last brought a line */
  heardAt: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A link to the core at `options.socket`, connecting at once. */
export function openLink(options: LinkOptions): CoreLink {
  const link = new Link(options);
  link.connect();
  return link;
}

class Link implements CoreLink {
  private current: LinkState = { kind: "NoCore", reason: "not connected yet" };
  private line: Line | null = null;
  private epochs = 0;
  private delay = RECONNECT_FIRST_MS;
  /** the newest connect attempt: an older one that settles later comes to nothing */
  private attempt = 0;
  /** a line ended and no new one came up since: a failed attempt waits and tries again, instead of NoCore */
  private retrying = false;
  private closed = false;
  private readonly open: (path: string) => Promise<HcTransport>;

  constructor(private readonly options: LinkOptions) {
    this.open = options.connect ?? connectCoreSocket;
  }

  get state(): LinkState {
    return this.current;
  }

  connect(): void {
    if (this.closed || (this.current.kind !== "NoCore" && this.current.kind !== "Offline")) return;
    void this.newLine();
  }

  fire(): void {
    const now = this.options.now();
    const state = this.current;
    if (state.kind === "Offline" && state.retryAt !== null && now >= state.retryAt) {
      this.connect();
      return;
    }
    const line = this.line;
    if (state.kind === "Online" && line && now >= line.heardAt + LINE_SILENCE_MS) this.lineEnded(line, `herdr-core sent no event and no heartbeat for ${LINE_SILENCE_MS} ms`);
  }

  deadlines(): Deadlines {
    const state = this.current;
    if (state.kind === "Offline" && state.retryAt !== null) return setDeadline(NO_DEADLINES, RECONNECT_DEADLINE, state.retryAt);
    if (state.kind === "Online" && this.line) return setDeadline(NO_DEADLINES, SILENCE_DEADLINE, this.line.heardAt + LINE_SILENCE_MS);
    return NO_DEADLINES;
  }

  async call<M extends HcMethod>(method: M, params: HcMethods[M]["params"], timeoutMs?: number): Promise<HcMethods[M]["result"]> {
    return this.online().hc.call(method, params, timeoutMs);
  }

  async hello(): Promise<HelloInfo> {
    return this.online().hello!;
  }

  async attach(params: TerminalAttachParams, handlers: ChannelHandlers): Promise<{ result: HcMethods["terminal.attach"]["result"]; channel: Channel }> {
    return this.online().hc.open("terminal.attach", params, handlers);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.attempt++;
    const line = this.line;
    this.line = null;
    if (line && !line.over) {
      line.over = true;
      await line.events?.close();
      line.hc.close();
    }
    this.setState({ kind: "Offline", retryAt: null, reason: "the link was closed" });
  }

  /** The current line, when the link is Online; otherwise the call is refused. */
  private online(): Line {
    const line = this.line;
    if (this.current.kind !== "Online" || !line || line.over) throw new HcError(OFFLINE, `herdr-core is not reachable (${this.current.kind})`);
    return line;
  }

  private setState(state: LinkState): void {
    this.current = state;
    this.options.notify({ type: "state", state });
  }

  private async newLine(): Promise<void> {
    const attempt = ++this.attempt;
    this.setState({ kind: "Connecting" });
    let transport: HcTransport;
    try {
      transport = await this.open(this.options.socket);
    } catch (error) {
      if (attempt !== this.attempt) return;
      // no core there (`no_core`), or a socket that cannot be opened at all (`closed`): either way none to talk to
      if (this.retrying) this.retryLater(messageOf(error));
      else this.setState({ kind: "NoCore", reason: messageOf(error) });
      return;
    }
    if (attempt !== this.attempt) {
      transport.kill();
      return;
    }
    let handedOut = false;
    // the line's one transport: once it ended, an HcConnection call that would open another fails instead
    const hc = new HcConnection(() => {
      if (handedOut) throw new HcError(OFFLINE, "this line to herdr-core ended");
      handedOut = true;
      return transport;
    });
    const line: Line = { hc, over: false, hello: null, events: null, epoch: 0, model: null, floor: 0, early: [], round: 0, held: null, docs: new Map(), heardAt: this.options.now() };
    this.line = line;
    void transport.exited.then(() => this.lineEnded(line, "herdr-core's line ended"));

    let hello: HelloInfo;
    try {
      hello = await hc.hello();
    } catch (error) {
      if (error instanceof HcError && error.kind === "bad_hello") this.incompatible(line, error.message, []);
      else this.lineEnded(line, messageOf(error));
      return;
    }
    if (line.over) return;
    line.hello = hello;
    const missing = SCREEN_METHODS.filter((method) => !hello.methods.includes(method));
    if (missing.length > 0) {
      this.incompatible(line, `herdr-core ${hello.version} does not answer ${missing.join(", ")}`, missing);
      return;
    }

    let subscribed: Awaited<ReturnType<typeof openEventStream>>;
    try {
      subscribed = await openEventStream(hc, {
        event: (event, seq) => this.onEvent(line, event, seq),
        resync: (missed) => {
          if (!missed) this.lineEnded(line, "herdr-core's event stream ended or sent what cannot be read");
          else if (line.early) line.early.push({ missed });
          else void this.resync(line, missed);
        },
        tooLong: () => this.lineEnded(line, "herdr-core sent an event line over its size limit"),
        heard: () => { line.heardAt = this.options.now(); },
      });
    } catch (error) {
      this.lineEnded(line, messageOf(error));
      return;
    }
    if (line.over) return;
    line.events = subscribed.channel;
    const { seq, terminals } = subscribed.result as { seq: unknown; terminals: unknown };
    if (typeof seq !== "number" || !Array.isArray(terminals)) {
      this.lineEnded(line, "herdr-core answered events.subscribe without a snapshot");
      return;
    }
    // what came with or right after the answer: a `missed` among it is the newer snapshot
    const early = line.early ?? [];
    line.early = null;
    let lastMissed = -1;
    early.forEach((item, at) => { if ("missed" in item) lastMissed = at; });
    const base = lastMissed === -1 ? { seq, terminals } : (early[lastMissed] as { missed: MissedSnapshot }).missed;
    const settled = this.resync(line, base);
    for (const item of early.slice(lastMissed + 1)) if ("event" in item) this.onEvent(line, item.event, item.seq);
    await settled;
  }

  /**
   * The one resync path, for a new line's snapshot and for `missed`: a fresh core model from the
   * snapshot, then both documents read; what was learned meanwhile is told after them. The first
   * on a line makes the link Online in a new epoch.
   */
  private async resync(line: Line, snapshot: MissedSnapshot): Promise<void> {
    const round = ++line.round;
    line.floor = snapshot.seq;
    line.model = coreModel(this.options.model);
    const changes = line.model.seed(snapshot.terminals);
    const held: ((epoch: number) => LinkNotice)[] = [];
    line.held = held;
    let docs: DocGetResult[];
    try {
      docs = await Promise.all(LINK_DOCS.map((name) => line.hc.call("doc.get", { name })));
    } catch (error) {
      this.lineEnded(line, `herdr-core's layout documents could not be read: ${messageOf(error)}`);
      return;
    }
    if (line.over || round !== line.round) return;
    line.held = null;
    const cause = line.epoch === 0 ? "connect" : "missed";
    if (cause === "connect") {
      line.epoch = ++this.epochs;
      line.heardAt = this.options.now();
      this.delay = RECONNECT_FIRST_MS;
      this.retrying = false;
      this.setState({ kind: "Online", epoch: line.epoch });
    }
    const { epoch } = line;
    this.options.notify({ type: "snapshot", epoch, cause, seq: snapshot.seq, terminals: snapshot.terminals, changes });
    LINK_DOCS.forEach((name, at) => {
      line.docs.set(name, docs[at]!);
      this.options.notify({ type: "doc", epoch, name, doc: docs[at]! });
    });
    for (const notice of held) this.options.notify(notice(epoch));
  }

  private onEvent(line: Line, event: HcEvent, seq: number | null): void {
    if (line.over) return;
    if (line.early) {
      line.early.push({ event, seq });
      return;
    }
    if (seq !== null && seq <= line.floor) return;
    const changes = line.model!.event(event);
    this.tell(line, (epoch) => ({ type: "event", epoch, seq, event, changes }));
    const name = event.data?.["name"];
    const version = event.data?.["version"];
    if (event.type === "doc" && event.machine === undefined && (name === LAYOUT_DOC || name === OVIS_LAYOUT_DOC) && typeof version === "number" && version > (line.docs.get(name)?.version ?? -1)) {
      void this.readDoc(line, name);
    }
  }

  /** A layout document hc says changed, read again; an answer older than one already read is dropped. */
  private async readDoc(line: Line, name: string): Promise<void> {
    let doc: DocGetResult;
    try {
      doc = await line.hc.call("doc.get", { name });
    } catch (error) {
      this.lineEnded(line, `herdr-core's ${name} document could not be read: ${messageOf(error)}`);
      return;
    }
    if (line.over || doc.version <= (line.docs.get(name)?.version ?? -1)) return;
    line.docs.set(name, doc);
    this.tell(line, (epoch) => ({ type: "doc", epoch, name, doc }));
  }

  private tell(line: Line, notice: (epoch: number) => LinkNotice): void {
    if (line.held) line.held.push(notice);
    else this.options.notify(notice(line.epoch));
  }

  /**
   * The line is over, once: every channel on it hears `connection_lost` (HcConnection's close), and
   * the link waits to try a new one.
   */
  private lineEnded(line: Line, reason: string): void {
    if (line.over) return;
    line.over = true;
    line.held = null;
    line.hc.close();
    if (this.line !== line) return;
    this.line = null;
    this.retrying = true;
    this.retryLater(reason);
  }

  private retryLater(reason: string): void {
    const retryAt = this.options.now() + this.delay;
    this.delay = Math.min(this.delay * 2, RECONNECT_MOST_MS);
    this.setState({ kind: "Offline", retryAt, reason });
  }

  private incompatible(line: Line, reason: string, missing: string[]): void {
    line.over = true;
    line.hc.close();
    if (this.line === line) this.line = null;
    this.setState({ kind: "Incompatible", reason, missing });
  }
}
