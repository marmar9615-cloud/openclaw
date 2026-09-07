import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = '<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981';
const out = path.join(dir,'redacted');
fs.mkdirSync(out,{recursive:true});
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const hostnames = [...new Set([os.hostname(),os.hostname().split('.')[0]])].filter(s=>s.length>2);
let count=0;
for (const name of fs.readdirSync(dir)) {
  if (!/\.(log|command|exit|started|finished|patch|json|jsonl|sh|mjs|txt)$/.test(name)) continue;
  let text = fs.readFileSync(path.join(dir,name),'utf8');
  text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replaceAll(os.homedir(),'<HOME>');
  for (const hostname of hostnames) text = text.replace(new RegExp(escape(hostname),'gi'),'<MACHINE>');
  fs.writeFileSync(path.join(out,name),text);
  count++;
}
console.log(`Redacted ${count} evidence files. Home directory and machine names replaced; raw local evidence retained.`);
