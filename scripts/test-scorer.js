// Sanity-check scorer against parsed sample postings.

const fs = require('node:fs');
const path = require('node:path');
const { parsePosting } = require('../src/parser');
const { scoreAll } = require('../src/scorer');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const cases = [
  { file: 'samples/greenhouse-anthropic.json', company: { name: 'Anthropic', tier: 1, ats: 'greenhouse', slug: 'anthropic' }, jobsKey: 'jobs' },
  { file: 'samples/lever-mistral.json',        company: { name: 'Mistral',   tier: 3, ats: 'lever',      slug: 'mistral' },   jobsKey: null },
  { file: 'samples/ashby-whatnot.json',        company: { name: 'Whatnot',   tier: 3, ats: 'ashby',      slug: 'whatnot' },   jobsKey: 'jobs' },
];

const all = [];
for (const c of cases) {
  const payload = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  const rawJobs = c.jobsKey ? payload[c.jobsKey] : payload;
  for (const r of rawJobs) all.push(parsePosting(r, c.company, config));
}

const { kept, excluded, dropped } = scoreAll(all, config);
console.log(`postings: ${all.length}`);
console.log(`  kept:     ${kept.length}`);
console.log(`  excluded: ${excluded.length}  (salary below floor)`);
console.log(`  dropped:  ${dropped}  (excluded title — silent)`);

// Tag distribution
const tags = {};
for (const p of kept) tags[p.recommended_resume] = (tags[p.recommended_resume] || 0) + 1;
console.log('recommended_resume distribution (kept):', tags);

// Top 5 by fit_score
console.log('\nTop 5 kept by fit_score:');
const top = [...kept].sort((a, b) => b.fit_score - a.fit_score).slice(0, 5);
for (const p of top) {
  console.log(`  [${p.fit_score.toFixed(1)}] ${p.recommended_resume.padEnd(8)} | ${p.company} | ${p.title} | ${p.metro}/${p.mode} | salary ${p.salary_min_base}-${p.salary_max_base}`);
}

// 5 excluded examples
console.log('\nExamples excluded:');
for (const p of excluded.slice(0, 5)) {
  console.log(`  ${p.company} | ${p.title} | ${p.exclusion_reason}`);
}

// A handful with "Chief" or "VP" titles to verify silent drop path
const droppedSamples = all.filter(p => /\bchief\b|\bvp\b|president|svp|evp/i.test(p.title)).slice(0, 5);
console.log('\nSilent-drop candidates seen in input:');
for (const p of droppedSamples) console.log(`  ${p.company} | ${p.title}`);
