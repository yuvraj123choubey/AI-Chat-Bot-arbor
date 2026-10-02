import "./setup-env.ts";
import { providerLabel } from "../../../packages/ai/src/registry.ts";
import { createApp, type App } from "./app.ts";
import { createHttpServer } from "./http-server.ts";

const app = await createApp();
const port = Number(process.env.PORT || 8787);
createHttpServer(app).listen(port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
  describeSetup(app);
});

/** Startup summary so a missing key or model ID is obvious from the server log; never prints secrets. */
function describeSetup(app: App) {
  const ready = app.chatModels();
  if (ready.length) console.log(`Models ready: ${ready.map(m => `${m.id} (${providerLabel(m.provider)} ${m.modelId})`).join(", ")}`);
  else console.log("No models are ready. Add a provider API key and at least one model ID to .env (the API restarts automatically).");
  for (const provider of app.providers) {
    const named = app.registry.filter(m => m.provider === provider.name && m.enabled);
    if (named.length && !provider.isConfigured()) console.log(`${providerLabel(provider.name)}: model ID set (${named.map(m => m.modelIdEnv || m.id).join(", ")}) but no API key.`);
    if (!named.length && provider.isConfigured()) console.log(`${providerLabel(provider.name)}: API key set but no model ID; set one of ${app.registry.filter(m => m.provider === provider.name).map(m => m.modelIdEnv).filter(Boolean).join(", ")}.`);
    if (named.length && provider.isConfigured() && !app.policy.has(provider.name)) console.log(`${providerLabel(provider.name)}: configured but excluded by ALLOWED_PROVIDERS.`);
  }
  console.log(`Search: ${app.searchProviders.map(p => `${p.label} ${p.isConfigured() ? "ready" : "not configured"}`).join(", ")}`);
}
