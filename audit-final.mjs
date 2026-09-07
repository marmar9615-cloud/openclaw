import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const dir = '<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981';
const cwd = '<HOME>/Desktop/oss/<WORKTREE>';
const head = '7d0098415ba17bf1f21af2cf6ff5977bb8415f86';
const read = name => fs.readFileSync(`${dir}/${name}`,'utf8');
const git = (...args) => execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'file'}});
assert.equal(git('rev-parse','HEAD').trim(),head);
assert.equal(git('diff','--name-only'),'');
assert.equal(git('diff','--cached','--name-only'),'');
assert(git('status','--porcelain').split('\n').filter(Boolean).every(line=>line==='?? .install-done'));
const baselinePatch = read('unpatched.patch');
assert.equal((baselinePatch.match(/^diff --git /gm)||[]).length,1);
assert.equal((baselinePatch.match(/^@@ /gm)||[]).length,1);
assert.equal(baselinePatch.split('\n').filter(line=>line.startsWith('-')&&!line.startsWith('---')).map(line=>line.slice(1)).join('\n'), "        // The baseline counts startup's own workspace-plugin load, which the deferred\n        // sidecars publish. Without this the read races that load and the baseline moves.\n        await server.startupSettled;\n");
assert.equal(baselinePatch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).length,0);
const ids = ['unpatched','probe-full','probe-isolated','probe-cpu'].flatMap(kind=>Array.from({length:kind==='unpatched'||kind==='probe-cpu'?5:10},(_,i)=>`${kind}-${i+1}`));
const samples = read('probe-samples.jsonl').trim().split('\n').map(JSON.parse);
assert.equal(samples.length,25);
assert.deepEqual(samples.map(s=>s.runId).sort(),ids.filter(id=>id.startsWith('probe-')).sort());
for (const sample of samples) {
  assert.equal(sample.head,head);
  for (const key of ['preCount','settledCount','preReadMs','waitMs','elapsedMs','settledReadMs']) assert(Number.isFinite(sample[key])&&sample[key]>=0,`${sample.runId} invalid ${key}`);
  for (const key of ['helperResolvedAt','preSampleAt','settledAt','settledSampleAt']) assert(Number.isFinite(Date.parse(sample[key])),`${sample.runId} invalid ${key}`);
}
for (const id of ids) {
  assert(/^\d+\s*$/.test(read(`${id}.exit`)),`${id} missing exit`);
  assert(read(`${id}.command`).trim(),`${id} missing command`);
  assert(read(`${id}.gate.log`).trim().endsWith('gate clear'),`${id} missing gate clearance`);
  assert(Number.isFinite(Date.parse(read(`${id}.started`).trim())));
  assert(Number.isFinite(Date.parse(read(`${id}.finished`).trim())));
  const log = read(`${id}.log`);
  if (id.startsWith('probe-cpu-')) {
    assert(log.includes('CPU load: 10 yes processes, one per logical core'));
    assert(!log.includes('CPU cleanup FAILED'));
    const pids = [...log.matchAll(/CPU cleanup confirmed pid=(\d+)/g)].map(m=>Number(m[1]));
    assert.equal(pids.length,10);
    assert.equal(new Set(pids).size,10);
    for (const pid of pids) {
      let exists=true;
      try { process.kill(pid,0); } catch (error) { assert.equal(error.code,'ESRCH'); exists=false; }
      assert(!exists,`CPU pid ${pid} still exists`);
    }
  }
}
for (const name of ['install','baseline-restore','baseline-restored-diff','unpatched-audit','probe-audit','probe-diff-check','scripts-syntax','final-restore','final-status','final-diff']) assert.equal(read(`${name}.exit`).trim(),'0',`${name} failed`);
console.log('PASS: exact HEAD, no staged or unstaged tracked changes, status empty except permitted install marker.');
console.log('PASS: baseline patch removes exactly the requested four lines in one hunk.');
console.log('PASS: 30 unique run records with exits, commands, gate clearances and timestamps; 25 unique finite counter samples.');
console.log('PASS: all 50 CPU burner PIDs were logged as cleaned up and are no longer present.');
console.log('Run outcomes remain independently recorded in each .exit file; no result is excluded by this audit.');
