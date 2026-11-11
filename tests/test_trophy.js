'use strict';
var assert = require('assert');
var T = require('../src/agent_timelines/trophy.js');

var save = {
  list: [['a', 'Alpha', 'do a'], ['b', 'Beta', 'do b'], ['c', 'Gamma', 'do c'], ['d', 'Delta', 'do d']],
  unlocked: { c: { t: 300, sid: 's3' }, a: { t: 100, sid: 's1' }, gone: { t: 5, sid: 'x' } },
  totals: { heroes: 12, sessions: 3, usd: 4.5, streak: 2 }
};

// rows keep the file's order, mark what is unlocked, and ignore unlocks the list does not know
var r = T.rows(save);
assert.deepStrictEqual(r.map(function (x) { return x.id + (x.got ? '+' : '-'); }), ['a+', 'b-', 'c+', 'd-']);
assert.deepStrictEqual([r[0].t, r[0].sid, r[1].t, r[1].sid, r[0].desc], [100, 's1', 0, '', 'do a']);
assert.deepStrictEqual(T.count(save), { got: 2, all: 4 });
assert.deepStrictEqual(T.totals(save), { heroes: 12, sessions: 3, usd: 4.5, streak: 2 });

// fresh: unlocked and not seen, oldest first
assert.deepStrictEqual(T.fresh(save, []).map(function (x) { return x.id; }), ['a', 'c']);
assert.deepStrictEqual(T.fresh(save, ['a']).map(function (x) { return x.id; }), ['c']);
assert.deepStrictEqual(T.fresh(save, ['a', 'c', 'b']), [], 'a locked id in seen changes nothing');
assert.deepStrictEqual(T.fresh(save, null).length, 2, 'no seen list = nothing seen');

// pick: a session's badges, unknown ids skipped
assert.deepStrictEqual(T.pick(save, ['d', 'zzz', 'a']).map(function (x) { return x.name; }), ['Delta', 'Alpha']);
assert.deepStrictEqual(T.pick(save, undefined), []);

// parseSeen survives anything
assert.deepStrictEqual(T.parseSeen('["a","b"]'), ['a', 'b']);
[null, '', 'not json', '{"a":1}', '[1,"x",null]'].forEach(function (x) { assert(Array.isArray(T.parseSeen(x))); });
assert.deepStrictEqual(T.parseSeen('[1,"x",null]'), ['x']);

// toast text
assert.strictEqual(T.toast([]), '');
assert.strictEqual(T.toast([r[0]]), 'NEW TROPHY: Alpha');
assert.strictEqual(T.toast([r[0], r[2]]), 'NEW TROPHIES: Alpha, Gamma');
assert.strictEqual(T.toast(r), '4 NEW TROPHIES');

// an old or broken file reads as empty and never throws
[undefined, null, 5, 'x', [], {}, { list: 'x', unlocked: 3, totals: [] }, { list: [null, 5, ['x']], unlocked: { x: 'no' } }].forEach(function (b) {
  assert.doesNotThrow(function () { T.rows(b); T.count(b); T.totals(b); T.fresh(b, []); T.pick(b, ['x']); });
  assert.deepStrictEqual(T.fresh(b, []), []);
});
assert.deepStrictEqual(T.totals(null), { heroes: 0, sessions: 0, usd: 0, streak: 0 });
assert.deepStrictEqual(T.count({ list: [['x', 'X', 'x']], unlocked: { x: 'no' } }), { got: 0, all: 1 });
console.log('ok (trophy)');
