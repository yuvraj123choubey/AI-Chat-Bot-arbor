/**
 * Coding-agent evaluation tasks. Each task is a small real project, a request phrased the way a user would, and a
 * hidden checker that the agent never sees. Success means the hidden checker passes and the project's own
 * pre-existing tests still pass (no regressions).
 */
export interface EvalTask {
  id: string;
  category: "bug fix" | "feature" | "refactor" | "build repair" | "navigation" | "ui";
  request: string;
  files: Record<string, string>;
  /** Files written after the agent finishes, then `verify` is run; the agent cannot see or edit these. */
  hidden?: Record<string, string>;
  verify: { command: string } | { page: { path: string; click?: string; expectText: RegExp[]; forbidText?: RegExp[] } };
  /** The project's own checks that must still pass afterwards. */
  regression?: string;
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "eval", private: true, type: "module", scripts }, null, 2) + "\n";

export const tasks: EvalTask[] = [
  {
    id: "bugfix-discount", category: "bug fix",
    request: "Customers are being charged too much: an order of 4 items at $25 with the SAVE10 code should cost $90 but costs $100. Fix it.",
    files: {
      "package.json": pkg({ test: "node --test" }),
      "src/cart.js": "import { applyDiscount } from './discounts.js';\n\nexport function total(items, code) {\n  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  return applyDiscount(subtotal, code);\n}\n",
      "src/discounts.js": "const CODES = { SAVE10: 0.1, SAVE25: 0.25 };\n\nexport function applyDiscount(amount, code) {\n  const rate = CODES[code.toLowerCase()] ?? 0;\n  return Math.round(amount * (1 - rate) * 100) / 100;\n}\n",
      "test/cart.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\n\ntest('no code', () => assert.equal(total([{ price: 10, qty: 2 }], ''), 20));\n"
    },
    hidden: { "test/hidden.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\n\ntest('SAVE10', () => assert.equal(total([{ price: 25, qty: 4 }], 'SAVE10'), 90));\ntest('save25 lowercase', () => assert.equal(total([{ price: 100, qty: 1 }], 'save25'), 75));\ntest('unknown code', () => assert.equal(total([{ price: 5, qty: 1 }], 'NOPE'), 5));\n" },
    verify: { command: "node --test" }, regression: "node --test"
  },
  {
    id: "feature-median", category: "feature",
    request: "Add a median(numbers) function to the stats module, exported like the others. For an even count it returns the mean of the two middle values; for an empty array it throws an Error. Add a test for it.",
    files: {
      "package.json": pkg({ test: "node --test" }),
      "stats.js": "export function mean(numbers) {\n  if (!numbers.length) throw new Error('empty');\n  return numbers.reduce((a, b) => a + b, 0) / numbers.length;\n}\n\nexport function max(numbers) {\n  if (!numbers.length) throw new Error('empty');\n  return Math.max(...numbers);\n}\n",
      "stats.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean, max } from './stats.js';\n\ntest('mean', () => assert.equal(mean([1, 2, 3]), 2));\ntest('max', () => assert.equal(max([1, 5, 3]), 5));\n"
    },
    hidden: { "hidden.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { median } from './stats.js';\n\ntest('odd', () => assert.equal(median([3, 1, 2]), 2));\ntest('even', () => assert.equal(median([4, 1, 3, 2]), 2.5));\ntest('does not mutate', () => { const a = [3, 1, 2]; median(a); assert.deepEqual(a, [3, 1, 2]); });\ntest('empty', () => assert.throws(() => median([])));\n" },
    verify: { command: "node --test" }, regression: "node --test"
  },
  {
    id: "refactor-rename", category: "refactor",
    request: "Rename the function calc to computeTotal everywhere in the project (definition and every use). Behaviour must not change and the tests must still pass.",
    files: {
      "package.json": pkg({ test: "node --test" }),
      "src/pricing.js": "export function calc(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n",
      "src/invoice.js": "import { calc } from './pricing.js';\n\nexport function invoice(customer, items) {\n  return { customer, amount: calc(items) };\n}\n",
      "src/report.js": "import { calc } from './pricing.js';\n\nexport function report(orders) {\n  return orders.map(o => `${o.id}: ${calc(o.items)}`).join('\\n');\n}\n",
      "test/pricing.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { invoice } from '../src/invoice.js';\nimport { report } from '../src/report.js';\n\ntest('invoice', () => assert.equal(invoice('a', [{ price: 2, qty: 3 }]).amount, 6));\ntest('report', () => assert.equal(report([{ id: 1, items: [{ price: 1, qty: 1 }] }]), '1: 1'));\n"
    },
    hidden: { "test/hidden.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport * as pricing from '../src/pricing.js';\n\ntest('renamed', () => { assert.equal(typeof pricing.computeTotal, 'function'); assert.equal(pricing.calc, undefined); });\ntest('no calc left', () => { for (const f of ['src/pricing.js', 'src/invoice.js', 'src/report.js']) assert.doesNotMatch(readFileSync(f, 'utf8'), /\\bcalc\\b/); });\n" },
    verify: { command: "node --test" }, regression: "node --test"
  },
  {
    id: "build-repair", category: "build repair",
    request: "npm run build is failing. Make the build pass without deleting functionality.",
    files: {
      "package.json": pkg({ build: "node build.js", test: "node --test" }),
      "build.js": "import { renderPage } from './src/render.js';\nimport { mkdirSync, writeFileSync } from 'node:fs';\n\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.html', renderPage({ title: 'Shop', items: ['apple', 'pear'] }));\nconsole.log('built dist/index.html');\n",
      "src/render.js": "import { escapeHtml } from './escape.js';\n\nexport function renderPage({ title, items }) {\n  const list = items.map(item => `<li>${escapeHtml(item)}</li>`).join('');\n  return `<!doctype html><title>${escapeHtml(title)}</title><ul>${list}</ul>`;\n}\n",
      "src/escape.js": "export function escape(text) {\n  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n}\n",
      "test/render.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('placeholder', () => assert.ok(true));\n"
    },
    hidden: { "test/hidden.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { renderPage } from '../src/render.js';\n\ntest('escapes', () => assert.match(renderPage({ title: 'a<b', items: ['x&y'] }), /a&lt;b[\\s\\S]*x&amp;y/));\n" },
    verify: { command: "npm run build" }, regression: "node --test"
  },
  {
    id: "navigate-units", category: "navigation",
    request: "Temperatures in the weekly summary are wrong for Fahrenheit users: 100°C shows as 132°F instead of 212°F. Find the cause and fix it.",
    files: {
      "package.json": pkg({ test: "node --test" }),
      "app/index.js": "import { weeklySummary } from './summary/weekly.js';\n\nconsole.log(weeklySummary([20, 22, 19], 'F'));\n",
      "app/summary/weekly.js": "import { formatTemp } from '../format/temperature.js';\n\nexport function weeklySummary(celsius, unit) {\n  return celsius.map(c => formatTemp(c, unit)).join(', ');\n}\n",
      "app/format/temperature.js": "import { toFahrenheit } from '../../lib/units/convert.js';\n\nexport function formatTemp(celsius, unit) {\n  return unit === 'F' ? `${Math.round(toFahrenheit(celsius))}°F` : `${Math.round(celsius)}°C`;\n}\n",
      "lib/units/convert.js": "export function toFahrenheit(c) {\n  return c * 1 + 32;\n}\n\nexport function toKelvin(c) {\n  return c + 273.15;\n}\n",
      "lib/units/length.js": "export const inches = cm => cm / 2.54;\n",
      "app/format/date.js": "export const isoDay = d => d.toISOString().slice(0, 10);\n",
      "test/summary.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { weeklySummary } from '../app/summary/weekly.js';\n\ntest('celsius', () => assert.equal(weeklySummary([20], 'C'), '20°C'));\n"
    },
    hidden: { "test/hidden.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { weeklySummary } from '../app/summary/weekly.js';\n\ntest('fahrenheit', () => assert.equal(weeklySummary([100, 0, 37], 'F'), '212°F, 32°F, 99°F'));\n" },
    verify: { command: "node --test" }, regression: "node --test"
  },
  {
    id: "ui-counter", category: "ui",
    request: "On the shop page, the button should say \"Add to cart\" instead of \"Buy\", and each click should increase the number shown in the cart badge (the element with id cart-count). Right now clicking does nothing. Check it in the browser.",
    files: {
      "index.html": "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"><title>Shop</title><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body>\n  <header>Cart: <span id=\"cart-count\">0</span></header>\n  <main>\n    <h1>Green tea</h1>\n    <button id=\"buy\">Buy</button>\n  </main>\n  <script src=\"app.js\"></script>\n</body>\n</html>\n",
      "style.css": "body { font-family: sans-serif; }\n",
      "app.js": "const button = document.getElementById('buy');\nconst badge = document.getElementById('cart');\n\nbutton.addEventListener('click', () => {\n  badge.textContent = Number(badge.textContent) + 1;\n});\n"
    },
    verify: { page: { path: "index.html", click: "#buy", expectText: [/Add to cart/, /Cart:\s*1\b/], forbidText: [/\bBuy\b/] } }
  }
];
