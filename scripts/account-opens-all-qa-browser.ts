import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import type { FakeAccountService } from "../shared/account-service-fake.ts";
import { safetyRecordId, safetySigningBytes, type UnsignedSafetyRecord } from "../shared/account-records.ts";
import { PAIR_FINGERPRINT_PATTERN } from "../shared/pair-fingerprint.ts";
import { GLOBAL_APP, REGIONAL_APPS } from "../shared/relay-regions.ts";
import { shellContentSecurityPolicy } from "../shared/web-policy.ts";
import type { AccountKey, AccountSession, SignInKey } from "../src/lib/account/store.ts";
import type { SavedDevice } from "../src/lib/relay/device.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";
import { closeMarked, whileOpen } from "./relay-qa-teardown.ts";

type LocalServices = {
  readonly account: FakeAccountService;
  readonly socketUrl: (url: string) => string;
};
type AppOptions = {
  readonly accountUrl: string;
  readonly local?: LocalServices;
  readonly storageState?: string;
};

export async function withQaApp(options: AppOptions, dir: string, run: (open: () => Promise<Page>) => Promise<void>): Promise<void> {
  const root = join(import.meta.dir, "..");
  const build = Bun.spawn([process.execPath, "--bun", join(root, "node_modules/.bin/vite"), "build", "--mode", "shell",
    "--outDir", dir, "--emptyOutDir", "--logLevel", "warn"], { cwd: root, env: process.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  assert.equal(await build.exited, 0, "Build the hosted shell");
  const site = servePagesSite(dir);
  let browser: Browser | undefined;
  try {
    const chrome = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    browser = chrome;
    await run(async () => {
      // Copy only Google cookies, not app state. Each context must perform its own
      // OAuth exchange and register a different device key.
      const seed = options.storageState === undefined ? undefined : await chrome.newContext({ storageState: options.storageState });
      const cookies = await seed?.cookies("https://accounts.google.com").finally(() => seed.close());
      const context = await chrome.newContext({ locale: "en-US", serviceWorkers: "block" });
      if (cookies !== undefined) await context.addCookies(cookies);
      await context.route(`${GLOBAL_APP}/**`, whileOpen(context, async (route) => {
        const request = new URL(route.request().url());
        const response = await route.fetch({ url: new URL(request.pathname + request.search, site.url).href, maxRedirects: 0 });
        const headers = response.headers();
        // Keep the generated policy except for adding the staging account's actual origin.
        if (headers["content-security-policy"]?.includes(" wss: ")) {
          headers["content-security-policy"] = shellContentSecurityPolicy([...Object.values(REGIONAL_APPS), options.accountUrl]);
        }
        await route.fulfill({ response, headers });
      }));
      const local = options.local;
      if (local !== undefined) {
        await context.routeWebSocket("wss://relay.test/**", (ws) => relayBrowserSocket(ws, () => local.socketUrl(ws.url())));
        await context.route(`${options.accountUrl}/**`, whileOpen(context, async (route) => {
          const request = route.request();
          const body = request.postDataBuffer();
          const cors = { "access-control-allow-origin": GLOBAL_APP, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
          if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
          const response = await local.account.fetch(new Request(request.url(), {
            method: request.method(), headers: request.headers(), ...(body === null ? {} : { body: new Uint8Array(body) }),
          }));
          const redirect = response.headers.get("location");
          // As in relay-dashboard-browser-qa: let the OAuth return hit the intercepted app origin.
          if (redirect?.startsWith(`${GLOBAL_APP}/`)) {
            await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=${redirect.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` });
          } else {
            await route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors }, body: Buffer.from(await response.arrayBuffer()) });
          }
        }));
      }
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      return page;
    });
  } finally {
    try { if (browser !== undefined) await closeMarked(browser); } finally { await site.stop(true); }
  }
}

type BrowserAccountAction =
  | { readonly kind: "read" }
  | { readonly kind: "put"; readonly path: string; readonly entry: { readonly label: string; readonly public_key: string; readonly relay: string } }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "seed"; readonly no: number }
  | { readonly kind: "sign"; readonly signer: string; readonly no: number; readonly bytes: readonly number[] }
  | { readonly kind: "paired"; readonly pc: Omit<SavedDevice, keyof AccountKey> };

export async function browserSafetyRecord<T extends UnsignedSafetyRecord>(page: Page, record: T) {
  const { signature } = await browserAccount(page, record.account, {
    kind: "sign", signer: record.signer, no: record.signer_no, bytes: Array.from(safetySigningBytes(record)),
  });
  assert.ok(signature, "The browser did not sign the safety record");
  return { ...record, id: safetyRecordId(record), signature };
}

export async function assertFingerprintDecline(pages: { readonly visitor: Page; readonly owner: Page }, offer: string,
  request: (path: string) => Promise<Response>): Promise<void> {
  const { visitor, owner } = pages;
  try {
    await visitor.goto(offer);
    await visitor.getByRole("button", { name: "Pair", exact: true }).click();
    const shown = visitor.locator(".pending-key-fingerprint");
    await shown.or(visitor.locator(".app")).first().waitFor();
    assert.ok(await shown.isVisible(), "PC accepted the code without a fingerprint challenge");
    const fingerprint = await shown.textContent();
    assert.match(fingerprint ?? "", PAIR_FINGERPRINT_PATTERN);
    const pending = owner.locator(".pending-keys li").filter({ hasText: fingerprint ?? "" });
    await pending.waitFor();
    const listed: { pending?: readonly { fingerprint: string }[] } = await (await request("/api/devices/pending")).json();
    assert.ok(listed.pending?.some((key) => key.fingerprint === fingerprint), "The PC did not list this device's fingerprint");
    await pending.getByRole("button", { name: "Decline", exact: true }).click();
    await pending.waitFor({ state: "detached" });
    const after: typeof listed = await (await request("/api/devices/pending")).json();
    assert.ok(after.pending?.every((key) => key.fingerprint !== fingerprint), "Decline did not remove the key on the PC");
  } finally { await closeMarked(visitor.context()); }
}

// The hosted app owns the credentials. Use them in its origin for directory fixture setup/cleanup;
// never return a token to the runner. "seed" is only for the existing fake, which has no /v1/devices registration.
export function browserAccount(page: Page, expected: string, action: BrowserAccountAction) {
  return page.evaluate(async ({ expected, action }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ovis-account", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("account");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = <T,>(name: string): Promise<T | undefined> => new Promise((resolve, reject) => {
        const request = db.transaction("account").objectStore("account").get(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const session = await read<AccountSession>("session");
      if (session === undefined || session.account !== expected || session.sign_in_id === undefined) {
        throw new Error("The browser did not sign in to the designated QA account");
      }
      if (action.kind === "sign") {
        const registered = await read<SignInKey>("signin_key");
        if (registered?.key.public_spki !== action.signer || registered.no !== action.no || registered.sign_in_id !== session.sign_in_id) {
          throw new Error("The QA record signer is not this browser's registered sign-in key");
        }
        const bytes = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, registered.key.private_key, new Uint8Array(action.bytes)));
        const signature = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        return { provider: session.provider, key: registered.key.public_spki, no: registered.no, signature };
      } else if (action.kind === "paired") {
        // Install an already-paired owner on A only, as in relay-shell-browser-qa.
        const key = await read<AccountKey>("key");
        if (key === undefined) throw new Error("The signed-in owner has no account pairing key");
        const relay = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("ovis-relay", 2);
          request.onupgradeneeded = () => {
            for (const name of ["devices", "pending-push"]) {
              if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "server_id" });
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = relay.transaction("devices", "readwrite");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.objectStore("devices").put({ ...action.pc, ...key } satisfies SavedDevice);
          });
        } finally { relay.close(); }
        return { provider: session.provider, key: key.public_spki, no: undefined };
      } else if (action.kind === "seed") {
        const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const bytes = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
        const spki = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        const key = { no: action.no, account: session.account, sign_in_id: session.sign_in_id,
          key: { private_key: pair.privateKey, public_spki: spki } } satisfies SignInKey;
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("account", "readwrite");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.objectStore("account").put(key, "signin_key");
        });
      } else if (action.kind === "put" || action.kind === "delete") {
        const response = await fetch(new URL(action.path, session.service), {
          method: action.kind === "put" ? "PUT" : "DELETE",
          headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
          ...(action.kind === "put" ? { body: JSON.stringify(action.entry) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`QA directory ${action.kind}: HTTP ${response.status}`);
      }
      const registered = await read<SignInKey>("signin_key");
      return { provider: session.provider, key: registered?.key.public_spki, no: registered?.no };
    } finally { db.close(); }
  }, { expected, action });
}
