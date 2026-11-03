import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, scorePackage, scoreAll, ruleFlags } from '../src/scoring.js';

test('allocation always sums to the budget in cents', () => {
  for (const budget of [5, 10, 20, 50]) {
    const out = allocate({ a: 50, b: 30, c: 15, d: 4.9, e: 0.1 }, budget, 1);
    const total = Math.round(Object.values(out).reduce((t, x) => t + x, 0) * 100);
    assert.equal(total, budget * 100);
    Object.values(out).forEach(v => assert.ok(v >= 1));
  }
});
test('tiny shares are dropped and redistributed', () => {
  const out = allocate({ a: 90, b: 9, c: 0.2 }, 5, 1);
  assert.ok(!('c' in out));
});
test('solo, unfunded, imported package outranks a funded organisation', () => {
  const ctx = { maxImports: 6, maxDownloads: 9e6 };
  const base = { kind: 'runtime', archived: false, deprecated: false, lastPush: '2026-10-01T00:00:00Z', name: 'x' };
  const solo = scorePackage({ ...base, npmMaintainers: 1, contributors: 1, hasFunding: false, ownerType: 'User', imports: 6, downloads: 1e6 }, ctx, Date.parse('2026-11-01'));
  const org = scorePackage({ ...base, npmMaintainers: 9, contributors: 200, hasFunding: true, ownerType: 'Organization', imports: 6, downloads: 9e6 }, ctx, Date.parse('2026-11-01'));
  assert.ok(solo.score > org.score);
});
test('archived or deprecated packages are not eligible', () => {
  const r = scoreAll([{ name: 'a', kind: 'runtime', archived: true, downloads: 10, npmMaintainers: 1, lastPush: '2020-01-01T00:00:00Z' }]);
  assert.equal(r[0].eligible, false);
  assert.ok(r[0].flags.length > 0);
});
test('typo-squat heuristic flags look-alike names with few downloads', () => {
  assert.ok(ruleFlags({ name: 'lodahs', downloads: 100 }).some(f => /typo-squat/.test(f)));
  assert.ok(!ruleFlags({ name: 'lodash', downloads: 100 }).some(f => /typo-squat/.test(f)));
});
