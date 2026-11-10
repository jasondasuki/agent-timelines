'use strict';
var assert = require('assert');
var L = require('../src/agent_timelines/lobby.js');

var rows = [
  { id: 'aaaa1111', cwd: '/home/work/api', planner: 'opus-5/high', last: 'planner -> spawned #1 Fix Login', updated: 50 },
  { id: 'bbbb2222', cwd: '/home/personal/api', planner: 'fable-5-2/high', last: 'done', updated: 40 },
  { id: 'cccc3333', cwd: '/home/dev/web', planner: 'opus-5/high', last: 'handed off', updated: 60 },
  { id: 'dddd4444', cwd: '/home/work/api', planner: 'sonnet-5/high', last: '', updated: 10 }
];
var ids = function (rs) { return rs.map(function (r) { return r.id; }); };

// filter: one word, two words, case, project, nothing
assert.deepStrictEqual(ids(L.filter(rows, 'web')), ['cccc3333']);
assert.deepStrictEqual(ids(L.filter(rows, 'OPUS login')), ['aaaa1111'], 'every word must match, any case');
assert.deepStrictEqual(ids(L.filter(rows, '  opus   ')), ['aaaa1111', 'cccc3333'], 'extra spaces are ignored');
assert.deepStrictEqual(ids(L.filter(rows, 'bbbb')), ['bbbb2222'], 'matches the session id');
assert.deepStrictEqual(ids(L.filter(rows, '', '/home/work/api')), ['aaaa1111', 'dddd4444']);
assert.deepStrictEqual(ids(L.filter(rows, 'opus', '/home/work/api')), ['aaaa1111']);
assert.strictEqual(L.filter(rows, 'zzz').length, 0);
assert.strictEqual(L.filter(rows, '', '').length, 4, 'no filter keeps every row');
assert.strictEqual(L.filter(null, 'x').length, 0);

// rows missing fields do not throw
var odd = [{ id: 'x' }, { cwd: '/a/b' }, { id: 'y', cwd: null, last: null, planner: undefined }];
assert.doesNotThrow(function () { L.filter(odd, 'x'); L.filter(odd, '', '/a/b'); L.projects(odd); });
assert.deepStrictEqual(ids(L.filter(odd, 'x')), ['x']);
assert.deepStrictEqual(L.projects(odd), [{ cwd: '/a/b', name: 'b', n: 1 }], 'a row without cwd has no project');

// projects: newest first, counts, same last part gets its parent folder
var ps = L.projects(rows);
assert.deepStrictEqual(ps.map(function (p) { return p.name; }), ['web', 'api (work)', 'api (personal)']);
assert.deepStrictEqual(ps.map(function (p) { return p.n; }), [1, 2, 1]);
assert.strictEqual(ps[1].cwd, '/home/work/api');
assert.deepStrictEqual(L.projects([{ cwd: '/', updated: 1 }]), [{ cwd: '/', name: '/', n: 1 }]);
assert.deepStrictEqual(L.projects([{ cwd: '/x/api', updated: 1 }, { cwd: '/api', updated: 2 }]).map(function (p) { return p.name; }), ['api (/api)', 'api (x)'], 'no parent folder: the whole path');

// page: clamping
var list = []; for (var i = 0; i < 20; i++) list.push(i);
var p = L.page(list, 0, 15);
assert.strictEqual(p.items.length, 15); assert.strictEqual(p.pages, 2); assert.strictEqual(p.page, 0);
p = L.page(list, 9, 15);
assert.strictEqual(p.page, 1, 'page 9 of 2 is the last page'); assert.deepStrictEqual(p.items, [15, 16, 17, 18, 19]);
p = L.page(list, -3, 15);
assert.strictEqual(p.page, 0);
p = L.page([], 4, 15);
assert.deepStrictEqual(p, { items: [], page: 0, pages: 1 }, 'an empty list is one empty page');
assert.strictEqual(L.page(list, 'x', 15).page, 0);
assert.strictEqual(L.page(list, 0, 20).pages, 1, 'an exact multiple has no extra page');
assert.strictEqual(L.page(null, 0, 5).pages, 1);
console.log('ok');
