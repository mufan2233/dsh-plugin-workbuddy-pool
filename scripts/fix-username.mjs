// Replace the publication placeholders with the real GitHub owner.
//
// Deliberately NOT a blind "replace USERNAME" over the tree: `env.USERNAME` is a
// Windows environment variable read at runtime (lib/index.js, vendor/config.mjs,
// vendor/lib/diagnostics.mjs). Rewriting those would break local-token ACL
// ownership checks. Only the repository-URL shapes are touched.
//
//   node fix-username.mjs <owner>          apply
//   node fix-username.mjs <owner> --check  report only

import { readFileSync, writeFileSync } from 'node:fs';

const owner = process.argv[2];
const checkOnly = process.argv.includes('--check');

if (!owner || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) {
  console.error('usage: node fix-username.mjs <github-owner> [--check]');
  process.exit(2);
}

/**
 * Only these exact prefixes are placeholders. Anything else containing the word
 * USERNAME (notably `process.env.USERNAME`) must survive untouched.
 */
const REPO = 'dsh-plugin-workbuddy-pool';
const shapes = [
  `github:USERNAME/${REPO}`,
  `github.com/USERNAME/${REPO}`,
  `github.com/USERNAME/${REPO}.git`,
];

const files = [
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'PUBLISHING.md',
  'lib/client.js',
];

let replaced = 0;
let remaining = [];
let skippedEnv = 0;

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let after = before;

  /* Replace longest placeholder shapes first so `github.com/USERNAME/x` is not
     half-consumed by the shorter `github:USERNAME/x` rule. */
  const ordered = [...shapes].sort((a, b) => b.length - a.length);
  for (const shape of ordered) {
    const hit = after.split(shape).length - 1;
    if (hit > 0) {
      /* PUBLISHING.md teaches the replacement; its placeholders are instructions,
         not links, so they stay as-is. */
      if (file === 'PUBLISHING.md') continue;
      after = after.replaceAll(shape, shape.replace('USERNAME', owner));
      replaced += hit;
    }
  }

  if (after !== before && !checkOnly) writeFileSync(file, after);

  /* Report every surviving USERNAME, then classify it. */
  after.split('\n').forEach((line, i) => {
    if (!line.includes('USERNAME')) return;
    if (/env\.USERNAME|process\.env\.USERNAME|%USERNAME%/.test(line)) {
      skippedEnv++;
      return;
    }
    remaining.push(`${file}:${i + 1}  ${line.trim().slice(0, 110)}`);
  });
}

console.log(`${checkOnly ? '[check]' : '[apply]'} owner=${owner}`);
console.log(`  repository-URL placeholders ${checkOnly ? 'found' : 'replaced'}: ${replaced}`);
console.log(`  runtime env.USERNAME occurrences left alone: ${skippedEnv}`);
console.log(`  non-env USERNAME left: ${remaining.length}`);
for (const line of remaining) console.log(`    ${line}`);

/* After an apply run, any non-env USERNAME other than PUBLISHING.md's
   instructions is a real miss. */
const actionable = remaining.filter((l) => !l.startsWith('PUBLISHING.md:'));
if (!checkOnly && actionable.length > 0) {
  console.error(`\nFAIL: ${actionable.length} placeholder(s) survived outside PUBLISHING.md`);
  process.exit(1);
}
console.log(`\nresult: ${actionable.length === 0 ? 'OK' : 'PENDING'}`);
process.exit(actionable.length === 0 ? 0 : checkOnly ? 0 : 1);
