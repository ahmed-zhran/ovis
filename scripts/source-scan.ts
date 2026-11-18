import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const repo = join(import.meta.dir, "..");

export const read = (file: string): string => readFileSync(join(repo, file), "utf8");

export const files = (pattern: string): string[] =>
  [...new Bun.Glob(pattern).scanSync({ cwd: repo })].filter((file) => !file.split("/").includes("node_modules")).sort();

export function fail(offenders: string[], instruction: string): void {
  if (offenders.length) throw new Error(`${instruction}\n  ${offenders.join("\n  ")}`);
}

/**
 * A `/` that starts a regular expression literal is not told apart from division, which only
 * matters for a regex holding a quote or `//`; the files these tests read have none that matter.
 */
export function stripComments(text: string, { strings = false } = {}): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && (next === "/" || next === "*")) {
      const close = next === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : next === "/" ? close : close + 2;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && (ch === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      out += strings ? ch + text.slice(i + 1, j).replace(/[^\n]/g, " ") + text.slice(j, j + 1) : text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/**
 * Module specifiers of static imports and re-exports, side-effect imports and `import("…")` with a literal (as in
 * scripts/conventions.test.ts). A declaration never runs on into the next `import`: one that no semicolon ends would
 * otherwise take the import after it for its own `from` and hide what that import names.
 */
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:(?!\bimport\b)[^;])*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/** Each relative import of `code` (comments removed), as the repository path it names and its line. */
export function relativeImports(file: string, code: string): { target: string; line: number; specifier: string; typeOnly: boolean }[] {
  return [...code.matchAll(SPECIFIER)].flatMap((match) => {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    if (!specifier.startsWith(".")) return [];
    // the match may start with the newline before the import
    const at = match.index + match[0].search(/\S/);
    const typeOnly = /^(?:import|export)\s+type\s*(?:\{|\*)/.test(match[0].slice(at - match.index));
    return [{ target: posix.normalize(posix.join(posix.dirname(file), specifier.replace(/\?.*$/, ""))), line: lineOf(code, at), specifier, typeOnly }];
  });
}

/**
 * The repository files `entry` reaches through relative imports, followed transitively through
 * every code file `follow` accepts, and each import of a file it does not accept. A file that
 * `source` cannot read is not followed: a listed file its row has not written yet is simply not reached.
 * `ignoreTypeOnly` can omit specific declaration-level type edges from this walk.
 */
export function importClosure(
  entry: string,
  source: (path: string) => string | undefined,
  follow: (path: string) => boolean = () => true,
  ignoreTypeOnly?: (from: string, to: string) => boolean,
): { reached: string[]; offenders: string[] } {
  const reached = new Set([entry]);
  const offenders: string[] = [];
  for (const queue = [entry]; queue.length;) {
    const file = queue.shift()!;
    const text = /\.(?:ts|tsx|mjs|js)$/.test(file) ? source(file) : undefined;
    if (text === undefined) continue;
    for (const { target, line, specifier, typeOnly } of relativeImports(file, stripComments(text))) {
      if (typeOnly && ignoreTypeOnly?.(file, target)) continue;
      if (!follow(target)) offenders.push(`${file}:${line}: ${specifier} (${target})`);
      else if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return { reached: [...reached], offenders };
}
