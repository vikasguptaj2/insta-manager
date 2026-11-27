import { loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConnectionsHealth } = loadServerModule('lib/service.js');

console.log('=== InstaOps v2.0 Service Connectivity Probe ===');
const results = await getConnectionsHealth();
for (const svc of results) {
  const lat = svc.latencyMs !== undefined ? ` (${svc.latencyMs}ms)` : '';
  console.log(`[${svc.status.toUpperCase().padEnd(12)}] ${svc.name}${lat} -> ${svc.detail}`);
}

if (results.some((r) => r.status === 'offline' && r.id !== 'ai')) {
  process.exitCode = 1;
}
