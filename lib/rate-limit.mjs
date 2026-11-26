// Shared queue cooldown. Keep the failed row/error until reconciliation.
// One hour is our conservative local policy, not an Instagram recovery guarantee.
export function extractionCooldown(rows, now=Date.now()) {
 let until=0, unknown=false;
 for(const r of rows){
  const error=String(r.error??'');
  if(!/\bRATE_LIMIT\b|rate limited anonymous access|Downloader\s+429\b/i.test(error))continue;
  const at=Date.parse(String(r.processed_at??''));
  const marker=error.match(/\bretry-until=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/);
  const explicit=marker?Date.parse(marker[1]):NaN;
  if(!Number.isFinite(at)&&!Number.isFinite(explicit)){unknown=true;continue;}
  until=Math.max(until,Number.isFinite(at)?at+3600000:0,Number.isFinite(explicit)?explicit:0);
 }
 return {blocked:unknown||until>now,until:until?new Date(until).toISOString():null,unknown};
}