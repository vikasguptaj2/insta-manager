import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const requireServer = createRequire(import.meta.url);

export function loadLocalEnv(envFile = '.env.local') {
  const full = path.join(ROOT_DIR, envFile);
  if (!fs.existsSync(full)) return { loaded: false, path: full };
  const raw = fs.readFileSync(full, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return { loaded: true, path: full };
}

export function loadServerModule(relPath) {
  const full = path.join(ROOT_DIR, '.server-dist', relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Compiled server build missing at ${full}. Run "npm run build:server" first.`);
  }
  return requireServer(full);
}
