// Applies filters and fit scoring per config.json. Stateless.
//
// Filter order (each step can drop silently):
//   1. PM gate — title must match a config.pm_gate_patterns entry
//   2. Location filter — drop if location resolves to a blocked country/region
//   3. Excluded title — drop if title matches config.exclude_titles
//   4. Salary floor — surface in "excluded" section with a reason (not dropped)
//
// Output buckets:
//   - kept    : included in main feed, with fit_score + recommended_resume
//   - excluded: salary below floor — surfaced in excluded section with reason
//   - dropped : counts by reason (pm_gate / location / exclude_title)

function buildKeywordRegex(keyword) {
  // Word-boundary match for short tokens (≤4 chars, e.g. RTB, SSP, DSP, B2C, OTE);
  // substring match for multi-word phrases ("ad tech", "mobile app").
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (keyword.length <= 4 && /^[A-Za-z0-9]+$/.test(keyword)) {
    return new RegExp(`\\b${escaped}\\b`, 'i');
  }
  return new RegExp(escaped, 'i');
}

function compileKeywords(map) {
  const out = {};
  for (const [track, words] of Object.entries(map)) {
    out[track] = words.map(w => ({ keyword: w, re: buildKeywordRegex(w) }));
  }
  return out;
}

function scoreTrack(haystack, compiledList) {
  let count = 0;
  const matched = [];
  for (const { keyword, re } of compiledList) {
    if (re.test(haystack)) { count++; matched.push(keyword); }
  }
  return { count: Math.min(count, 5), matched };
}

function isExcludedTitle(title, excludeList) {
  const lower = (title || '').toLowerCase();
  for (const phrase of excludeList) {
    if (lower.includes(phrase.toLowerCase())) return phrase;
  }
  return null;
}

// Realism score lookup (Phase 1.3). Returns a multiplier in [0, 1] applied
// to fit_score to compute priority_score. Senior roles at elite-tier
// companies get heavily discounted; mid_level / principal_senior at any
// tier get full weight. ai_company_role folds into principal_senior.
function realismScore(tier, level, table) {
  if (level === 'executive_excluded') return 0.0;
  if (level === 'unknown') return 1.0;
  const lookupLevel = level === 'ai_company_role' ? 'principal_senior' : level;
  const row = (table || {})[String(tier)];
  if (!row) return 1.0;
  return Number.isFinite(row[lookupLevel]) ? row[lookupLevel] : 1.0;
}

// Compile each PM-gate pattern into either a substring matcher (for phrases)
// or a word-boundary regex (for short uppercase acronyms like PM/GPM/PMM/TPM).
// Word-boundary on the acronyms prevents false matches like "PMP" certs or
// "EPM" titles, while still catching "Senior PM", "Director PM,", etc.
function compilePmPatterns(patterns) {
  return patterns.map(p => {
    const trimmed = p.trim();
    const isAcronym = /^[A-Z]{1,4}$/.test(trimmed);
    if (isAcronym) {
      return { kind: 'word', re: new RegExp(`\\b${trimmed}\\b`, 'i'), label: trimmed };
    }
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { kind: 'substring', re: new RegExp(escaped, 'i'), label: trimmed };
  });
}

function passesPmGate(title, compiledPatterns) {
  for (const p of compiledPatterns) {
    if (p.re.test(title || '')) return p.label;
  }
  return null;
}

// --- Location filter -------------------------------------------------------

function locationStatus(locations, filters) {
  if (!locations || !locations.length) return { status: 'unknown', reason: 'no location' };

  let firstAllowed = null;
  let firstBlocked = null;

  for (const loc of locations) {
    const r = oneLocationStatus(loc, filters);
    if (r.status === 'allowed' && !firstAllowed) firstAllowed = r;
    if (r.status === 'blocked' && !firstBlocked) firstBlocked = r;
  }

  // Inclusion wins: if any single location is in an allowed region, keep.
  if (firstAllowed) return firstAllowed;
  if (firstBlocked) return firstBlocked;
  return { status: 'unknown', reason: 'no allowed/blocked signal' };
}

function oneLocationStatus(loc, filters) {
  const text = String(loc || '').trim();
  const lower = text.toLowerCase();
  if (!text) return { status: 'unknown', reason: 'empty' };

  // "Remote" alone (no region) → allowed, default to US-friendly per spec.
  if (/^remote\b\s*$/i.test(text)) {
    return { status: 'allowed', reason: 'remote (no region)' };
  }

  // "Remote - REGION" / "Remote, REGION" / "Remote — REGION".
  const rm = text.match(/\bremote\s*[-–—,]\s*(.+)$/i);
  if (rm) {
    const region = rm[1].trim().toLowerCase();
    for (const allow of filters.allowed_remote_regions || []) {
      if (containsTokenInsensitive(region, allow)) return { status: 'allowed', reason: `remote region "${allow}"` };
    }
    for (const block of filters.blocked_remote_regions || []) {
      if (containsTokenInsensitive(region, block)) return { status: 'blocked', reason: `remote region "${block}"` };
    }
    // Region might directly name a country; fall through to country checks.
  }

  // Allowed country word-boundary check.
  for (const c of filters.allowed_countries || []) {
    if (containsTokenInsensitive(lower, c)) return { status: 'allowed', reason: `country "${c}"` };
  }

  // US/Canada state/province code at end ("San Francisco, CA", "Toronto, ON").
  const stateCodes = (filters.allowed_state_codes || []).map(s => s.toUpperCase());
  const stateMatch = text.match(/,\s*([A-Za-z]{2})(?=\b|,|$|\s)/);
  if (stateMatch && stateCodes.includes(stateMatch[1].toUpperCase())) {
    return { status: 'allowed', reason: `state code "${stateMatch[1].toUpperCase()}"` };
  }

  // Blocked country / city.
  for (const c of filters.blocked_countries || []) {
    if (containsTokenInsensitive(lower, c)) return { status: 'blocked', reason: `country "${c}"` };
  }
  for (const c of filters.blocked_cities || []) {
    if (containsTokenInsensitive(lower, c)) return { status: 'blocked', reason: `city "${c}"` };
  }

  return { status: 'unknown', reason: 'no signal' };
}

