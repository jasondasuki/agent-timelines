'use strict';
var assert = require('assert');
var D = require('../src/agent_timelines/dungeon.js');
var WALK = D.T.WALK, SIZE = { td: 12 * 11, ob: 48 * 22 }; // sheet cell counts

function tree(n, parentOf) {
  var a = [];
  var tiers = ['executor', 'scanner', 'plan', 'writer', 'runner', 'mystery']; // one room theme each; every 7th node is a workflow
  for (var i = 0; i < n; i++) a.push({ id: i ? 'n' + i : 'main', parent: i ? 'n' + parentOf(i) : null, tier: tiers[i % 6], kind: i % 7 === 6 ? 'wf' : undefined });
  a[0].parent = null;
  for (i = 1; i < n; i++) if (a[i].parent === 'n0') a[i].parent = 'main';
  return a;
}
var trees = {
  deep: tree(25, function (i) { return i < 7 ? i - 1 : i % 7; }), // chain of depth 6 plus branches
  wide: tree(41, function () { return 0; }),                      // 40 children of root
  mixed: tree(30, function (i) { return ((i * 2654435761) >>> 0) % i; }) // arbitrary valid tree
};

function check(d, nodes) {
  var byId = {}, i, j;
  d.rooms.forEach(function (r) { byId[r.id] = r; });
  assert.strictEqual(d.rooms.length, nodes.length);
  for (i = 0; i < d.rooms.length; i++) for (j = i + 1; j < d.rooms.length; j++) {
    var a = d.rooms[i], b = d.rooms[j]; // 3 free cells (wall, lane, wall) between rooms
    assert(a.x + a.w + 3 <= b.x || b.x + b.w + 3 <= a.x || a.y + a.h + 3 <= b.y || b.y + b.h + 3 <= a.y, 'overlap ' + a.id + ' ' + b.id);
  }
  function walk(x, y) { var r = d.tiles[y - d.oy] && d.tiles[y - d.oy][x - d.ox]; return WALK.indexOf(r) >= 0; }
  function touches(r, c) { // cell is orthogonally adjacent to r's interior, not inside it
    var dx = c[0] < r.x ? r.x - c[0] : c[0] - (r.x + r.w - 1), dy = c[1] < r.y ? r.y - c[1] : c[1] - (r.y + r.h - 1);
    return Math.max(dx, 0) + Math.max(dy, 0) === 1;
  }
  assert.strictEqual(d.paths.length, nodes.length - 1);
  d.paths.forEach(function (p, n) {
    assert.strictEqual(p.to, nodes[n + 1].id);
    var c = p.cells;
    assert(touches(byId[p.from], c[0]) && touches(byId[p.to], c[c.length - 1]), 'ends ' + p.to);
    for (var i = 0; i < c.length; i++) {
      assert(walk(c[i][0], c[i][1]), 'not walkable');
      if (i) assert.strictEqual(Math.abs(c[i][0] - c[i - 1][0]) + Math.abs(c[i][1] - c[i - 1][1]), 1, 'gap');
    }
    assert.strictEqual(d.tiles[c[0][1] - d.oy][c[0][0] - d.ox], D.T.DOOR);
  });
  // flood fill from the root over walkable tiles
  var seen = {}, q = [[d.rooms[0].cx, d.rooms[0].cy]], c;
  seen[q[0]] = 1;
  while ((c = q.pop())) [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (s) {
    var n = [c[0] + s[0], c[1] + s[1]];
    if (!seen[n] && walk(n[0], n[1])) { seen[n] = 1; q.push(n); }
  });
  d.rooms.forEach(function (r) { assert(seen[[r.cx, r.cy]], 'unreachable ' + r.id); });

  // deco: in bounds, never on path cells, solid props only on room floor; paths still connect around props
  var onPath = {}, solid = {}, room = {};
  d.paths.forEach(function (p) { p.cells.forEach(function (c) { onPath[c] = 1; }); });
  d.rooms.forEach(function (r) { for (var y = r.y; y < r.y + r.h; y++) for (var x = r.x; x < r.x + r.w; x++) room[[x, y]] = 1; });
  d.tiles.forEach(function (row) { row.forEach(function (t) { assert(t >= -1 && t < SIZE.td, 'tile ' + t); }); });
  d.deco.forEach(function (e) {
    assert(e.idx >= 0 && e.idx < SIZE[e.sheet], 'deco idx ' + e.sheet + e.idx);
    assert(!onPath[[e.x, e.y]], 'deco on path ' + [e.x, e.y]);
    if (e.solid) { assert(room[[e.x, e.y]], 'solid off floor'); solid[[e.x, e.y]] = 1; }
  });
  if (!d.paths.length) return;
  seen = {}; q = [d.paths[0].cells[0]]; seen[q[0]] = 1;
  while ((c = q.pop())) [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (s) {
    var n = [c[0] + s[0], c[1] + s[1]];
    if (!seen[n] && !solid[n] && walk(n[0], n[1])) { seen[n] = 1; q.push(n); }
  });
  d.paths.forEach(function (p) { p.cells.forEach(function (c) { assert(seen[c], 'props block path to ' + p.to); }); });
}

