import { describe, expect, it } from "bun:test";
import { HeadlessHost } from "../testing/headless-host.ts";

// The host's rules, run on the headless twin: it drives the same guard as the real host, with an
// in-memory terminal, a manual clock and signals delivered by the test. The byte strings are the
// contract and are written out here on purpose.
const ESC = "\x1b";
const ST = `${ESC}\\`;
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1006h${ESC}[>1u`;
const LEAVE = `${ESC}[<u${ESC}[?1006l${ESC}[?1002l${ESC}[?2004l${ESC}[?1004l${ESC}[?25h${ESC}[?1049l`;
const AGAIN = `${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1006h${ESC}[=1;1u`;
const PROBE = `${ESC}[?u${ESC}[?2026$p${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}]12;?${ST}${ESC}[16t${ESC}[c`;
const ANSWER = `${ESC}[?1u${ESC}[?2026;2$y${ESC}]10;rgb:1111/2222/3333${ST}${ESC}]11;rgb:0000/0000/0000${ST}${ESC}]12;rgb:ffff/ffff/ffff${ST}${ESC}[6;18;9t${ESC}[?62;22c`;

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const text = (data: Uint8Array) => new TextDecoder().decode(data);

function inputs(host: HeadlessHost): string[] {
  const seen: string[] = [];
  host.onInput((bytes) => seen.push(text(bytes)));
  return seen;
}

describe("enter and leave", () => {
  it("turns raw mode on first, then writes the modes in one write, and leave undoes them in reverse, raw mode last", () => {
    const host = new HeadlessHost();
    expect(host.enter()).toBe(true);
    expect(host.log()).toEqual(["raw on", `write ${ENTER}`]);
    host.leave();
    expect(host.log()).toEqual(["raw on", `write ${ENTER}`, `write ${LEAVE}`, "raw off"]);
    expect(host.hooked()).toBe(false);
  });

  it("leaves once however often it is asked, and on the process's exit after a leave does nothing more", () => {
    const host = new HeadlessHost();
    host.enter();
    host.leave();
    host.leave();
    host.processExit();
    expect(count(host.output(), LEAVE)).toBe(1);
    expect(host.log().filter((entry) => entry === "raw off")).toHaveLength(1);
  });

  it("leaves on the process's exit (a thrown error or process.exit) when nobody called leave", () => {
    const host = new HeadlessHost();
    host.enter();
    host.processExit();
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(host.log().at(-1)).toBe("raw off");
  });

  it("a second enter changes nothing; enter after leave is refused; leave without enter writes nothing", () => {
    const host = new HeadlessHost();
    host.leave();
    expect(host.log()).toEqual([]);
    expect(host.enter()).toBe(true);
    expect(host.enter()).toBe(true);
    expect(count(host.output(), ENTER)).toBe(1);
    host.leave();
    expect(host.enter()).toBe(false);
    expect(host.output()).toBe(ENTER + LEAVE);
  });

  it("nothing is entered when stdin or stdout is not a terminal", async () => {
    const host = new HeadlessHost({ terminal: false });
    expect(host.enter()).toBe(false);
    expect(host.write("frame")).toBe(false);
    expect(await host.probe()).toMatchObject({ answered: false });
    host.leave();
    host.processExit();
    expect(host.log()).toEqual([]);
    expect(host.hooked()).toBe(false);
    expect(host.timers()).toBe(0);
  });

  it("writes only while entered", () => {
    const host = new HeadlessHost();
    expect(host.write("early")).toBe(false);
    host.enter();
    expect(host.write("frame")).toBe(true);
    host.leave();
    expect(host.write("late")).toBe(false);
    expect(host.output()).toBe(`${ENTER}frame${LEAVE}`);
  });
});

describe("signals", () => {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    it(`gives the terminal back on ${signal}, reports it, and ends the process with ${code}`, () => {
      const host = new HeadlessHost();
      const ends: unknown[] = [];
      host.onEnd((end) => { ends.push(end); });
      host.enter();
      host.signal(signal);
      expect(host.output()).toBe(ENTER + LEAVE);
      expect(host.log().at(-1)).toBe("raw off");
      expect(ends).toEqual([{ kind: "signal", signal }]);
      expect(host.exitCode).toBe(code);
    });
  }

  it("a second signal during the end neither repeats nor cuts the restore, and the first decides the exit code", async () => {
    const host = new HeadlessHost();
    let finish = () => {};
    let told = 0;
    host.onEnd(() => { told++; return new Promise<void>((resolve) => { finish = resolve; }); });
    host.enter();
    host.signal("SIGTERM");
    host.signal("SIGINT");
    host.signal("SIGHUP");
    expect(host.exitCode).toBeNull();
    finish();
    await host.settled();
    expect(host.exitCode).toBe(143);
    expect(told).toBe(1);
    expect(count(host.output(), LEAVE)).toBe(1);
    expect(host.log().filter((entry) => entry === "raw off")).toHaveLength(1);
  });

  it("ends the process after SIGNAL_END_WAIT_MS when an end listener never settles", () => {
    const host = new HeadlessHost();
    host.onEnd(() => new Promise<void>(() => {}));
    host.enter();
    host.signal("SIGTERM");
    host.advance(1999);
    expect(host.exitCode).toBeNull();
    host.advance(1);
    expect(host.exitCode).toBe(143);
  });

  it("a signal that lands while enter is writing is handled after it: everything is undone once", () => {
    const host = new HeadlessHost();
    host.duringNextWrite(() => host.signal("SIGTERM"));
    expect(host.enter()).toBe(true);
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(host.exitCode).toBe(143);
  });

  it("a signal that lands while leave is writing does not write the leave sequence again", () => {
    const host = new HeadlessHost();
    host.enter();
    host.duringNextWrite(() => host.signal("SIGINT"));
    host.leave();
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(host.log().filter((entry) => entry === "raw off")).toHaveLength(1);
  });

  it("a signal before enter or after leave is the process's own business: the host has no hook then", () => {
    const host = new HeadlessHost();
    expect(host.hooked()).toBe(false);
    host.enter();
    expect(host.hooked()).toBe(true);
    host.leave();
    expect(host.hooked()).toBe(false);
  });
});

describe("gone after hang-up", () => {
  it("on SIGHUP gives the terminal back once, reports gone once, writes nothing after it and ends with 129", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.hangUp();
    expect(host.write("frame")).toBe(false);
    host.resize(100, 30);
    host.feed(`${ESC}[I`);
    host.hangUp();
    expect(host.output()).toBe(ENTER + LEAVE);
    expect(ends).toEqual([{ kind: "gone", why: "hangup" }]);
    expect(host.exitCode).toBe(129);
  });

  it("a write that fails with EIO reports gone once, and nothing is written again, the leave sequence included", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.failWrites("EIO");
    expect(host.write("frame")).toBe(false);
    expect(host.write("frame")).toBe(false);
    host.leave();
    expect(ends).toEqual([{ kind: "gone", why: "write-failed" }]);
    expect(host.output()).toBe(ENTER);
    expect(host.writeAttempts()).toBe(2);
    expect(host.log().at(-1)).toBe("raw off");
    expect(host.exitCode).toBeNull();
  });

  it("a hang-up after a failed write ends the process without reporting gone a second time", () => {
    const host = new HeadlessHost();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    host.failWrites("EIO");
    host.write("frame");
    host.hangUp();
    expect(ends).toEqual([{ kind: "gone", why: "write-failed" }]);
    expect(host.exitCode).toBe(129);
    expect(host.log().at(-1)).toBe("raw off");
  });

  it("EPIPE is gone too; any other write error is thrown to the caller", () => {
    const host = new HeadlessHost();
    host.enter();
    host.failWrites("EPIPE");
    expect(host.write("frame")).toBe(false);
    const other = new HeadlessHost();
    other.enter();
    other.failWrites("EBADF");
    expect(() => other.write("frame")).toThrow("EBADF");
  });
});

describe("modes again after resize and focus-in", () => {
  it("sends its own modes again after a host resize, then reports the size", () => {
    const host = new HeadlessHost();
    const sizes: unknown[] = [];
    host.onResize((size) => sizes.push({ size, output: host.output() }));
    host.enter();
    host.resize(100, 30);
    expect(sizes).toEqual([{ size: { cols: 100, rows: 30 }, output: ENTER + AGAIN }]);
    expect(host.size()).toEqual({ cols: 100, rows: 30 });
  });

  it("sends its own modes again when the host reports focus-in, and still hands the report on as input", () => {
    const host = new HeadlessHost({ answer: ANSWER });
    const seen = inputs(host);
    host.enter();
    host.feed(`${ESC}[I`);
    expect(host.output()).toBe(ENTER + AGAIN);
    expect(seen).toEqual([`${ESC}[I`]);
    host.feed(`x${ESC}[O`);
    expect(count(host.output(), AGAIN)).toBe(1);
  });

  it("finds a focus-in split across two reads", () => {
    const host = new HeadlessHost();
    host.enter();
    host.feed(`${ESC}[`);
    host.feed("I");
    expect(count(host.output(), AGAIN)).toBe(1);
  });

  it("sends nothing on a resize before enter or after leave", () => {
    const host = new HeadlessHost();
    host.resize(90, 20);
    host.enter();
    host.leave();
    host.resize(100, 30);
    expect(host.output()).toBe(ENTER + LEAVE);
  });
});

describe("the start probe", () => {
  it("the probe ends at 500 ms with no reply", async () => {
    const host = new HeadlessHost();
    host.enter();
    let result: unknown = null;
    void host.probe().then((value) => { result = value; });
    expect(host.output()).toBe(ENTER + PROBE);
    host.advance(499);
    await host.settled();
    expect(result).toBeNull();
    host.advance(1);
    await host.settled();
    expect(result).toEqual({
      answered: false, kittyFlags: null, syncOutput: null, foreground: null, background: null, cursorColor: null,
      cellPixels: null, deviceAttributes: null, theme: null,
    });
    expect(host.timers()).toBe(0);
  });

  it("the probe ends at DA1 with replies, and none of them is input", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    const seen = inputs(host);
    host.enter();
    const result = await host.probe();
    expect(result).toEqual({
      answered: true, kittyFlags: 1, syncOutput: true, foreground: [17, 34, 51], background: [0, 0, 0], cursorColor: [255, 255, 255],
      cellPixels: { width: 9, height: 18 }, deviceAttributes: [62, 22], theme: "dark",
    });
    expect(host.timers()).toBe(0);
    expect(seen).toEqual([]);
    host.feed("typed");
    expect(seen).toEqual(["typed"]);
  });

  it("a light background is light", async () => {
    const host = new HeadlessHost({ answer: `${ESC}]11;rgb:ffff/ffff/f0f0\x07${ESC}[?62c` });
    host.enter();
    expect((await host.probe()).theme).toBe("light");
  });

  it("swallows replies that come after the limit, and lets typing through", async () => {
    const host = new HeadlessHost();
    const seen = inputs(host);
    host.enter();
    const probed = host.probe();
    host.advance(500);
    expect((await probed).answered).toBe(false);
    host.feed(ANSWER);
    host.feed("x");
    expect(seen).toEqual(["x"]);
    host.feed(`${ESC}[?1u`);
    expect(seen).toEqual(["x", `${ESC}[?1u`]);
  });

  it("keeps garbage, partial replies and 1 MiB of bytes out of the input; the probe still ends at its limit", async () => {
    for (const answer of ["garbage", `${ESC}[?zz${ESC}]11;`, `${ESC}]11;rgb:ff`, "A".repeat(1024 * 1024)]) {
      const host = new HeadlessHost();
      const seen = inputs(host);
      host.enter();
      const probed = host.probe();
      for (let at = 0; at < answer.length; at += 65536) host.feed(answer.slice(at, at + 65536));
      host.advance(500);
      expect((await probed).answered).toBe(false);
      host.feed("x");
      expect(seen).toEqual(["x"]);
    }
  });

  it("typing that arrives in the same read after the DA1 reply is input", async () => {
    const host = new HeadlessHost({ answer: `${ESC}[?62c` + "ab" });
    const seen = inputs(host);
    host.enter();
    await host.probe();
    expect(seen).toEqual(["ab"]);
  });

  it("is asked once: a second call gets the same answer and writes nothing", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    host.enter();
    const first = host.probe();
    expect(host.probe()).toBe(first);
    await first;
    expect(count(host.output(), PROBE)).toBe(1);
  });

  it("ends at leave and keeps its replies out of the input to the last", async () => {
    const host = new HeadlessHost();
    host.enter();
    const probed = host.probe();
    host.leave();
    expect((await probed).answered).toBe(false);
    expect(host.timers()).toBe(0);
    expect(host.output()).toBe(ENTER + PROBE + LEAVE);
  });
});

describe("colour depth", () => {
  it("is truecolor for COLORTERM truecolor or 24bit, else 256 colours", () => {
    expect(new HeadlessHost({ colorTerm: "truecolor" }).colorDepth).toBe("truecolor");
    expect(new HeadlessHost({ colorTerm: "24bit" }).colorDepth).toBe("truecolor");
    expect(new HeadlessHost({ colorTerm: "yes" }).colorDepth).toBe("256");
    expect(new HeadlessHost({}).colorDepth).toBe("256");
  });
});

describe("drain", () => {
  it("takes what waits instead of handing it to onInput, until nothing arrives for DRAIN_WAIT_MS", async () => {
    const host = new HeadlessHost({ answer: ANSWER });
    const seen = inputs(host);
    host.enter();
    await host.probe();
    host.queue("typed ahead");
    let drained = null as string | null;
    void host.drain().then((bytes) => { drained = text(bytes); });
    host.advance(30);
    host.feed(" more");
    host.advance(49);
    await host.settled();
    expect(drained).toBeNull();
    host.advance(1);
    await host.settled();
    expect(drained).toBe("typed ahead more");
    expect(seen).toEqual([]);
    host.feed("live");
    expect(seen).toEqual(["live"]);
  });

  it("keeps probe replies out of what it returns", async () => {
    const host = new HeadlessHost();
    host.enter();
    void host.probe();
    const drained = host.drain();
    host.feed(`${ESC}[?1u`);
    host.advance(50);
    expect(text(await drained)).toBe("");
  });

  it("returns nothing when not entered", async () => {
    const host = new HeadlessHost();
    expect((await host.drain()).length).toBe(0);
    expect(host.timers()).toBe(0);
  });
});
