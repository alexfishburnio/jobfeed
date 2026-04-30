// Sanity-check the parser against the 3 captured samples.

const fs = require('node:fs');
const path = require('node:path');
const { parsePosting } = require('../src/parser');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const cases = [
  { file: 'samples/greenhouse-anthropic.json', company: { name: 'Anthropic', tier: 1, ats: 'greenhouse', slug: 'anthropic' }, jobsKey: 'jobs' },
  { file: 'samples/lever-mistral.json',        company: { name: 'Mistral',   tier: 3, ats: 'lever',      slug: 'mistral' },   jobsKey: null },
  { file: 'samples/ashby-whatnot.json',        company: { name: 'Whatnot',   tier: 3, ats: 'ashby',      slug: 'whatnot' },   jobsKey: 'jobs' },
];

for (const c of cases) {
  const payload = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  const rawJobs = c.jobsKey ? payload[c.jobsKey] : payload;
  const parsed = rawJobs.map(j => parsePosting(j, c.company, config));

  const modeBuckets = {};
  const metroBuckets = {};
  let withSalary = 0;
  for (const p of parsed) {
    modeBuckets[p.mode] = (modeBuckets[p.mode] || 0) + 1;
    metroBuckets[p.metro] = (metroBuckets[p.metro] || 0) + 1;
    if (p.salary_max_base != null) withSalary++;
  }
  console.log(`=== ${c.company.name} (${c.company.ats}) — ${parsed.length} postings ===`);
  console.log('  mode  :', modeBuckets);
  console.log('  metro :', metroBuckets);
  console.log('  with salary:', withSalary, '/', parsed.length);
  // 2 example outputs
  for (const p of parsed.slice(0, 2)) {
    console.log('  ---');
    console.log('  title:', p.title);
    console.log('  metro/mode:', p.metro, '/', p.mode);
    console.log('  loc:', p.location_raw);
    console.log('  salary:', p.salary_min_base, '-', p.salary_max_base);
    console.log('  url:', p.apply_url);
    console.log('  posted:', p.posted_date);
    console.log('  id:', p.id);
  }
}
