/** Starting files for a new project. Framework templates are plain source files; dependencies install on first preview. */
export const templates: Record<string, { label: string; description: string; files: Record<string, string> }> = {
  blank: { label: "Empty project", description: "No files yet", files: { "README.md": "# New project\n" } },
  static: {
    label: "HTML, CSS & JavaScript", description: "A static web page with live preview",
    files: {
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>My page</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <main>\n    <h1>Hello from Arbor</h1>\n    <p>Edit <code>index.html</code>, <code>style.css</code> and <code>script.js</code>.</p>\n    <button id="count">Clicked 0 times</button>\n  </main>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
      "style.css": `body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1410; color: #e8f3ec; }\nmain { text-align: center; }\nbutton { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #34d399; background: #0f2a1f; color: #a7f3d0; cursor: pointer; }\n`,
      "script.js": `const button = document.getElementById("count");\nlet count = 0;\nbutton.addEventListener("click", () => {\n  count += 1;\n  button.textContent = \`Clicked \${count} time\${count === 1 ? "" : "s"}\`;\n});\n`
    }
  },
  "vite-react": {
    label: "React (Vite)", description: "React app with Vite dev server; dependencies install on first preview",
    files: {
      "package.json": JSON.stringify({ name: "arbor-react-app", private: true, type: "module", scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { react: "^19.1.0", "react-dom": "^19.1.0" }, devDependencies: { "@vitejs/plugin-react": "^4.7.0", vite: "^6.3.0" } }, null, 2) + "\n",
      "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>React app</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>\n`,
      "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
      "src/App.jsx": `import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main style={{ fontFamily: "system-ui", padding: 40 }}>\n      <h1>Hello from React</h1>\n      <button onClick={() => setCount(c => c + 1)}>Clicked {count} times</button>\n    </main>\n  );\n}\n`
    }
  },
  node: {
    label: "Node.js script", description: "A Node.js program with a test using the built-in test runner",
    files: {
      "package.json": JSON.stringify({ name: "arbor-node-project", private: true, type: "module", scripts: { start: "node index.js", test: "node --test" } }, null, 2) + "\n",
      "math.js": `export function add(a, b) {\n  return a + b;\n}\n`,
      "index.js": `import { add } from "./math.js";\n\nconsole.log("2 + 3 =", add(2, 3));\n`,
      "math.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\n\ntest("adds numbers", () => {\n  assert.equal(add(2, 3), 5);\n});\n`
    }
  },
  python: {
    label: "Python", description: "A Python program with a pytest-style test",
    files: {
      "main.py": `def add(a, b):\n    return a + b\n\n\nif __name__ == "__main__":\n    print("2 + 3 =", add(2, 3))\n`,
      "test_main.py": `from main import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n`
    }
  }
};
