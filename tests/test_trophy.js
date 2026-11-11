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

// level: read from the file, pct clamped; a file without one (or a broken one) has no level and no toast
var lv = { n: 3, title: 'Chartered Company', xp: 450, lo: 300, hi: 600 };
assert.deepStrictEqual(T.level({ level: lv }), { n: 3, title: 'Chartered Company', xp: 450, hi: 600, pct: 50 });
assert.strictEqual(T.level({ level: { n: 3, title: 'X', xp: 900, lo: 300, hi: 600 } }).pct, 100);
[save, null, { level: 5 }, { level: { n: 0, title: 'X', xp: 0, lo: 0, hi: 100 } }, { level: { n: 2, title: 'X', xp: 1, lo: 5, hi: 5 } }, { level: { n: 2, xp: 1, lo: 0, hi: 5 } }]
  .forEach(function (b) { assert.strictEqual(T.level(b), null); assert.strictEqual(T.levelUp(b, 0), ''); });
assert.strictEqual(T.levelUp({ level: lv }, null), 'GUILD LEVEL 3: CHARTERED COMPANY');
assert.strictEqual(T.levelUp({ level: lv }, '2'), 'GUILD LEVEL 3: CHARTERED COMPANY');
assert.strictEqual(T.levelUp({ level: lv }, '3'), '');
assert.strictEqual(T.levelUp({ level: { n: 1, title: 'Tavern Regulars', xp: 0, lo: 0, hi: 100 } }, null), '', 'level 1 is never news');

// quests: the day picks a window of three on qlist (the same one timeline.py picks, see test_timeline.py), done comes from that day's entry
var ql = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(function (i) { return [i, i.toUpperCase(), 'do ' + i]; });
var qd = new Date(2026, 2, 1, 12), qs = T.quests({ qlist: ql, quests: { '2026-03-01': ['e', 'zzz'], '2026-03-02': ['d'] } }, qd);
assert.deepStrictEqual(qs.map(function (q) { return q.id + (q.done ? '+' : '-'); }), ['e+', 'f-', 'g-']);
assert.deepStrictEqual([qs[0].name, qs[0].desc, qs[0].key], ['E', 'do e', '2026-03-01:e']);
assert.deepStrictEqual(T.quests({ qlist: ql }, new Date(2026, 2, 2, 0, 0, 1)).map(function (q) { return q.id; }), ['h', 'a', 'b'], 'the next day, wrapping');
assert.deepStrictEqual(T.quests({ qlist: ql }, new Date(1970, 0, 1)).map(function (q) { return q.id; }), ['b', 'c', 'd'], '719163 * 3 % 8 = 1');
[{}, null, { qlist: ql.slice(0, 2) }, { qlist: ql.concat([null]) }, { qlist: 'x', quests: 3 }].forEach(function (b) { assert.deepStrictEqual(T.quests(b, qd), []); });
assert.strictEqual(T.questToast(qs, []), 'QUEST DONE: E');
assert.strictEqual(T.questToast(qs, ['2026-03-01:e']), '');
assert.strictEqual(T.questToast(qs, ['2026-02-28:e']), 'QUEST DONE: E', 'the same quest on another day is news again');
assert.strictEqual(T.questToast(qs.map(function (q) { return { name: q.name, key: q.key, done: true }; }), null), 'QUESTS DONE: E, F, G');
assert.strictEqual(T.questToast([], []), '');

// an old or broken file reads as empty and never throws
[undefined, null, 5, 'x', [], {}, { list: 'x', unlocked: 3, totals: [] }, { list: [null, 5, ['x']], unlocked: { x: 'no' } }].forEach(function (b) {
  assert.doesNotThrow(function () { T.rows(b); T.count(b); T.totals(b); T.fresh(b, []); T.pick(b, ['x']); });
  assert.deepStrictEqual(T.fresh(b, []), []);
});
assert.deepStrictEqual(T.totals(null), { heroes: 0, sessions: 0, usd: 0, streak: 0 });
assert.deepStrictEqual(T.count({ list: [['x', 'X', 'x']], unlocked: { x: 'no' } }), { got: 0, all: 1 });
console.log('ok (trophy)');
