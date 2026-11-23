import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

test('every runtime text passed to t() has a Spanish translation, and none is left over', () => {
  const keys = new Set<string>();
  for (const f of ['src/extension.ts', 'src/tree.ts']) {
    for (const m of read(f).matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  const bundle = Object.keys(JSON.parse(read('l10n/bundle.l10n.es.json')));
  assert.deepEqual([...keys].filter(k => !bundle.includes(k)), [], 'missing in l10n/bundle.l10n.es.json');
  assert.deepEqual(bundle.filter(k => !keys.has(k)), [], 'unused in l10n/bundle.l10n.es.json');
});

test('every %key% in package.json exists in both package.nls files', () => {
  const pkg = read('package.json');
  const used = [...pkg.matchAll(/"%([^%]+)%"/g)].map(m => m[1]);
  const en = JSON.parse(read('package.nls.json')), es = JSON.parse(read('package.nls.es.json'));
  assert.ok(used.length > 20);
  assert.deepEqual(used.filter(k => !(k in en)), []);
  assert.deepEqual(used.filter(k => !(k in es)), []);
});
