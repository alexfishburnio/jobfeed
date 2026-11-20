// KV + R2 adapters. Keys/paths are fixed strings so KV/R2 contents are
// deterministic and inspectable from the dashboard.

// ---- KV --------------------------------------------------------------------
//
// STATE_KEY        — latest diff state (JSON blob matching data/state.json)
// HEALTH_KEY       — per-company slug health history
// COMPANIES_KEY    — array of { name, tier, ats, slug }; updated by slug-recovery
// APPLIED_KEY      — reserved for future "applied" tracking: { id -> { applied_at } }

export const STATE_KEY     = 'state';
export const HEALTH_KEY    = 'health';
export const COMPANIES_KEY = 'companies';
export const APPLIED_KEY   = 'applied';

export async function kvGetJson(kv, key) {
  const raw = await kv.get(key, 'json');
  return raw ?? null;
}

export async function kvPutJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

// ---- R2 --------------------------------------------------------------------
//
// R2 layout:
//   snapshots/YYYY-MM-DD.json    — full daily snapshot (bulky)
//   feed.json                    — public-read, consumed by the /jobs page
//
// snapshots/ are listed by the weekly worker to grab the last 7 days.

export const FEED_KEY = 'feed.json';
export const SNAPSHOT_PREFIX = 'snapshots/';

export function snapshotKeyFor(date) {
  return `${SNAPSHOT_PREFIX}${date}.json`;
}

export async function r2GetJson(r2, key) {
  const obj = await r2.get(key);
  if (!obj) return null;
  return await obj.json();
}

export async function r2PutJson(r2, key, value, { contentType = 'application/json', publicAccess = false } = {}) {
  const body = JSON.stringify(value);
  const httpMetadata = { contentType };
  if (publicAccess) {
    // r2 objects don't have per-key public access — bucket-level setting controls it.
    // We still set Cache-Control to help the CDN.
    httpMetadata.cacheControl = 'public, max-age=300';
  }
  await r2.put(key, body, { httpMetadata });
}

// List the N most recent daily snapshot keys under snapshots/, newest-first.
export async function r2ListRecentSnapshots(r2, limit = 7) {
  const listed = await r2.list({ prefix: SNAPSHOT_PREFIX, limit: 1000 });
  const keys = (listed.objects || [])
    .map(o => o.key)
    .filter(k => /^snapshots\/\d{4}-\d{2}-\d{2}\.json$/.test(k))
    .sort()
    .reverse()
    .slice(0, limit);
  return keys;
}
