import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";
import { insideProject } from "./paths.ts";

export interface PageAction { click?: string; fill?: { selector: string; value: string } }
export interface PageReport { url: string; title: string; text: string; consoleErrors: string[]; failedRequests: string[]; error?: string }

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
export async function viewPage(root: string, opts: { path?: string; url?: string; actions?: PageAction[] } = {}): Promise<PageReport> {
  const executablePath = findBrowser();
  if (!executablePath) return { url: "", title: "", text: "", consoleErrors: [], failedRequests: [], error: "No Chrome or Edge installation was found for page checks (set ARBOR_BROWSER to a browser executable)." };
  const { chromium } = await import("playwright-core");
  const served = opts.url ? undefined : await serveFolder(root);
  const url = opts.url ?? `${served!.url}${(opts.path ?? "index.html").replace(/^\/+/, "")}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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
    return { url, title: await page.title(), text: text.slice(0, 5000), consoleErrors: consoleErrors.slice(0, 20), failedRequests: [...new Set(failedRequests)].slice(0, 20) };
  } catch (error) {
    return { url, title: "", text: "", consoleErrors, failedRequests, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error) };
  } finally {
    await browser.close();
    served?.server.close();
  }
}
