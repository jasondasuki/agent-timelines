'use strict';
var assert = require('assert');
var G = require('../src/agent_timelines/gantt.js');
var EPS = 1e-9;

var nodes = [
  { id: 'main', parent: null, start: 0, end: 100, running: false },
  { id: 'B', parent: 'main', start: 30, end: 60 },
  { id: 'A', parent: 'main', start: 10, end: 40 },
  { id: 'A1', parent: 'A', start: 15, end: 25 },
  { id: 'A1a', parent: 'A1', start: 16, end: 20 },
  { id: 'R', parent: 'main', start: 50, end: 100, running: true }
];
var g = G.layout(nodes);
assert.deepStrictEqual(g.rows.map(function (r) { return r.id + ':' + r.depth; }), ['main:0', 'A:1', 'A1:2', 'A1a:3', 'B:1', 'R:1'], 'depth first, children by start');
assert.strictEqual(g.t0, 0); assert.strictEqual(g.t1, 100);
g.rows.forEach(function (r) {
  assert.ok(r.x >= -EPS && r.w >= -EPS && r.x + r.w <= 1 + EPS, JSON.stringify(r));
});
var R = g.rows.filter(function (r) { return r.id === 'R'; })[0];
assert.ok(Math.abs(R.x - 0.5) < EPS && Math.abs(R.x + R.w - 1) < EPS, 'a running node ends at the right edge');
assert.ok(Math.abs(g.rows[0].x) < EPS && Math.abs(g.rows[0].w - 1) < EPS, 'main spans the range');

// a running node without an end reaches the end of the range; a finished node without one is a point
var open = G.layout([{ id: 'main', start: 0, end: 10 }, { id: 'r', parent: 'main', start: 4, end: null, running: true }, { id: 'd', parent: 'main', start: 5, end: null, running: false }]);
assert.ok(Math.abs(open.rows[1].x + open.rows[1].w - 1) < EPS && open.rows[2].w === 0);

// t0 / t1 only widen the range ("now" for a live session)
var wide = G.layout(nodes, null, 200);
assert.strictEqual(wide.t1, 200); assert.ok(Math.abs(wide.rows[0].w - 0.5) < EPS);
assert.strictEqual(G.layout(nodes, 20, 50).t1, 100, 'a smaller t1 does not cut bars');

// a node with no start
var ns = G.layout([{ id: 'main', start: 0, end: 10 }, { id: 'x', parent: 'main', start: null, end: null }, { id: 'y', parent: 'main', start: 2, end: 3 }]);
var X = ns.rows.filter(function (r) { return r.id === 'x'; })[0];
assert.strictEqual(X.x, 1); assert.strictEqual(X.w, 0); assert.strictEqual(ns.rows[ns.rows.length - 1].id, 'x', 'no start sorts last');

// a parent cycle terminates and every node shows once
var cyc = G.layout([{ id: 'main', start: 0, end: 10 }, { id: 'a', parent: 'b', start: 1, end: 2 }, { id: 'b', parent: 'a', start: 3, end: 4 }, { id: 's', parent: 's', start: 5, end: 6 }]);
assert.deepStrictEqual(cyc.rows.map(function (r) { return r.id; }).sort(), ['a', 'b', 'main', 's']);
assert.strictEqual(cyc.rows.length, 4);

// unknown parent -> depth 1
var un = G.layout([{ id: 'main', start: 0, end: 10 }, { id: 'o', parent: 'gone', start: 1, end: 2 }]);
assert.strictEqual(un.rows[1].depth, 1);

// t0 == t1 and degenerate input give finite numbers
[G.layout([{ id: 'main', start: 5, end: 5 }]), G.layout([{ id: 'main', start: null, end: null }]), G.layout([]), G.layout(null)].forEach(function (l) {
  assert.ok(isFinite(l.t0) && isFinite(l.t1) && l.t1 > l.t0);
  l.rows.forEach(function (r) { assert.ok(isFinite(r.x) && isFinite(r.w)); });
  l.ticks.forEach(function (t) { assert.ok(isFinite(t.x)); });
});
assert.deepStrictEqual(G.layout([]).rows, []);

// ticks: increasing, inside 0..1, at most 8, whatever the span
[1, 9, 45, 300, 3600, 5 * 3600, 86400, 3 * 86400, 30 * 86400].forEach(function (span) {
  var l = G.layout([{ id: 'main', start: 1.8e9 + 17, end: 1.8e9 + 17 + span }]);
  assert.ok(l.ticks.length <= 8, span + ' -> ' + l.ticks.length);
  l.ticks.forEach(function (t, i) {
    assert.ok(t.x >= 0 && t.x <= 1 && /^\d\d(:\d\d){1,2}$|^\d\d-\d\d$/.test(t.label), JSON.stringify(t));
    if (i) assert.ok(t.x > l.ticks[i - 1].x);
  });
  if (span >= 300) assert.ok(l.ticks.length >= 1, 'a span of ' + span + 's has a tick');
});
console.log('ok');
