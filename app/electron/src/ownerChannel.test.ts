import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { withoutInherited } from "./children.ts";
import { DESKTOP_OWNER_FD, ownerChannel, type OwnerPending } from "./ownerChannel.ts";

const lockAsked = { id: "a1", action: { kind: "lock" }, shown: { title: "Turn on strict mode", lines: ["Ends 2 devices"] } };
const keyAsked = { id: "b2", action: { kind: "approve_key", pending: "p1", fingerprint: "ab12 cd34" }, shown: { title: "Approve this key", lines: ["Pixel 9"], fingerprint: "ab12 cd34" } };

function open() {
  const socket = new PassThrough();
  const written: string[] = [];
  const out = { write: (line: string) => { written.push(line); return true; } };
  const seen: (readonly OwnerPending[])[] = [];
  const channel = ownerChannel(socket, out, (pending) => seen.push(pending));
  return { socket, written, seen, channel };
}

describe("the desktop owner channel", () => {
  it("R8: reads the PC's pending screen actions line by line, whatever the chunks", () => {
    const { socket, seen } = open();
    const line = JSON.stringify({ pending: [lockAsked, keyAsked] });
    socket.write(line.slice(0, 20));
    socket.write(`${line.slice(20)}\n${JSON.stringify({ pending: [keyAsked] })}\n`);
    expect(seen.map((pending) => pending.map((item) => item.id))).toEqual([["a1", "b2"], ["b2"]]);
  });

  it("R8: a line that does not parse is dropped and the next one still reads", () => {
    const { socket, seen } = open();
    socket.write(`{not json\n${JSON.stringify({ pending: [lockAsked] })}\n`);
    expect(seen.map((pending) => pending.map((item) => item.id))).toEqual([["a1"]]);
  });

  it("T72: answers only an action the PC lists now, once, and never one it took back", () => {
    const { socket, written, channel } = open();
    socket.write(`${JSON.stringify({ pending: [lockAsked, keyAsked] })}\n`);
    expect(channel.answer("a1", true)).toBe(true);
    expect(channel.answer("a1", true)).toBe(false);
    socket.write(`${JSON.stringify({ pending: [] })}\n`);
    expect(channel.answer("b2", false)).toBe(false);
    expect(channel.answer("zz", true)).toBe(false);
    expect(written).toEqual([`${JSON.stringify({ approve: "a1" })}\n`]);
  });

  it("T68: what the PC shows (title, lines, fingerprint) reaches the screen as the PC sent it", () => {
    const { socket, seen } = open();
    socket.write(`${JSON.stringify({ pending: [keyAsked] })}\n`);
    expect(seen[0]![0]!.shown).toEqual({ title: "Approve this key", lines: ["Pixel 9"], fingerprint: "ab12 cd34" });
  });
});

describe("handing the channel to the server", () => {
  it.if(process.platform === "linux")("R8: keeps the channel's descriptor open in the server while closing every other one", () => {
    const [command, args] = withoutInherited("ls", ["/proc/self/fd"], "/bin/bash", "linux", [DESKTOP_OWNER_FD]);
    const listed = spawnSync("/bin/bash", ["-c", `exec ${DESKTOP_OWNER_FD}</dev/null 23</dev/null; exec "$@"`, "parent", command, ...args], { encoding: "utf8" });
    const fds = listed.stdout.split("\n");
    expect(fds).toContain(String(DESKTOP_OWNER_FD));
    expect(fds).not.toContain("23");
  });
});
