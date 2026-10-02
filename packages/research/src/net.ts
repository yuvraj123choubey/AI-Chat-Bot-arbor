import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

/** True for addresses on the public internet; private, loopback, link-local, multicast and reserved ranges are refused. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return !(lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("64:ff9b") || lower.startsWith("2001:db8"));
  }
  return false;
}

/**
 * Connections resolve DNS through this check, so the address actually connected to is the one validated.
 * That closes the gap where a hostname passes a pre-check and then re-resolves to a private address.
 */
const publicOnlyAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { all: true, family: (options as { family?: number }).family || 0 }, (error, addresses) => {
        if (error) return callback(error, "", 4);
        const list = addresses as { address: string; family: number }[];
        const blocked = list.find(a => !isPublicAddress(a.address));
        if (!list.length || blocked) return callback(Object.assign(new Error(`Refusing non-public address for ${hostname}`), { code: "EBLOCKED" }), "", 4);
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        else callback(null, list[0].address, list[0].family);
      });
    }
  },
  headersTimeout: 10_000,
  bodyTimeout: 10_000
});

export interface FetchedResource { url: string; status: number; contentType: string; body: Buffer }
export interface SafeFetchOptions { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; accept?: string; dispatcher?: Dispatcher }

/** Fetches a public http(s) URL with redirects re-validated at every hop and a hard size and time limit. */
export async function safeFetch(address: string, options: SafeFetchOptions = {}): Promise<FetchedResource> {
  const { maxBytes = 3_000_000, timeoutMs = 10_000, accept = "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5" } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = new URL(address);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs can be fetched");
    if (url.username || url.password) throw new Error("URLs with credentials are not fetched");
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Refusing non-public address");
    const response = await undiciFetch(url, { redirect: "manual", signal, dispatcher: options.dispatcher ?? publicOnlyAgent, headers: { accept, "user-agent": userAgent(), "accept-language": "en;q=1, *;q=0.5" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`Redirect without location (${response.status})`);
      url = new URL(location, url);
      continue;
    }
    const contentType = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error("Resource too large"); }
    const parts: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) break;
        parts.push(chunk);
      }
    }
    return { url: url.toString(), status: response.status, contentType, body: Buffer.concat(parts) };
  }
  throw new Error("Too many redirects");
}

/**
 * Wikimedia and OpenAlex ask API clients to include a contact (an email or a project URL) and allow more requests
 * to clients that do. Nothing is sent unless the operator sets ARBOR_CONTACT (or ARBOR_CONTACT_EMAIL).
 */
export function userAgent(): string {
  const contact = process.env.ARBOR_CONTACT || process.env.ARBOR_CONTACT_EMAIL;
  return `ArborResearch/0.1 (research assistant${contact ? `; ${contact}` : ""})`;
}
/**
 * JSON GET for search APIs, with a timeout. These hosts are fixed, so the public-address agent is not needed.
 * A dropped connection, timeout, rate limit or server error is retried once after a short pause, because a single
 * transient failure would otherwise silently remove a provider's results from an answer.
 */
export async function getJson(url: string | URL, headers: Record<string, string> = {}, signal?: AbortSignal, timeoutMs = 12_000): Promise<any> {
  const host = new URL(url).hostname;
  for (let attempt = 0; ; attempt++) {
    let pause = 900;
    const release = await politeSlot(host, signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": userAgent(), ...headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (response.ok) return await response.json();
      const error = Object.assign(new Error(`HTTP ${response.status} from ${host}`), { status: response.status });
      if (attempt > 0 || (response.status !== 429 && response.status < 500)) throw error;
      if (response.status === 429) pause = Math.min(10_000, Number(response.headers.get("retry-after")) * 1000 || 2500);
    } catch (error) {
      if (signal?.aborted || attempt > 0 || (error as { status?: number }).status) throw error;
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, pause));
  }
}

/**
 * Wikimedia APIs ask clients to make requests one at a time, and answer bursts with "too many requests".
 * Requests to those hosts share one queue per host: one at a time, starting at least 200 ms apart.
 */
const politeHosts = /(^|\.)(wikipedia|wikidata|wikimedia)\.org$/;
const queues = new Map<string, { active: number; last: number; waiting: (() => void)[] }>();
async function politeSlot(host: string, signal?: AbortSignal): Promise<() => void> {
  if (!politeHosts.test(host)) return () => {};
  const q = queues.get(host) ?? { active: 0, last: 0, waiting: [] };
  queues.set(host, q);
  while (q.active >= 1) {
    await new Promise<void>(resolve => q.waiting.push(resolve));
    signal?.throwIfAborted();
  }
  q.active++;
  const wait = q.last + 200 - Date.now();
  q.last = Math.max(Date.now(), q.last + 200);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  return () => { q.active--; q.waiting.shift()?.(); };
}
