// Normalizes raw ATS responses into a flat shape:
//   { id, company, tier, ats, title, location_raw, locations, metro,
//     mode, salary_min_base, salary_max_base, posted_date,
//     apply_url, description, job_id_raw }

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ',
  '&rsquo;': '’', '&lsquo;': '‘',
  '&rdquo;': '”', '&ldquo;': '“',
  '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&trade;': '™',
  '&copy;': '©', '&reg;': '®',
};

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip|trade|copy|reg);/g, m => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s) {
  if (!s) return '';
  return decodeEntities(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLocationString(raw) {
  if (!raw) return [];
  return raw
    .split(/[|;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function metroFor(locStr, metroAliases) {
  if (!locStr) return null;
  const lower = locStr.toLowerCase();
  // longest alias keys first to avoid "san francisco" matching before "san francisco bay area"
  const keys = Object.keys(metroAliases).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (lower.includes(k)) return metroAliases[k];
  }
  if (/\bremote\b/.test(lower)) return 'remote';
  return 'other';
}

function pickPrimaryMetro(locations, metroAliases) {
  // Prefer first non-remote, non-other metro; then remote; then other.
  const tagged = locations.map(l => ({ loc: l, metro: metroFor(l, metroAliases) }));
  const concrete = tagged.find(t => t.metro && t.metro !== 'remote' && t.metro !== 'other');
  if (concrete) return concrete.metro;
  const remote = tagged.find(t => t.metro === 'remote');
  if (remote) return 'remote';
  return 'other';
}

const RE_DAYCOUNT = /(\d+)\s*(?:\+|or\s*more)?\s*days?\s*(?:\/|per\s*)?\s*(?:week|wk|in\s*(?:the\s*)?office|onsite|on[- ]site|in[- ]person)/i;

function detectMode({ ats, raw, locations, locationRaw, descriptionPlain }) {
  const desc = (descriptionPlain || '').toLowerCase();
  const locText = (locationRaw || locations.join(' | ')).toLowerCase();

  // Day-count is only used to refine hybrid → hybrid_4_plus, never to flip mode itself.
  const dayMatch = desc.match(RE_DAYCOUNT) || locText.match(RE_DAYCOUNT);
  const days = dayMatch ? parseInt(dayMatch[1], 10) : null;
  const refineHybrid = () => (days != null && days >= 4) ? 'hybrid_4_plus' : 'hybrid_2_3';

  // No location signal at all → fall back to ATS-structured field, then unknown.
  if (locations.length === 0) {
    if (ats === 'lever') {
      const wpt = (raw.workplaceType || '').toLowerCase();
      if (wpt === 'remote')  return 'fully_remote';
      if (wpt === 'hybrid')  return refineHybrid();
      if (wpt === 'onsite' || wpt === 'on-site') return 'fully_onsite';
    }
    if (ats === 'ashby') {
      if (raw.isRemote === true) return 'fully_remote';
      const wpt = (raw.workplaceType || '').toLowerCase();
      if (wpt === 'remote')  return 'fully_remote';
      if (wpt === 'hybrid')  return refineHybrid();
    }
    return 'unknown';
  }

  // Location-text detection is authoritative. Description boilerplate
  // ("we offer hybrid work") is intentionally NOT consulted. The Ashby
  // `isRemote` flag is also intentionally ignored when a location is
  // present — OpenAI/etc set it true on city-anchored roles.
  const locsLower = locations.map(l => l.toLowerCase());

  const allRemote = locsLower.every(l => /\bremote\b/.test(l));
  if (allRemote) return 'fully_remote';

  const anyRemote = locsLower.some(l => /\bremote\b/.test(l));
  const anyHybrid = locsLower.some(l => /\bhybrid\b/.test(l));

  if (anyHybrid) return refineHybrid();
  if (anyRemote && locations.length > 1) return 'remote_friendly';
  if (anyRemote) return 'fully_remote';

  // Cities only with no remote/hybrid in the location text. Defer to
  // Lever's structured workplaceType (reliable in practice). Ashby is
  // skipped: its isRemote flag mis-fires for OpenAI-style city-anchored
  // remote-eligible roles.
  if (ats === 'lever') {
    const wpt = (raw.workplaceType || '').toLowerCase();
    if (wpt === 'hybrid')  return refineHybrid();
    if (wpt === 'remote')  return 'remote_friendly';
  }

  return 'fully_onsite';
}

// --- Salary parsing ---------------------------------------------------------

function parseSalaryFromText(text) {
  if (!text) return { min: null, max: null };
  const re = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?(?:\s*USD)?\s*(?:[-–—]|to)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?\b/g;
  const candidates = [];
  for (const m of text.matchAll(re)) {
    const min = toNum(m[1], m[2]);
    const max = toNum(m[3], m[4]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    if (min < 30_000 || max < 30_000) continue;
    if (min > 5_000_000 || max > 5_000_000) continue;
    if (max < min) continue;
    // Avoid OTE / total-comp matches if context hints at it
    const start = Math.max(0, m.index - 40);
    const ctx = text.slice(start, m.index).toLowerCase();
    if (/\b(ote|total\s*comp|all[- ]in|on[- ]target)\b/.test(ctx)) continue;
    candidates.push({ min, max });
  }
  return candidates[0] || { min: null, max: null };
}

function toNum(numStr, suffix) {
  let n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!Number.isFinite(n)) return NaN;
  if (suffix && /[Kk]/.test(suffix)) n *= 1000;
  if (suffix && /[Mm]/.test(suffix)) n *= 1_000_000;
  return n;
}

function parseAshbyComp(comp) {
  if (!comp) return { min: null, max: null };
  const tiers = Array.isArray(comp.compensationTiers) ? comp.compensationTiers : [];
  for (const tier of tiers) {
    for (const c of (tier.components || [])) {
      if (c.compensationType === 'Salary' && c.interval === '1 YEAR' && c.currencyCode === 'USD'
          && Number.isFinite(c.minValue) && Number.isFinite(c.maxValue)) {
        return { min: c.minValue, max: c.maxValue };
      }
    }
  }
  for (const c of (comp.summaryComponents || [])) {
    if (c.compensationType === 'Salary' && c.interval === '1 YEAR' && c.currencyCode === 'USD'
        && Number.isFinite(c.minValue) && Number.isFinite(c.maxValue)) {
      return { min: c.minValue, max: c.maxValue };
    }
  }
  // String fallback like "$270K – $305K"
  if (comp.scrapeableCompensationSalarySummary) {
    return parseSalaryFromText(comp.scrapeableCompensationSalarySummary);
  }
  return { min: null, max: null };
}

// --- Per-ATS parsers --------------------------------------------------------

function parseGreenhouse(raw, company) {
  const description = stripHtml(raw.content || '');
  const locationRaw = raw.location && raw.location.name ? raw.location.name : '';
  const locations = splitLocationString(locationRaw);
  // Greenhouse rarely has structured pay; pay_input_ranges is the closest
  let salary = { min: null, max: null };
  if (Array.isArray(raw.pay_input_ranges) && raw.pay_input_ranges.length) {
    const r = raw.pay_input_ranges[0];
    if (Number.isFinite(r.min_cents) && Number.isFinite(r.max_cents)) {
      salary = { min: r.min_cents / 100, max: r.max_cents / 100 };
    }
  }
  if (salary.min == null) salary = parseSalaryFromText(description);
  return {
    job_id_raw: String(raw.id),
    title: raw.title || '',
    locationRaw,
    locations,
    description,
    posted_date: raw.first_published || raw.updated_at || null,
    apply_url: raw.absolute_url || '',
    salary_min_base: salary.min,
    salary_max_base: salary.max,
    raw,
  };
}

function parseLever(raw, company) {
  const description = stripHtml(raw.descriptionPlain || raw.description || '');
  const cats = raw.categories || {};
  const locationRaw = cats.location || '';
  const allLocs = Array.isArray(cats.allLocations) && cats.allLocations.length ? cats.allLocations : [];
  const locations = allLocs.length ? allLocs : splitLocationString(locationRaw);
  let salary = { min: null, max: null };
  if (raw.salaryRange && raw.salaryRange.currency === 'USD'
      && Number.isFinite(raw.salaryRange.min) && Number.isFinite(raw.salaryRange.max)) {
    salary = { min: raw.salaryRange.min, max: raw.salaryRange.max };
  } else {
    salary = parseSalaryFromText(description);
  }
  return {
    job_id_raw: raw.id,
    title: raw.text || '',
    locationRaw: locations.join(' | '),
    locations,
    description,
    posted_date: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
    apply_url: raw.applyUrl || raw.hostedUrl || '',
    salary_min_base: salary.min,
    salary_max_base: salary.max,
    raw,
  };
}

function parseAshby(raw, company) {
  const description = stripHtml(raw.descriptionPlain || raw.descriptionHtml || '');
  const primary = raw.location || '';
  const sec = Array.isArray(raw.secondaryLocations) ? raw.secondaryLocations.map(s => s.location).filter(Boolean) : [];
  const locations = [primary, ...sec].filter(Boolean);
  const locationRaw = locations.join(' | ');
  let salary = parseAshbyComp(raw.compensation);
  if (salary.min == null) salary = parseSalaryFromText(description);
  return {
    job_id_raw: raw.id,
    title: raw.title || '',
    locationRaw,
    locations,
    description,
    posted_date: raw.publishedAt || null,
    apply_url: raw.applyUrl || raw.jobUrl || '',
    salary_min_base: salary.min,
    salary_max_base: salary.max,
    raw,
  };
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  lever:      parseLever,
  ashby:      parseAshby,
};

function parsePosting(rawJob, company, config) {
  const parser = PARSERS[company.ats];
  if (!parser) throw new Error(`no parser for ats '${company.ats}'`);
  const base = parser(rawJob, company);
  const mode = detectMode({
    ats: company.ats,
    raw: rawJob,
    locations: base.locations,
    locationRaw: base.locationRaw,
    descriptionPlain: base.description,
  });
  const metro = pickPrimaryMetro(base.locations, config.metro_aliases);
  return {
    id: `${company.ats}:${company.slug}:${base.job_id_raw}`,
    company: company.name,
    tier: company.tier,
    ats: company.ats,
    title: base.title,
    location_raw: base.locationRaw,
    locations: base.locations,
    metro,
    mode,
    level: detectLevel(base.title),
    salary_min_base: base.salary_min_base,
    salary_max_base: base.salary_max_base,
    posted_date: base.posted_date,
    apply_url: base.apply_url,
    description: base.description,
  };
}

// Title-based level detection for realism scoring (Phase 1.3).
// Patterns evaluated in order; first match wins. The "ai_company_role" label
// is preserved as a distinct value (per spec), but the realism-table lookup
// folds it into "principal_senior".
function detectLevel(title) {
  const t = title || '';
  if (/\bSVP\b|\bEVP\b|Senior Vice President|Executive Vice President|\bChief\b|\bPresident\b/i.test(t)) {
    return 'executive_excluded';
  }
  if (/\bVP\b|Vice President|Head of/i.test(t)) {
    return 'vp_head';
  }
  if (/Senior Director|Sr\.? Director|Group Product Manager|\bGPM\b/i.test(t)) {
    return 'senior_director';
  }
  if (/\bDirector\b/i.test(t)) {
    return 'director';
  }
  if (/Principal Product|Senior Product Manager|Senior PM\b|Lead Product|Staff Product/i.test(t)) {
    return 'principal_senior';
  }
  if (/\bProduct Manager\b/i.test(t)) {
    return 'mid_level';
  }
  if (/Member of Technical Staff/i.test(t)) {
    return 'ai_company_role';
  }
  return 'unknown';
}

module.exports = {
  parsePosting,
  detectMode,
  detectLevel,
  parseSalaryFromText,
  parseAshbyComp,
  metroFor,
  pickPrimaryMetro,
  stripHtml,
};
