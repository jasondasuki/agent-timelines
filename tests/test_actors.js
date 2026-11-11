// node tests/test_actors.js — placement, states, and that character sprites match the timeline viewer.
var assert = require('assert'), fs = require('fs'), path = require('path');
var D = require('../src/agent_timelines/dungeon.js'), A = require('../src/agent_timelines/actors.js');

// Same sprites as the viewer: compare with the HERO map in viewer.html (our own file, evaluated as a literal).
var html = fs.readFileSync(path.join(__dirname, '../src/agent_timelines/viewer.html'), 'utf8');
var VHERO = Function('return ' + /var HERO=(\{.*?\});/.exec(html)[1])();
assert.deepStrictEqual(A.HERO, VHERO, 'actors.js HERO must equal viewer.html HERO');

var tiers = ['executor', 'scanner', 'plan', 'writer', 'runner', 'mystery'];
var nodes = [{ id: 'main', parent: null, running: true }];
for (var i = 1; i < 16; i++) nodes.push({ id: 'n' + i, parent: nodes[(i * 7) % i].id, tier: tiers[i % tiers.length], running: i % 3 === 0, flags: [] });
nodes[5].flags = ['ignored-limit']; nodes[5].running = false;
nodes[8].kind = 'wf'; nodes[8].running = true; nodes[8].wf = { state: 'running' };
nodes[10].kind = 'wf'; nodes[10].running = false; nodes[10].wf = { state: 'failed' };

var d = D.generate('s1', nodes), acts = A.place('s1', d, nodes), by = {};
acts.forEach(function (a) { by[a.id] = a; });
assert.deepStrictEqual(A.place('s1', d, nodes), acts, 'deterministic');
assert.strictEqual(acts.length, nodes.length);
assert(A.FOES.indexOf(A.BOSS) < 0, 'the boss dragon is not one of the ordinary foes');
assert(A.DRAGON.length === 24 && A.DRAGON.every(function (r) { return r.length === 24 && /^[.orRlyYhewWt]+$/.test(r) && r.replace(/\./g, '').split('').every(function (c) { return A.DRAGON_PAL[c]; }); }), 'the dragon is 24x24 dots, every dot a palette colour');

var solid = {}, pathc = {}, room = {};
d.deco.forEach(function (e) { if (e.solid) solid[e.x + ',' + e.y] = 1; });
d.paths.forEach(function (p) { p.cells.forEach(function (c) { pathc[c[0] + ',' + c[1]] = 1; }); });
d.rooms.forEach(function (q) { room[q.id] = q; });
function ok(q, x, y) { return x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h && !solid[x + ',' + y] && !pathc[x + ',' + y]; }
acts.forEach(function (a) {
  assert(ok(room[a.id], a.x, a.y), a.id + ' stands on a free floor cell of its own room');
  if (a.kind === 'hero') assert(ok(room[a.id], a.fx, a.fy) && a.fx === a.x + 1 && a.fy === a.y, a.id + ' enemy stands beside it');
  if (a.kind === 'hero') assert(A.FOES.indexOf(a.foe) >= 0 && a.fk === 1 && a.rank === null && a.ex === a.fx && a.ey === a.fy, 'an unranked hero keeps a small normal enemy');
});

// states and sprites, by the viewer's rules
var idx = function (k) { return A.HERO[k][2] * 12 + A.HERO[k][1]; };
assert.strictEqual(by.main.kind, 'gm'); assert.strictEqual(by.main.state, 'cast'); assert.strictEqual(by.main.idx, idx('main'));
assert.strictEqual(A.place('s1', d, [{ id: 'main', running: false }].concat(nodes.slice(1)))[0].state, 'idle');
assert.strictEqual(by.n3.state, 'fight'); assert.strictEqual(by.n1.state, 'win');
assert.strictEqual(by.n1.idx, idx('scanner')); assert.strictEqual(by.n2.idx, idx('plan')); assert.strictEqual(by.n6.idx, idx('executor'));
assert.strictEqual(by.n11.idx, idx('other'), 'unknown tier falls back to other'); assert.strictEqual(by.n12.idx, idx('executor'));
assert.strictEqual(by.n5.idx, idx('ghost'), 'berserk (ignored-limit) is a ghost, as in the viewer');
assert.strictEqual(by.n4.idx, idx('runner'));
assert.strictEqual(by.n8.kind, 'wf'); assert.strictEqual(by.n8.idx, idx('wfrun'), 'running workflow is a mimic');
assert(by.n10.failed && by.n10.idx === idx('workflow'), 'failed workflow stays a closed chest');
assert(by.n5.failed && !by.n1.failed, 'only the berserk hero is flagged for the green light');