function containsTokenInsensitive(haystack, needle) {
  if (!needle) return false;
  const n = String(needle).toLowerCase();
  // Multi-word needle → plain substring (already bounded by surrounding words).
  if (/\s/.test(n)) return haystack.includes(n);
  // Single word → word boundary.
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

function lookupFloor(metro, floors) {
  if (Object.prototype.hasOwnProperty.call(floors, metro)) return floors[metro];
  return floors.other;
}

function formatUSD(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

// AI-keyword detection for resume tagging. Word-boundary on short
// tokens (AI/ML/LLM); substring on multi-letter tokens (agent matches
// "agent" + "agentic"; "agency"/"agenda" are not substrings of "agent").
const AI_KEYWORD_RES = [
  /\bAI\b/i,
  /\bML\b/i,
  /\bMachine Learning\b/i,
  /\bLLM\b/i,
  /\bagent/i,
];

function hasAiKeyword(text) {
  if (!text) return false;
  for (const re of AI_KEYWORD_RES) if (re.test(text)) return true;
  return false;
}

function pickResumeTag(scores, posting, aiTierSet) {
  // 1. ads — strong ads signal beats AI tier.
  if (scores.ads >= 2 && scores.ads >= scores.consumer) return 'ads';

  // 2. aipm — either AI-tier company with a Product role, or any role
  //    whose title / first 200 chars of description mentions AI tokens.
  const titleHasProduct = /\bProduct\b/i.test(posting.title || '');
  if (aiTierSet.has(posting.company) && titleHasProduct) return 'aipm';
  const blob = `${posting.title || ''} ${(posting.description || '').slice(0, 200)}`;
  if (hasAiKeyword(blob)) return 'aipm';

  // 3. fallback — formerly "consumer" cases collapse here.
  return 'general';
}

function scoreOne(posting, config, compiled, aiTierSet, pmPatterns) {
  // 1. PM gate — must match a Product-related pattern. Silent drop.
  const pmHit = passesPmGate(posting.title, pmPatterns);
  if (!pmHit) return { bucket: 'dropped', reason: 'pm_gate' };

  // 2. Location filter — drop if location resolves to blocked country/region.
  const loc = locationStatus(posting.locations, config.location_filters || {});
  if (loc.status === 'blocked') return { bucket: 'dropped', reason: 'location', detail: loc.reason };

  // 3. Title exclusion (silent drop) — covers SVP/EVP that pass PM gate.
  const excludedTitle = isExcludedTitle(posting.title, config.exclude_titles);
  if (excludedTitle) return { bucket: 'dropped', reason: 'exclude_title', detail: excludedTitle };

  // Compute scores. fit_score is content-only (mode is a sort tiebreaker,
  // not a multiplier). priority_score = fit × realism is the canonical
  // sort key downstream — surfaces realistic, high-content roles.
  const haystack = `${posting.title} ${posting.description || ''}`;
  const ads = scoreTrack(haystack, compiled.ads);
  const consumer = scoreTrack(haystack, compiled.consumer);
  const baseFit = Math.max(ads.count, consumer.count);
  const realism = realismScore(posting.tier, posting.level, config.realism_scores);
  const priority = baseFit * realism;
  const recommended = pickResumeTag({ ads: ads.count, consumer: consumer.count }, posting, aiTierSet);

  const scored = {
    ...posting,
    ads_score: ads.count,
    consumer_score: consumer.count,
    ads_keywords: ads.matched,
    consumer_keywords: consumer.matched,
    base_fit: baseFit,
    fit_score: baseFit,
    realism_score: realism,
    priority_score: priority,
    recommended_resume: recommended,
  };

  // Rule 2 — salary floor (excluded section, not dropped)
  const floor = lookupFloor(posting.metro, config.salary_floors);
  if (Number.isFinite(posting.salary_max_base) && Number.isFinite(floor) && posting.salary_max_base < floor) {
    return {
      bucket: 'excluded',
      posting: {
        ...scored,
        exclusion_reason: `Max base ${formatUSD(posting.salary_max_base)} below ${posting.metro.toUpperCase()} floor of ${formatUSD(floor)}`,
      },
    };
  }

  return { bucket: 'kept', posting: scored };
}

function scoreAll(postings, config) {
  const compiled = compileKeywords(config.ats_track_keywords);
  const aiTierSet = new Set(config.ai_tier_companies || []);
  const pmPatterns = compilePmPatterns(config.pm_gate_patterns || []);
  const kept = [];
  const excluded = [];
  const dropped = { pm_gate: 0, location: 0, exclude_title: 0 };
  for (const p of postings) {
    const r = scoreOne(p, config, compiled, aiTierSet, pmPatterns);
    if (r.bucket === 'kept') kept.push(r.posting);
    else if (r.bucket === 'excluded') excluded.push(r.posting);
    else if (r.bucket === 'dropped') dropped[r.reason] = (dropped[r.reason] || 0) + 1;
  }
  return { kept, excluded, dropped };
}

module.exports = { scoreAll, scoreOne, compileKeywords, compilePmPatterns, passesPmGate, locationStatus, realismScore };