Object.keys(trees).forEach(function (name) {
  var nodes = trees[name], d = D.generate('sess-1', nodes);
  check(d, nodes);
  assert.deepStrictEqual(d, D.generate('sess-1', nodes), name + ' determinism');
  assert.notDeepStrictEqual(d.rooms, D.generate('sess-2', nodes).rooms, name + ' seed');
  [1, 5, 12].forEach(function (k) { // stability: appending never moves existing rooms/paths
    var a = D.generate('sess-1', nodes.slice(0, k)), b = D.generate('sess-1', nodes.slice(0, k + 5));
    assert.deepStrictEqual(b.rooms.slice(0, k), a.rooms);
    assert.deepStrictEqual(b.paths.slice(0, k - 1), a.paths);
    assert.deepStrictEqual(b.deco.slice(0, a.deco.length), a.deco, 'deco moved');
    a.rooms.forEach(function (r) { // room floors keep their tiles
      for (var y = r.y; y < r.y + r.h; y++) for (var x = r.x; x < r.x + r.w; x++)
        assert.strictEqual(b.tiles[y - b.oy][x - b.ox], a.tiles[y - a.oy][x - a.ox], 'floor changed');
    });
  });
  var hall = d.rooms[0], has = {};
  d.rooms.slice(1).forEach(function (r) { assert(r.w < hall.w && r.h < hall.h, 'hall not largest'); });
  d.deco.forEach(function (e) { if (e.x >= hall.x - 1 && e.x <= hall.x + hall.w && e.y >= hall.y - 1 && e.y < hall.y + hall.h) has[e.idx] = 1; });
  ['BANNER', 'HEARTH_L', 'TABLE', 'CABINET'].forEach(function (n) { assert(has[D.T[n]], 'hall lacks ' + n); });
  assert(hall.rug && hall.rug.x > hall.x && hall.rug.x + hall.rug.w < hall.x + hall.w, 'hall lacks its carpet');
  // themes: the hall, then one per kind of agent; fixtures hang on a brick wall face of their own room, never on a door
  var themes = {};
  d.rooms.forEach(function (r, i) { assert(D.THEMES[r.theme], 'theme ' + r.theme); assert.strictEqual(r.theme === 'hall', !i); themes[r.theme] = 1; });
  assert.strictEqual(Object.keys(themes).length, Object.keys(D.THEMES).length, name + ' uses every theme');
  var lit = {};
  d.fx.forEach(function (e) {
    var r = d.rooms[e.room], t = d.tiles[e.y - d.oy][e.x - d.ox];
    assert(e.x >= r.x && e.x < r.x + r.w && e.y >= r.y - 1 && e.y < r.y + r.h, 'fx outside its room');
    if (e.k === 'torch' || e.k === 'spr' || e.k === 'hearth') assert(t === D.T.WALL || t === D.T.WALL_GRATE, e.k + ' not on a wall face');
    if (e.k !== 'spr') lit[e.room] = 1;
  });
  d.rooms.forEach(function (r, i) { assert(lit[i], 'room ' + r.id + ' has no light'); });
});
console.log('ok');
