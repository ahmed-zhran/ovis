import type { ProbeResult, Rgb } from "./index.ts";

/**
 * The start probe's question, written once after enter: kitty keyboard flags, DECRQM 2026, the
 * foreground, background and cursor colours, the cell size in pixels, then DA1, which every
 * terminal answers and which therefore ends the probe. Never `CSI 6n`: its reply for row 1 reads
 * like a modified F3.
 */
export const PROBE_QUERY = "\x1b[?u\x1b[?2026$p\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[16t\x1b[c";

export type Reply =
  | { kind: "kitty"; flags: number }
  | { kind: "mode"; mode: number; value: number }
  | { kind: "color"; which: 10 | 11 | 12; rgb: Rgb | null }
  | { kind: "cell"; height: number; width: number }
  | { kind: "da1"; params: number[] };

const ESC = 0x1b;
const CSI_LIMIT = 64;
const OSC_LIMIT = 256;

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;

/**
 * What starts at `at` (an ESC): a whole reply and its length, "more" while the bytes so far can
 * still become one, or null for anything else (a key, another sequence, garbage).
 */
export function replyAt(bytes: Uint8Array, at: number): { reply: Reply; length: number } | "more" | null {
  if (bytes[at] !== ESC) return null;
  if (at + 1 >= bytes.length) return "more";
  const kind = bytes[at + 1];
  if (kind === 0x5b) return csiReply(bytes, at);
  if (kind === 0x5d) return oscReply(bytes, at);
  return null;
}

/** `CSI ? n u`, `CSI ? n ; m $ y`, `CSI ? ... c` and `CSI 6 ; h ; w t`. */
function csiReply(bytes: Uint8Array, at: number): { reply: Reply; length: number } | "more" | null {
  let i = at + 2;
  if (i >= bytes.length) return "more";
  const private_ = bytes[i] === 0x3f;
  if (private_) i++;
  else if (bytes[i] !== 0x36) return null;
  const params: number[] = [];
  let current = "";
  for (; i < bytes.length; i++) {
    if (i - at > CSI_LIMIT) return null;
    const byte = bytes[i]!;
    if (isDigit(byte)) { current += String.fromCharCode(byte); continue; }
    if (byte === 0x3b) { params.push(Number(current)); current = ""; continue; }
    if (current !== "") params.push(Number(current));
    const length = i - at + 1;
    if (!private_) {
      return byte === 0x74 && params.length === 3 && params[0] === 6 && current !== "" ? { reply: { kind: "cell", height: params[1]!, width: params[2]! }, length } : null;
    }
    if (byte === 0x75) return params.length === 1 ? { reply: { kind: "kitty", flags: params[0]! }, length } : null;
    if (byte === 0x63) return params.length > 0 ? { reply: { kind: "da1", params }, length } : null;
    if (byte === 0x24) {
      if (i + 1 >= bytes.length) return "more";
      return bytes[i + 1] === 0x79 && params.length === 2 ? { reply: { kind: "mode", mode: params[0]!, value: params[1]! }, length: length + 1 } : null;
    }
    return null;
  }
  return "more";
}

/** `OSC 10|11|12 ; <colour>` ended by BEL or ST. */
function oscReply(bytes: Uint8Array, at: number): { reply: Reply; length: number } | "more" | null {
  const head = [0x31, -1, 0x3b];
  for (let k = 0; k < head.length; k++) {
    const i = at + 2 + k;
    if (i >= bytes.length) return "more";
    const byte = bytes[i]!;
    if (head[k] === -1 ? byte < 0x30 || byte > 0x32 : byte !== head[k]) return null;
  }
  const which = (10 + bytes[at + 3]! - 0x30) as 10 | 11 | 12;
  const start = at + 5;
  for (let i = start; i < bytes.length; i++) {
    if (i - at > OSC_LIMIT) return null;
    const byte = bytes[i]!;
    if (byte === 0x07) return { reply: { kind: "color", which, rgb: parseColor(bytes.subarray(start, i)) }, length: i - at + 1 };
    if (byte === ESC) {
      if (i + 1 >= bytes.length) return "more";
      return bytes[i + 1] === 0x5c ? { reply: { kind: "color", which, rgb: parseColor(bytes.subarray(start, i)) }, length: i - at + 2 } : null;
    }
  }
  return "more";
}

