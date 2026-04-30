// One-off: fetch 3 sample companies (one per ATS) and dump raw responses
// to samples/ so the parser can be written against real shapes.

const fs = require('node:fs');
const path = require('node:path');
const { fetchCompany } = require('../src/fetcher');

const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TARGETS = [
  { name: 'Anthropic', tier: 1, ats: 'greenhouse', slug: 'anthropic' },
  { name: 'Mistral',   tier: 3, ats: 'lever',      slug: 'mistral' },
  { name: 'Whatnot',   tier: 3, ats: 'ashby',      slug: 'whatnot' },
];

(async () => {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  let first = true;
  for (const c of TARGETS) {
    if (!first) await sleep(1500);
    first = false;
    process.stderr.write(`fetching ${c.ats}/${c.slug}... `);
    try {
      const { jobs, payload } = await fetchCompany(c);
      const file = path.join(SAMPLES_DIR, `${c.ats}-${c.slug}.json`);
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      process.stderr.write(`${jobs.length} jobs → ${path.basename(file)}\n`);
      // Also drop the first job alone for quick reading
      if (jobs.length) {
        const first = path.join(SAMPLES_DIR, `${c.ats}-${c.slug}.first-job.json`);
        fs.writeFileSync(first, JSON.stringify(jobs[0], null, 2));
      }
    } catch (err) {
      process.stderr.write(`FAILED: ${err.message}\n`);
    }
  }
})();