// wandering: the free area holds no prop, door, corridor or the fallen enemy; a long walk never leaves it
var blocked = {}, rug = {}, g = d.rooms[0].rug;
d.deco.forEach(function (e) { blocked[e.x + ',' + e.y] = 1; });
for (var gy = g.y; gy < g.y + g.h; gy++) for (var gx = g.x; gx < g.x + g.w; gx++) rug[gx + ',' + gy] = 1;
acts.forEach(function (a) {
  if (!a.free) return;
  Object.keys(a.free).forEach(function (k) { assert(!blocked[k] && !pathc[k], a.id + ' free cell ' + k + ' is clear'); });
  assert(a.free[a.x + ',' + a.y], a.id + ' starts on a free cell');
  if (a.kind === 'hero') assert(!a.free[a.fx + ',' + a.fy], a.id + ' never walks onto its fallen enemy');
});
assert(Object.keys(rug).some(function (k) { return by.main.free[k]; }), 'the guild master may cross the carpet');
acts.filter(function (a) { return a.free; }).forEach(function (a) {
  a.walk = { r: D.prng('w' + a.id) };
  var seen = {}, last;
  for (var t = 0; t < 120000; t += 37) {
    var o = A.walk(a, t);
    [[Math.floor(o.x), Math.floor(o.y)], [Math.ceil(o.x), Math.ceil(o.y)]].forEach(function (c) {
      assert(a.free[c[0] + ',' + c[1]], a.id + ' at t=' + t + ' stepped on blocked cell ' + c);
    });
    if (last) assert(Math.abs(o.x - last.x) + Math.abs(o.y - last.y) <= 1, 'moves at most a cell per frame, no teleports');
    last = o; seen[Math.round(o.x) + ',' + Math.round(o.y)] = 1;
  }
  assert(Object.keys(seen).length > 3, a.id + ' actually wanders');
});

// stamp: first sight never replays a transition; a change records its time
var mem = {};
A.stamp(acts, mem, 1000);
assert.strictEqual(by.n3.since, -Infinity);
nodes[3].running = false;
var acts2 = A.place('s1', d, nodes); A.stamp(acts2, mem, 5000);
assert.strictEqual(acts2.filter(function (a) { return a.id === 'n3'; })[0].since, 5000);
assert.strictEqual(acts2.filter(function (a) { return a.id === 'n1'; })[0].since, -Infinity);
console.log('ok');

// a hero spawned while watching walks in: from its parent's room, or with the key from the room it continues
var more = nodes.concat([{ id: 'n16', parent: 'n3', tier: 'executor', running: true, flags: [] }, { id: 'n17', parent: 'main', cont: 'n7', tier: 'executor', running: true, flags: [] }]);
var d3 = D.generate('s1', more), acts3 = A.place('s1', d3, more), by3 = {}, open3 = {};
acts3.forEach(function (a) { by3[a.id] = a; });
A.stamp(acts3, mem, 9000);
assert(by3.n16.trip && by3.n17.trip && !by3.n1.trip && !by3.main.trip, 'only the new heroes walk in');
assert.deepStrictEqual(by3.n16.from, [by3.n3.x, by3.n3.y]); assert(!by3.n16.key, 'a plain spawn starts at its parent');
assert.deepStrictEqual(by3.n17.from, [by3.n7.x, by3.n7.y]); assert(by3.n17.key, 'a continuation starts where the handoff was, with the key');
d3.deco.forEach(function (e) { if (e.solid) open3[e.x + ',' + e.y] = 1; });
[by3.n16, by3.n17].forEach(function (a) {
  var c = A.trip(d3, a), last = a.from;
  assert(c.length > 3, a.id + ' has a way in');
  assert.deepStrictEqual(c[c.length - 1], [a.x, a.y], a.id + ' ends at home');
  c.forEach(function (s) {
    assert.strictEqual(Math.abs(s[0] - last[0]) + Math.abs(s[1] - last[1]), 1, 'one cell per step');
    assert(D.T.WALK.indexOf(d3.tiles[s[1] - d3.oy][s[0] - d3.ox]) >= 0 && !open3[s[0] + ',' + s[1]], 'walks on open floor only');
    last = s;
  });
});
console.log('ok (walking in)');

