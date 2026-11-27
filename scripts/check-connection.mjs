import { loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getReadinessDiagnostics } = loadServerModule('lib/service.js');

console.log('=== InstaOps v2.0 Live Service & Workflow Connectivity Probe ===');
const { readiness, connections, validation, requestId, checkedAt } =
  await getReadinessDiagnostics(fetch, { forceRefresh: true });

console.log(`Request ID: ${requestId} · Checked At: ${checkedAt}`);
console.log(
  `Config valid: ${validation.valid} · Errors: ${validation.errors.length} · Warnings: ${validation.warnings.length}`,
);

if (validation.errors.length > 0) {
  console.log('\nConfiguration Errors:');
  for (const err of validation.errors) console.log(`  [ERROR] ${err}`);
}

console.log('\nService Connections:');
for (const svc of connections) {
  const lat = svc.latencyMs !== undefined ? ` (${svc.latencyMs}ms)` : '';
  const state = svc.diagnosticState ? ` [${svc.diagnosticState}]` : '';
  const http = svc.httpStatus ? ` HTTP ${svc.httpStatus}` : '';
  const exec = svc.executionId ? ` exec=${svc.executionId}` : '';
  console.log(
    `[${svc.status.toUpperCase().padEnd(12)}] ${svc.name}${state}${http}${lat}${exec} -> ${svc.detail}`,
  );
}

console.log('\nRuntime Safety Gates (DB + Env Fail-Closed):');
console.log(
  `  Runtime Settings RPC: ${readiness.runtimeSettingsAvailable ? 'AVAILABLE' : 'UNAVAILABLE (fail-closed)'} | ` +
    `live_publish=${Boolean(readiness.livePublishGateEnabled)} | ` +
    `live_delete=${Boolean(readiness.liveDeleteGateEnabled)} | ` +
    `scheduling=${Boolean(readiness.schedulingGateEnabled)}`,
);
console.log(
  `  Readiness: extract=${readiness.readyForExtraction} | publish=${readiness.readyForPublishing} | delete=${readiness.readyForDeletion} | schedule=${Boolean(readiness.readyForScheduling)}`,
);

if (Array.isArray(readiness.workflowReports) && readiness.workflowReports.length > 0) {
  console.log('\nn8n Workflow Integrity Reports:');
  for (const wf of readiness.workflowReports) {
    const flags = [];
    if (!wf.configured) flags.push('UNCONFIGURED');
    if (!wf.reachable) flags.push('UNREACHABLE');
    if (!wf.active) flags.push(wf.required ? 'INACTIVE' : 'PAUSED_INTENTIONALLY');
    if (wf.hasDuplicateCanvasSuspected) flags.push('DUPLICATE_CANVAS');
    if (wf.conflictingActiveWorkflowIds.length > 0) {
      flags.push(`WEBHOOK_CONFLICT(${wf.conflictingActiveWorkflowIds.join(',')})`);
    }
    if (wf.hasUnboundPlaceholders) flags.push('UNBOUND_PLACEHOLDERS');
    if (wf.hasLegacyIfSchema) flags.push('LEGACY_IF_V1');
    if (wf.hasBrokenConnections) flags.push('BROKEN_CONNECTIONS');
    const summary = flags.length > 0 ? flags.join(', ') : 'OK';
    console.log(
      `  [${wf.integrityOk ? 'OK  ' : wf.required ? 'FAIL' : 'WARN'}] ${wf.role} (${wf.workflowId || 'missing'}) nodes=${wf.nodeCount}/${wf.expectedMaxNodes} active=${wf.active} -> ${summary}`,
    );
    for (const err of wf.errors) {
      console.log(`      error: ${err}`);
    }
    for (const warn of wf.warnings) {
      console.log(`      warn:  ${warn}`);
    }
  }
}

const requiredN8nFailed =
  !readiness.n8nAuthenticated ||
  connections.some((r) => (r.id === 'supabase' || r.id === 'n8n') && r.status === 'offline') ||
  (readiness.workflowReports ?? []).some((w) => w.required && !w.integrityOk);

if (!validation.valid || !readiness.supabaseReachable || requiredN8nFailed) {
  process.exitCode = 1;
}
