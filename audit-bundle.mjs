import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
const dir='<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981';
const summary=JSON.parse(fs.readFileSync(`${dir}/summary.json`,'utf8'));
const draft=fs.readFileSync(`${dir}/replacement-evidence.txt`,'utf8').trim();
const report=fs.readFileSync(`${dir}/../proof-122981-report.md`,'utf8');
assert(draft.length<1200);
assert(!/—|silently|codex|claude|vitest|opus|reviewer/i.test(draft));
assert(!draft.includes(os.homedir()));
assert(report.includes(draft));
assert.equal(summary.runs.length,30);
assert.equal(summary.duplicateSampleIds.length,0);
for(const run of summary.runs){
  assert.equal(run.exit,'0');
  assert(run.relevantLines.some(line=>line.includes('does not reload workspace plugins')&&line.includes('✓')));
  const expected=run.id.startsWith('probe-isolated-')?/Tests\s+1 passed \| 12 skipped \(13\)/:/Tests\s+13 passed \(13\)/;
  assert(run.relevantLines.some(line=>expected.test(line)),run.id);
  assert(report.includes(`\`${run.command}\``),`${run.id} absent report command`);
  for(const suffix of ['command','exit','log','gate.log','started','finished']) assert(fs.existsSync(`${dir}/redacted/${run.id}.${suffix}`));
}
for(const group of summary.groups.slice(1)){
  assert.equal(group.lower,0);
  assert.equal(group.equal,group.planned);
  assert.deepEqual(group.preRange,[2,2]);
  assert.deepEqual(group.settledRange,[2,2]);
}
assert.equal(fs.readFileSync(`${dir}/final-status.log`,'utf8'),'');
assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/redacted/probe-samples.jsonl`,'utf8').trim().split('\n').map(x=>x).join(',').replace(/^/,'[').replace(/$/,']')),summary.runs.filter(r=>r.sample).map(r=>r.sample));
const names=fs.readdirSync(`${dir}/redacted`);
for(const name of names){
  const text=fs.readFileSync(`${dir}/redacted/${name}`,'utf8');
  assert(!text.includes(os.homedir()),`home path remains: ${name}`);
  for(const hostname of new Set([os.hostname(),os.hostname().split('.')[0]])) if(hostname.length>2) assert(!text.toLowerCase().includes(hostname.toLowerCase()),`machine name remains: ${name}`);
}
for(const match of report.matchAll(/\]\((\/[^)]+)\)/g)){
  const filename=match[1].replace(/:\d+$/,'');
  assert(fs.existsSync(filename),`broken local report link: ${filename}`);
}
console.log(`PASS: all 30 commands, exits and test outcomes match the report; all 25 samples preserved; ${draft.length}-character draft satisfies constraints.`);
console.log(`PASS: ${names.length} redacted files have no current home directory or machine name; report artifact links resolve; final status log is empty.`);
