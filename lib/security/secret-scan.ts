import fs from 'node:fs/promises';
import path from 'node:path';

export interface SecretFinding {
  file: string;
  line: number;
  pattern: string;
}

const SECRET_RULES: Array<{ name: string; regex: RegExp }> = [
  { name: 'Bearer literal token', regex: /Bearer\s+(?!\$|process\.env|DOWNLOADER_API_KEY|<)[A-Za-z0-9._-]{16,}/i },
  { name: 'Hardcoded x-dashboard-secret comparison', regex: /x-dashboard-secret[^\n]*!==\s*["'][A-Za-z0-9._-]{12,}["']/i },
  { name: 'Meta Graph user/page token literal', regex: /\bEAA[A-Za-z0-9]{20,}\b/ },
  { name: 'Supabase JWT token literal', regex: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/ },
  { name: 'Publicly prefixed service role env var', regex: new RegExp('NEXT_PUBLIC_' + 'SUPABASE_SERVICE_ROLE') },
  { name: 'PostgreSQL URL with embedded password', regex: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@/i },
  { name: 'Cloudinary API URL with credentials', regex: /https:\/\/[^:\s]+:[^@\s]+@api\.cloudinary\.com/i },
];

const CLIENT_FORBIDDEN_DIRS = ['components/', 'hooks/', 'app/dashboard/', 'app/create/', 'app/content/', 'app/media/', 'app/calendar/', 'app/published/', 'app/analytics/', 'app/executions/', 'app/recovery/', 'app/settings/'];

const SKIP_DIRS = new Set(['node_modules', '.next', '.test-dist', '.server-dist', '.git', '.local-data', '.backups']);

/** Scan repository files for hardcoded credential patterns and client secret exposure. */
export async function scanDirectoryForSecrets(rootDir: string): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!/\.(json|ts|tsx|mjs|js|py|md|yml|yaml|env|sql)$/i.test(entry.name) && !entry.name.endsWith('.env.example')) continue;
      if (entry.name.endsWith('.env.local') || entry.name === '.env') continue;

      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      const isClientFile = CLIENT_FORBIDDEN_DIRS.some((prefix) => relPath.startsWith(prefix));
      const content = await fs.readFile(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? '';
        for (const rule of SECRET_RULES) {
          if (rule.regex.test(lineText)) {
            findings.push({
              file: relPath,
              line: i + 1,
              pattern: rule.name,
            });
          }
        }
        if (isClientFile && (/SUPABASE_SERVICE_ROLE_KEY/.test(lineText) || /supabase\/server/.test(lineText))) {
          findings.push({
            file: relPath,
            line: i + 1,
            pattern: 'Client code must never reference SUPABASE_SERVICE_ROLE_KEY or server-only Supabase module',
          });
        }
      }
    }
  }

  await walk(rootDir);
  return findings;
}