/** `rgb:R/G/B` with 1 to 4 hex digits a channel, or `#rrggbb`, as 0-255 values. */
function parseColor(raw: Uint8Array): Rgb | null {
  const text = new TextDecoder().decode(raw);
  const hash = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (hash) return [parseInt(hash[1]!, 16), parseInt(hash[2]!, 16), parseInt(hash[3]!, 16)];
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(text);
  if (!rgb) return null;
  const channel = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
  return [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)];
}

/** Light when the background's relative luminance is above one half. */
export function themeOf(background: Rgb | null): "light" | "dark" | null {
  if (!background) return null;
  const [r, g, b] = background;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? "light" : "dark";
}

export function emptyProbe(): ProbeResult {
  return { answered: false, kittyFlags: null, syncOutput: null, foreground: null, background: null, cursorColor: null, cellPixels: null, deviceAttributes: null, theme: null };
}

export function withReply(result: ProbeResult, reply: Reply): ProbeResult {
  switch (reply.kind) {
    case "kitty": return { ...result, kittyFlags: reply.flags };
    case "mode": return reply.mode === 2026 ? { ...result, syncOutput: reply.value !== 0 && reply.value !== 4 } : result;
    case "color":
      if (reply.which === 10) return { ...result, foreground: reply.rgb };
      if (reply.which === 12) return { ...result, cursorColor: reply.rgb };
      return { ...result, background: reply.rgb, theme: themeOf(reply.rgb) };
    case "cell": return { ...result, cellPixels: { width: reply.width, height: reply.height } };
    case "da1": return { ...result, answered: true, deviceAttributes: reply.params };
  }
}

/** Starts that only a reply has: after the probe, these are held across a read; a lone ESC or `ESC [` never is. */
const REPLY_ONLY_STARTS = ["\x1b[?", "\x1b]1", "\x1b[6;"].map((start) => new TextEncoder().encode(start));

function startsWithReplyOnly(bytes: Uint8Array): boolean {
  return REPLY_ONLY_STARTS.some((start) => bytes.length >= start.length && start.every((byte, i) => bytes[i] === byte));
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Takes the probe's replies out of what stdin delivers. While `probing`, nothing is input: every
 * byte before the DA1 reply belongs to the host's answer (garbage included) and is dropped. Once
 * the probe gave up (`late`), typing passes through and only whole replies are taken out, so a
 * reply that arrives late never becomes input. A reply cut by a read is held for the next one;
 * after the probe, only when it starts the way no key does, and only for one more read.
 */
export class ReplyFilter {
  private held: Uint8Array = new Uint8Array(0);

  get holding(): number {
    return this.held.length;
  }

  /** `rest` is what followed the DA1 reply in these bytes, untouched; the probe is over then. */
  take(chunk: Uint8Array, phase: "probing" | "late"): { input: Uint8Array; replies: Reply[]; rest: Uint8Array | null } {
    const late = phase === "late";
    let bytes = chunk;
    if (this.held.length > 0) {
      const joined = concat([this.held, chunk]);
      // after the probe a held reply gets one more read to finish; if that read does not, the held part is dropped
      bytes = late && replyAt(joined, 0) === "more" ? chunk : joined;
      this.held = new Uint8Array(0);
    }
    const input: Uint8Array[] = [];
    const replies: Reply[] = [];
    let from = 0;
    let i = 0;
    while (i < bytes.length) {
      const esc = bytes.indexOf(ESC, i);
      if (esc === -1) break;
      const found = replyAt(bytes, esc);
      if (found === null) { i = esc + 1; continue; }
      if (late && esc > from) input.push(bytes.subarray(from, esc));
      if (found === "more") {
        const tail = bytes.subarray(esc);
        if (!late || startsWithReplyOnly(tail)) this.held = tail.slice();
        else input.push(tail);
        return { input: concat(input.length ? input : [new Uint8Array(0)]), replies, rest: null };
      }
      replies.push(found.reply);
      i = from = esc + found.length;
      if (found.reply.kind === "da1") {
        return { input: concat(input.length ? input : [new Uint8Array(0)]), replies, rest: bytes.subarray(i) };
      }
    }
    if (late && from < bytes.length) input.push(bytes.subarray(from));
    return { input: concat(input.length ? input : [new Uint8Array(0)]), replies, rest: null };
  }
}
