import { loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getOverviewData } = loadServerModule('lib/service.js');

console.log('=== InstaOps v2.0 Media Asset & State Reconciliation Report (Read-Only) ===');
const ov = await getOverviewData();
const postMap = new Map(ov.posts.map((p) => [p.post_id, p]));

const unmanaged = ov.assets.filter((a) => a.storage_status === 'UNMANAGED' || !a.cloudinary_public_id);
const orphaned = ov.assets.filter((a) => !postMap.has(a.post_id));
const stuckPosts = ov.posts.filter((p) =>
  ['EXTRACTING', 'UPLOADING', 'PUBLISHING', 'DELETING', 'VERIFY_MANUALLY'].includes(p.status),
);

console.log(`Posts: ${ov.posts.length} | Assets: ${ov.assets.length} | Active Locks: ${ov.locks.length}`);
console.log(`Unmanaged/Legacy Assets: ${unmanaged.length}`);
console.log(`Orphaned Assets (missing post_id): ${orphaned.length}`);
console.log(`Stuck or Verification-Required Posts: ${stuckPosts.length}`);

for (const p of stuckPosts) {
  console.log(`  - [POST] ${p.post_id}: status=${p.status}, container_id=${p.container_id || 'none'}, error=${p.error_code || 'none'}`);
}
for (const a of unmanaged) {
  console.log(`  - [UNMANAGED] ${a.internal_asset_id} (post=${a.post_id}): missing authoritative public_id`);
}
for (const a of orphaned) {
  console.log(`  - [ORPHANED] ${a.internal_asset_id} -> unknown post_id ${a.post_id}`);
}
