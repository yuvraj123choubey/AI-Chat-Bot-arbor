import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import { insideProject } from "./paths.ts";

export interface PageAction { click?: string; fill?: { selector: string; value: string } }
/** How the page fits its viewport: what overflows sideways, tiny text, and whether it declares a mobile viewport. */
export interface LayoutReport { viewport: string; width: number; pageWidth: number; overflowing: string[]; smallText: number; viewportMeta: boolean }
export interface PageReport { url: string; title: string; text: string; consoleErrors: string[]; failedRequests: string[]; error?: string; layout?: LayoutReport }
export type ViewportName = "desktop" | "mobile";
const viewports: Record<ViewportName, { viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number }> = {
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
};

/** A locally installed Chrome or Edge (playwright-core drives it; no browser is downloaded). */
export function findBrowser(): string | undefined {
  const candidates = process.env.ARBOR_BROWSER ? [process.env.ARBOR_BROWSER] : process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find(p => existsSync(p));
}

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
/** Serves a project folder on a random local port for the duration of one page check. */
async function serveFolder(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
      if (!path || path.endsWith("/")) path += "index.html";
      const body = await readFile(insideProject(root, path));
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      // Browsers ask for a favicon on their own; a missing one is not the project's error.
      if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      res.writeHead(404); res.end("not found");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
}

/**
 * Opens a page of the project in a headless browser, optionally performs clicks or form fills, and reports what a
 * user would see: the visible text, console errors and failed requests. Static projects are served from their
 * folder; a running dev server's URL can be given instead.
 */
export async function viewPage(root: string, opts: { path?: string; url?: string; actions?: PageAction[]; viewport?: ViewportName } = {}): Promise<PageReport> {
  const executablePath = findBrowser();
  if (!executablePath) return { url: "", title: "", text: "", consoleErrors: [], failedRequests: [], error: "No Chrome or Edge installation was found for page checks (set ARBOR_BROWSER to a browser executable)." };
  const { chromium } = await import("playwright-core");
  const served = opts.url ? undefined : await serveFolder(root);
  const url = opts.url ?? `${served!.url}${(opts.path ?? "index.html").replace(/^\/+/, "")}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  try {
    const device = viewports[opts.viewport ?? "desktop"];
    const page = await browser.newPage(device);
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
    page.on("pageerror", e => consoleErrors.push(e.message.slice(0, 300)));
    page.on("requestfailed", r => failedRequests.push(`${r.url()} (${r.failure()?.errorText ?? "failed"})`));
    page.on("response", r => { if (r.status() >= 400) failedRequests.push(`${r.url()} (HTTP ${r.status()})`); });
    await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    for (const action of opts.actions ?? []) {
      if (action.fill) await page.fill(action.fill.selector, action.fill.value, { timeout: 5000 });
      if (action.click) await page.click(action.click, { timeout: 5000 });
      await page.waitForTimeout(150);
    }
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{3,}/g, "\n\n").trim();
    const layout = { viewport: `${opts.viewport ?? "desktop"} ${device.viewport.width}×${device.viewport.height}`, ...await page.evaluate(measureLayout) };
    return { url, title: await page.title(), text: text.slice(0, 5000), consoleErrors: consoleErrors.slice(0, 20), failedRequests: [...new Set(failedRequests)].slice(0, 20), layout };
  } catch (error) {
    return { url, title: "", text: "", consoleErrors, failedRequests, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error) };
  } finally {
    await browser.close();
    served?.server.close();
  }
}

/**
 * Runs in the page: the outermost elements that stick out of the viewport sideways (the cause, not every child of
 * it), the number of text elements under 12px, and whether a mobile viewport meta tag is declared.
 */
function measureLayout(): Omit<LayoutReport, "viewport"> {
  const width = document.documentElement.clientWidth;
  const outside = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.right > width + 1 || r.left < -1); };
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 2).map(c => `.${c}`).join("")}`;
  const overflowing: string[] = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (!outside(el) || (el.parentElement && el.parentElement !== document.body && outside(el.parentElement))) continue;
    if (getComputedStyle(el).position === "fixed") continue;
    overflowing.push(`${name(el)} (${Math.round(el.getBoundingClientRect().width)}px wide)`);
    if (overflowing.length >= 8) break;
  }
  let smallText = 0;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent ?? "").trim());
    if (own && parseFloat(getComputedStyle(el).fontSize) < 12) smallText++;
  }
  return { width, pageWidth: document.documentElement.scrollWidth, overflowing, smallText, viewportMeta: Boolean(document.querySelector('meta[name="viewport"]')) };
}

/** A layout report in a few plain lines, for the agent and the user. */
export function describeLayout(l: LayoutReport): string {
  const lines = [`Layout (${l.viewport}): ${l.pageWidth > l.width + 1 ? `HORIZONTAL OVERFLOW — the page is ${l.pageWidth}px wide in a ${l.width}px viewport` : "fits the viewport width, no horizontal scrolling"}.`];
  if (l.overflowing.length) lines.push(`Elements sticking out of the viewport: ${l.overflowing.join(", ")}.`);
  if (l.viewport.startsWith("mobile") && !l.viewportMeta) lines.push('No <meta name="viewport" content="width=device-width, initial-scale=1"> tag: phones will render the page zoomed out.');
  if (l.smallText) lines.push(`${l.smallText} text element(s) are smaller than 12px.`);
  return lines.join("\n");
}
