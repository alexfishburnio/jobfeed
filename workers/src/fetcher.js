// ATS fetch with retry. No filesystem — safe for Workers runtime.

const USER_AGENT = 'alexfishburn.io job feed - alexfishburn@gmail.com';
const FETCH_TIMEOUT_MS = 60_000;

export const ATS_ENDPOINTS = {
  greenhouse: slug => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  lever:      slug => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  ashby:      slug => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${res.statusText} — ${txt.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractJobs(ats, payload) {
  if (ats === 'greenhouse') return Array.isArray(payload && payload.jobs) ? payload.jobs : [];
  if (ats === 'lever')      return Array.isArray(payload) ? payload : [];
  if (ats === 'ashby')      return Array.isArray(payload && payload.jobs) ? payload.jobs : [];
  return [];
}

export async function fetchCompany(company) {
  const urlBuilder = ATS_ENDPOINTS[company.ats];
  if (!urlBuilder) throw new Error(`unknown ATS '${company.ats}' for ${company.name}`);
  const url = urlBuilder(company.slug);
  let payload;
  try {
    payload = await fetchJson(url);
  } catch (err) {
    if (/aborted|fetch failed|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
      try {
        payload = await fetchJson(url);
      } catch (retryErr) {
        if (err.status && !retryErr.status) retryErr.status = err.status;
        throw retryErr;
      }
    } else {
      throw err;
    }
  }
  const jobs = extractJobs(company.ats, payload);
  return { company, url, jobs, payload };
}

export { USER_AGENT };