// the guild master keeps one walk through idle <-> cast (no snapping home); a hero's new state gets a fresh walk
var m2 = {}, g1 = A.place('s1', d, [{ id: 'main', running: false }])[0];
A.stamp([g1], m2, 0); var w1 = g1.walk;
var g2 = A.place('s1', d, [{ id: 'main', running: true }])[0];
A.stamp([g2], m2, 3000);
assert.strictEqual(g2.state, 'cast'); assert.strictEqual(g2.walk, w1, 'guild master walk survives idle -> cast');
assert(g2.free && Object.keys(g2.free).length > 20, 'guild master roams the hall while casting too');
console.log('ok (guild master)');

// a job that ends during the walk in keeps its walk and its birth time (a replay runs faster than a hero walks)
more[16].running = false;
var n16 = A.place('s1', d3, more).filter(function (a) { return a.id === 'n16'; });
A.stamp(n16, mem, 9100);
assert.strictEqual(n16[0].state, 'win'); assert.strictEqual(n16[0].trip, by3.n16.trip, 'the walk in survives the state change');
assert.strictEqual(n16[0].born, 9000); assert.strictEqual(by3.n1.born, -Infinity, 'a room seen on the first look was always there');
console.log('ok (short job)');

// rank: drawing only. An elite's enemy is 2x, the boss's a 3x dragon; the room, the hero and every other field stay as they were
var ranked = nodes.map(function (n, i) { return i === 3 ? Object.assign({}, n, { rank: 'boss' }) : i === 6 || i === 9 ? Object.assign({}, n, { rank: 'elite' }) : n; });
var dr = D.generate('s1', ranked), accts = A.place('s1', dr, ranked), byr = {}, base = {};
A.place('s1', d, nodes).forEach(function (a) { base[a.id] = a; });
assert.deepStrictEqual(dr, D.generate('s1', nodes), 'rank never changes the dungeon layout');
accts.forEach(function (a) { byr[a.id] = a; });
assert(byr.n3.rank === 'boss' && byr.n3.fk === 3 && byr.n3.foe === A.BOSS, 'boss: a 3x dragon');
assert(byr.n6.rank === 'elite' && byr.n6.fk === 2 && byr.n6.foe === base.n6.foe, 'elite: the same foe at 2x');
assert(byr.n1.rank === null && byr.n1.fk === 1 && byr.main.rank === undefined);
accts.forEach(function (a) {
  var u = base[a.id];
  ['id', 'kind', 'idx', 'x', 'y', 'state', 'fx', 'fy', 'failed', 'from', 'key'].forEach(function (k) { assert.deepStrictEqual(a[k], u[k], a.id + ' ' + k + ' does not depend on rank'); });
  if (a.kind !== 'hero') return;
  var q = room[a.id];
  assert(a.ex >= q.x && a.ey >= q.y && a.ex + a.fk <= q.x + q.w && a.ey + a.fk <= q.y + q.h, a.id + ' enemy box stays inside its room');
  assert(!(a.x >= a.ex && a.x < a.ex + a.fk && a.y >= a.ey && a.y < a.ey + a.fk), a.id + ' the hero is not inside the enemy box');
  for (var i = 0; i < a.fk; i++) for (var j = 0; j < a.fk; j++) assert(!a.free[(a.ex + i) + ',' + (a.ey + j)], a.id + ' nobody walks onto the enemy');
});
// every room size and seed: the biggest enemy still fits and never overlaps its hero
for (var sd = 0; sd < 40; sd++) {
  var big = [{ id: 'main', running: false }], bi;
  for (bi = 1; bi < 14; bi++) big.push({ id: 'b' + bi, parent: 'main', tier: 'executor', running: bi % 2 === 0, flags: [], rank: bi % 3 ? 'boss' : 'elite' });
  var db = D.generate('seed' + sd, big);
  A.place('seed' + sd, db, big).forEach(function (a) {
    if (a.kind !== 'hero') return;
    var q = db.rooms.filter(function (r) { return r.id === a.id; })[0];
    assert(a.ex >= q.x && a.ey >= q.y && a.ex + a.fk <= q.x + q.w && a.ey + a.fk <= q.y + q.h && !(a.x >= a.ex && a.x < a.ex + a.fk && a.y >= a.ey && a.y < a.ey + a.fk), 'seed ' + sd + ' ' + a.id + ' (' + q.w + 'x' + q.h + ')');
  });
}
console.log('ok (rank)');
