import fs from 'node:fs';
const dir = '<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981';
const samples = fs.existsSync(`${dir}/probe-samples.jsonl`) ? fs.readFileSync(`${dir}/probe-samples.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const ids = ['unpatched','probe-full','probe-isolated','probe-cpu'].flatMap(kind => Array.from({length:kind==='unpatched'||kind==='probe-cpu'?5:10},(_,i)=>`${kind}-${i+1}`));
const read = name => fs.existsSync(`${dir}/${name}`) ? fs.readFileSync(`${dir}/${name}`,'utf8').trim() : null;
const range = (list,key) => list.length ? [Math.min(...list.map(s=>s[key])),Math.max(...list.map(s=>s[key]))] : null;
const runs = ids.map(id => {
  const log = read(`${id}.log`);
  return {id,command:read(`${id}.command`),exit:read(`${id}.exit`),started:read(`${id}.started`),finished:read(`${id}.finished`),sample:samples.find(s=>s.runId===id)||null,relevantLines:log?.split('\n').filter(line=>/does not reload workspace plugins|Test Files|Tests\s+|Duration\s+|AssertionError|expected \d+ to be|FAIL |CPU load:|CPU test exit=|CPU cleanup|\[test\].*(passed|failed)|timed out/.test(line))||[]};
});
const groups = ['unpatched','probe-full','probe-isolated','probe-cpu'].map(kind => {
  const groupRuns = runs.filter(r=>r.id.startsWith(`${kind}-`));
  const groupSamples = groupRuns.map(r=>r.sample).filter(Boolean);
  return {kind,planned:groupRuns.length,completed:groupRuns.filter(r=>r.exit!==null).length,passed:groupRuns.filter(r=>r.exit==='0').length,failed:groupRuns.filter(r=>r.exit!==null&&r.exit!=='0').length,samples:groupSamples.length,lower:groupSamples.filter(s=>s.preCount<s.settledCount).length,equal:groupSamples.filter(s=>s.preCount===s.settledCount).length,higher:groupSamples.filter(s=>s.preCount>s.settledCount).length,preRange:range(groupSamples,'preCount'),settledRange:range(groupSamples,'settledCount'),elapsedMsRange:range(groupSamples,'elapsedMs'),preReadMsRange:range(groupSamples,'preReadMs'),waitMsRange:range(groupSamples,'waitMs')};
});
console.log(JSON.stringify({groups,runs,duplicateSampleIds:samples.filter((s,i)=>samples.findIndex(t=>t.runId===s.runId)!==i).map(s=>s.runId)},null,2));
