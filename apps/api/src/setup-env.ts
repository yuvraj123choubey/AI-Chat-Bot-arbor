import { existsSync, readFileSync } from "node:fs";

/** Loads .env without overriding variables already set in the real environment. Values are never logged. */
if (existsSync(".env")) {
  for (const raw of stripBom(readFileSync(".env", "utf8")).split(/\r?\n/)) {
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    const quoted = value.match(/^(["'])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    process.env[match[1]] = value;
  }
}
function stripBom(text: string) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
