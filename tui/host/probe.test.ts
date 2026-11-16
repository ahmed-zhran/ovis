import { describe, expect, it } from "bun:test";
import { emptyProbe, PROBE_QUERY, type Reply, ReplyFilter, replyAt, themeOf, withReply } from "./probe.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const ESC = "\x1b";
const ST = `${ESC}\\`;

describe("the start probe's question", () => {
  it("asks for kitty flags, DECRQM 2026, OSC 10, 11 and 12, the cell size, then DA1 last", () => {
    expect(PROBE_QUERY).toBe(`${ESC}[?u${ESC}[?2026$p${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}]12;?${ST}${ESC}[16t${ESC}[c`);
  });
});

describe("replyAt", () => {
  const at = (data: string) => replyAt(bytes(data), 0);

  it("reads every reply the probe asks for, with its length", () => {
    expect(at(`${ESC}[?1u`)).toEqual({ reply: { kind: "kitty", flags: 1 }, length: 5 });
    expect(at(`${ESC}[?2026;2$y`)).toEqual({ reply: { kind: "mode", mode: 2026, value: 2 }, length: 11 });
    expect(at(`${ESC}]11;rgb:ffff/0000/8080${ST}`)).toEqual({ reply: { kind: "color", which: 11, rgb: [255, 0, 128] }, length: 25 });
    expect(at(`${ESC}]10;rgb:f/0/8\x07`)).toEqual({ reply: { kind: "color", which: 10, rgb: [255, 0, 136] }, length: 15 });
    expect(at(`${ESC}]12;#ff0080${ST}`)).toEqual({ reply: { kind: "color", which: 12, rgb: [255, 0, 128] }, length: 14 });
    expect(at(`${ESC}]11;nonsense${ST}`)).toEqual({ reply: { kind: "color", which: 11, rgb: null }, length: 15 });
    expect(at(`${ESC}[6;18;9t`)).toEqual({ reply: { kind: "cell", height: 18, width: 9 }, length: 9 });
    expect(at(`${ESC}[?62;22c`)).toEqual({ reply: { kind: "da1", params: [62, 22] }, length: 9 });
  });

  it("asks for more bytes while a reply can still be completing", () => {
    for (const start of [ESC, `${ESC}[`, `${ESC}[?`, `${ESC}[?62;2`, `${ESC}[?2026;2$`, `${ESC}]`, `${ESC}]1`, `${ESC}]11;rgb:ff`, `${ESC}]11;x${ESC}`, `${ESC}[6`, `${ESC}[6;18;`]) {
      expect([start, at(start)]).toEqual([start, "more"]);
    }
  });

  it("takes no key and no other sequence for a reply", () => {
    for (const other of [`${ESC}[6~`, `${ESC}[6;5~`, `${ESC}[97;5u`, `${ESC}[1;2R`, `${ESC}[I`, `${ESC}[A`, `${ESC}a`, `${ESC}]13;?${ST}`, `${ESC}[?1;2;3u`, "x"]) {
      expect([other, at(other)]).toEqual([other, null]);
    }
  });

  it("gives up on a sequence longer than any reply", () => {
    expect(at(`${ESC}[?${"1".repeat(100)}`)).toBeNull();
    expect(at(`${ESC}]11;${"a".repeat(300)}`)).toBeNull();
  });
});

