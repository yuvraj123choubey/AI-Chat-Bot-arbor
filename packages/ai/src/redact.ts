/**
 * Removes credentials from text before it is logged. Provider error bodies sometimes echo part of a key,
 * so both the configured secret values and common key shapes are scrubbed.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET)$/.test(name) && value && value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out.replace(/\b(sk-[A-Za-z0-9_*-]{6,}|AIza[0-9A-Za-z_-]{10,})/g, "[redacted]");
}