describe("the probe's result", () => {
  it("collects the replies and reads light or dark from the background", () => {
    let result = emptyProbe();
    for (const reply of [
      { kind: "kitty", flags: 1 }, { kind: "mode", mode: 2026, value: 2 }, { kind: "color", which: 10, rgb: [0, 0, 0] },
      { kind: "color", which: 11, rgb: [250, 250, 240] }, { kind: "color", which: 12, rgb: [1, 2, 3] }, { kind: "cell", height: 18, width: 9 },
      { kind: "da1", params: [62, 22] },
    ] satisfies Reply[]) result = withReply(result, reply);
    expect(result).toEqual({
      answered: true, kittyFlags: 1, syncOutput: true, foreground: [0, 0, 0], background: [250, 250, 240], cursorColor: [1, 2, 3],
      cellPixels: { width: 9, height: 18 }, deviceAttributes: [62, 22], theme: "light",
    });
  });

  it("reads DECRQM 0 and 4 as no synchronized output", () => {
    expect(withReply(emptyProbe(), { kind: "mode", mode: 2026, value: 0 }).syncOutput).toBe(false);
    expect(withReply(emptyProbe(), { kind: "mode", mode: 2026, value: 4 }).syncOutput).toBe(false);
    expect(withReply(emptyProbe(), { kind: "mode", mode: 2026, value: 1 }).syncOutput).toBe(true);
  });

  it("calls a dark background dark and a light one light", () => {
    expect(themeOf([0, 0, 0])).toBe("dark");
    expect(themeOf([40, 44, 52])).toBe("dark");
    expect(themeOf([255, 255, 255])).toBe("light");
    expect(themeOf([253, 246, 227])).toBe("light");
    expect(themeOf(null)).toBeNull();
  });
});

describe("ReplyFilter", () => {
  const DA1 = `${ESC}[?62;22c`;

  it("keeps everything while probing and hands back what follows the DA1 reply", () => {
    const filter = new ReplyFilter();
    const taken = filter.take(bytes(`typed${ESC}[?1u${ESC}]11;rgb:0/0/0${ST}garbage${DA1}after`), "probing");
    expect(text(taken.input)).toBe("");
    expect(taken.replies.map((reply) => reply.kind)).toEqual(["kitty", "color", "da1"]);
    expect(text(taken.rest!)).toBe("after");
  });

  it("joins a reply split across reads", () => {
    const filter = new ReplyFilter();
    expect(filter.take(bytes(`${ESC}]11;rgb:ff`), "probing").replies).toEqual([]);
    expect(filter.holding).toBe(11);
    const second = filter.take(bytes(`ff/ffff/ffff${ST}${ESC}[?6`), "probing");
    expect(second.replies).toEqual([{ kind: "color", which: 11, rgb: [255, 255, 255] }]);
    expect(filter.take(bytes("2c"), "probing").replies).toEqual([{ kind: "da1", params: [62] }]);
  });

  it("after the probe passes typing through and swallows late replies", () => {
    const filter = new ReplyFilter();
    const taken = filter.take(bytes(`a${ESC}[?1u${ESC}[Ab${ESC}]10;rgb:0/0/0\x07${ESC}c${DA1}${ESC}[?1u`), "late");
    expect(text(taken.input)).toBe(`a${ESC}[Ab${ESC}c`);
    expect(taken.replies.map((reply) => reply.kind)).toEqual(["kitty", "color", "da1"]);
    expect(text(taken.rest!)).toBe(`${ESC}[?1u`);
  });

  it("after the probe never holds a lone Escape or the start of a key", () => {
    const filter = new ReplyFilter();
    expect(text(filter.take(bytes(ESC), "late").input)).toBe(ESC);
    expect(text(filter.take(bytes(`${ESC}[`), "late").input)).toBe(`${ESC}[`);
    expect(text(filter.take(bytes(`${ESC}[6`), "late").input)).toBe(`${ESC}[6`);
    expect(filter.holding).toBe(0);
  });

  it("after the probe drops a held reply that the next read does not finish, and keeps that read's typing", () => {
    const filter = new ReplyFilter();
    filter.take(bytes(`${ESC}]11;rgb:ff`), "probing");
    expect(text(filter.take(bytes("x"), "late").input)).toBe("x");
    expect(filter.holding).toBe(0);
    filter.take(bytes(`${ESC}[?62`), "late");
    expect(filter.holding).toBe(5);
    expect(text(filter.take(bytes(";1c"), "late").input)).toBe("");
  });

  it("holds little however much garbage arrives", () => {
    const filter = new ReplyFilter();
    const chunk = bytes(`${"A".repeat(4000)}${ESC}]11;${"b".repeat(90)}`);
    for (let i = 0; i < 260; i++) {
      expect(filter.take(chunk, "probing").input.length).toBe(0);
      expect(filter.holding).toBeLessThan(300);
    }
  });
});
