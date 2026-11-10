/* Characters for the dungeon: the guild master in the hall, one hero + enemy per agent room, a chest per workflow.
 * Sprites follow the timeline viewer exactly (same HERO map and rules; tests/test_actors.js compares them).
 * place() is pure (seed + dungeon + nodes -> actors); stamp() remembers when each state began; draw() runs per frame.
 * Actors not working (idle guild master, a hero after its victory) wander their room's free cells: never onto props,
 * doors, corridors or the fallen enemy. walk() holds that motion and is canvas-free so it can be tested.
 * A hero that appears while you watch first walks the corridors to its room: from the room of whoever sent it, or,
 * when it continues a handoff, from the room that handed off, carrying the key (trip() finds the way).
 * Node fields are the viewer's: {id, parent, cont, tier, kind, running, flags, wf:{state}}. Plain ES5; window.Actors / module.exports. */
(function (root) {
  'use strict';
  var D = root.Dungeon || (typeof require !== 'undefined' && require('./dungeon.js'));
  // [sheet, col, row]: keep identical to HERO in viewer.html
  var HERO = {main:["td",0,7],executor:["td",0,8],scanner:["td",1,7],plan:["td",4,8],writer:["td",3,8],runner:["td",4,7],other:["td",3,7],workflow:["td",5,7],wfrun:["td",8,7],ghost:["td",1,10]};
  var FOES = [108, 109, 110, 111, 120, 122, 123, 124]; // td slime, cyclops, crab, hooded cultist, bat, spider, rat, grey rat
  var OPEN_CHEST = 91;  // td open chest: a finished workflow
  var OB_BONES = 721;   // ob bone pile under a fallen enemy
  var STEP_MS = 220;    // one cell of running
  var TRIP_MS = 110;    // one cell of the walk to a new hero's room: brisk, corridors are long
  var OB_KEY = 560;     // ob gold key carried by a hero that continues a handoff
  var OB_TROPHY = 808;  // ob trophy raised on victory (tinted gold when drawn)

  function cls(n) { return n.id === 'main' ? 'main' : n.kind === 'wf' ? 'workflow' : HERO[n.tier] ? n.tier : 'other'; }
  function sprite(n) { // the viewer's sprite(): a berserk hero (ignored the tool limit) is a ghost, a running workflow a mimic
    var berserk = n.id !== 'main' && n.kind !== 'wf' && !n.running && (n.flags || []).indexOf('ignored-limit') >= 0;
    var s = berserk ? HERO.ghost : n.kind === 'wf' && n.running ? HERO.wfrun : HERO[cls(n)];
    return s[2] * 12 + s[1];
  }

  function place(seed, d, nodes) {
    var solid = {}, path = {}, rooms = {}, out = [], home = {};
    d.deco.forEach(function (e) { solid[e.x + ',' + e.y] = 1; });
    d.paths.forEach(function (p) { p.cells.forEach(function (c) { path[c[0] + ',' + c[1]] = 1; }); });
    d.rooms.forEach(function (q) { rooms[q.id] = q; });
    function free(q, x, y) { return x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h && !solid[x + ',' + y] && !path[x + ',' + y]; }
    function near(q, x, y, two) { // closest free cell to (x, y) in rings outward; `two` also needs its right neighbour free
      for (var r = 0; r < q.w + q.h; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && free(q, x + dx, y + dy) && (!two || free(q, x + dx + 1, y + dy))) return [x + dx, y + dy];
      }
      return [q.cx, q.cy];
    }
    function room(q, skip) { // free cells of q, minus `skip`, as {"x,y": 1}
      var f = {}, x, y;
      for (y = q.y; y < q.y + q.h; y++) for (x = q.x; x < q.x + q.w; x++) if (free(q, x, y) && x + ',' + y !== skip) f[x + ',' + y] = 1;
      return f;
    }
    nodes.forEach(function (n) {
      var q = rooms[n.id], a;
      if (!q) return;
      if (q.hall) { a = near(q, q.x + 2, q.y); home[n.id] = a; out.push({ id: n.id, kind: 'gm', idx: sprite(n), x: a[0], y: a[1], state: n.running ? 'cast' : 'idle', free: room(q) }); return; }
      if (n.kind === 'wf') {
        a = near(q, q.cx, q.cy); home[n.id] = a;
        out.push({ id: n.id, kind: 'wf', idx: n.running ? sprite(n) : n.wf && n.wf.state === 'failed' ? sprite(n) : OPEN_CHEST, x: a[0], y: a[1],
          state: n.running ? 'fight' : 'win', failed: !n.running && !!n.wf && n.wf.state === 'failed' });
        return;
      }
      a = near(q, q.cx - 1, q.cy, true); home[n.id] = a;
      var src = home[n.cont] || home[n.parent] || home.main; // where its walk in starts
      out.push({ id: n.id, kind: 'hero', idx: sprite(n), x: a[0], y: a[1], state: n.running ? 'fight' : 'win',
        foe: FOES[D.prng(seed + '/foe/' + n.id)() * FOES.length | 0], fx: a[0] + 1, fy: a[1], free: room(q, (a[0] + 1) + ',' + a[1]),
        failed: sprite(n) === HERO.ghost[2] * 12 + HERO.ghost[1], from: src || a, key: !!home[n.cont] }); // berserk: Dungeon.glow() lights its room green
    });
    return out;
  }

  // mem: {id: {state, since}} kept by the caller. An actor first seen gets since = -Infinity, so a page opened on a
  // finished session shows the resting pose instead of replaying every victory.
  function stamp(actors, mem, now) {
    var watching = Object.keys(mem).length > 0; // not the first look: an actor that is new now has just been spawned
    actors.forEach(function (a) {
      var m = mem[a.id];
      // A hero's new state starts a fresh walk from its home cell; the guild master keeps walking through idle <-> cast.
      if (!m || m.state !== a.state) mem[a.id] = { state: a.state, since: m ? now : -Infinity,
        walk: m && a.kind === 'gm' ? m.walk : { r: D.prng('walk/' + a.id + '/' + now) },
        trip: !m && watching && a.kind === 'hero' ? { t0: now } : null };
      a.since = mem[a.id].since; a.walk = mem[a.id].walk; a.trip = mem[a.id].trip;
    });
  }

  function route(free, from, to) { // BFS over free cells; the cells after `from`, ending at `to` ([] if unreachable)
    var prev = {}, q = [from], k = from + '', i, c;
    prev[k] = null;
    while (q.length) {
      c = q.shift();
      if (c[0] === to[0] && c[1] === to[1]) { var out = []; for (; prev[c + ''] !== null; c = prev[c + '']) out.unshift(c); return out; }
      for (i = 0; i < 4; i++) {
        var n = [c[0] + [1, -1, 0, 0][i], c[1] + [0, 0, 1, -1][i]];
        if (free[n[0] + ',' + n[1]] && !(n + '' in prev)) { prev[n + ''] = c; q.push(n); }
      }
    }
    return [];
  }

  // The cells a new hero walks from a.from to its home: over any floor, corridor or door, round solid props.
  function trip(d, a) {
    var free = {}, solid = {};
    d.deco.forEach(function (e) { if (e.solid) solid[e.x + ',' + e.y] = 1; });
    d.tiles.forEach(function (row, y) { row.forEach(function (t, x) {
      var k = (x + d.ox) + ',' + (y + d.oy);
      if (D.T.WALK.indexOf(t) >= 0 && !solid[k]) free[k] = 1;
    }); });
    return route(free, a.from, [a.x, a.y]);
  }

  // Position of a resting actor at `now`, in fractional cells: run to a random free cell, pause 1-3 s, repeat.
  // The loop replays whole steps, so a late frame (hidden tab) catches up instead of skipping cells.
  function walk(a, now) {
    var w = a.walk, cells = Object.keys(a.free);
    if (!w.at) { w.at = [a.x, a.y]; w.path = []; w.until = now + 400 + w.r() * 1500; w.face = 1; }
    for (;;) {
      if (!w.path.length) {
        if (now < w.until || !cells.length) return { x: w.at[0], y: w.at[1], moving: false, face: w.face };
        var t = cells[w.r() * cells.length | 0].split(',');
        w.path = route(a.free, w.at, [+t[0], +t[1]]); w.t0 = w.until;
        if (!w.path.length) { w.until += 1000; continue; }
      }
      var n = w.path[0], f = (now - w.t0) / STEP_MS;
      if (n[0] !== w.at[0]) w.face = n[0] > w.at[0] ? 1 : -1;
      if (f < 1) return { x: w.at[0] + (n[0] - w.at[0]) * f, y: w.at[1] + (n[1] - w.at[1]) * f, moving: true, face: w.face };
      w.at = w.path.shift(); w.t0 += STEP_MS;
      if (!w.path.length) w.until = w.t0 + 1000 + w.r() * 2000;
    }
  }

  var tints = {};
  function tinted(img, cols, idx, color, mix) { // cached recolour of one sprite: mix 1 = solid silhouette (hit flash), <1 keeps shading
    var k = cols + '/' + idx + color + mix;
    if (tints[k]) return tints[k];
    var c = document.createElement('canvas'), x = c.getContext('2d');
    c.width = c.height = 16;
    x.drawImage(img, idx % cols * 16, (idx / cols | 0) * 16, 16, 16, 0, 0, 16, 16);
    x.globalCompositeOperation = 'source-atop'; x.globalAlpha = mix; x.fillStyle = color; x.fillRect(0, 0, 16, 16);
    return (tints[k] = c);
  }

  // Every offset is a whole number of sprite pixels and every animation steps (no tweening), so it stays pixel art.
  // still = true (reduced motion) draws each state's resting pose.
  function draw(ctx, d, actors, sheets, scale, now, still) {
    var S = 16 * scale, p = scale, td = sheets.td, i;
    ctx.imageSmoothingEnabled = false;
    function spr(idx, x, y, o) {
      o = o || {};
      ctx.save(); ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
      ctx.translate(x + S / 2, y + S / 2); if (o.flip) ctx.scale(-1, 1); if (o.rot) ctx.rotate(o.rot);
      if (o.flash) ctx.drawImage(tinted(td, 12, idx, '#fff', 1), -S / 2, -S / 2, S, S);
      else ctx.drawImage(td, idx % 12 * 16, (idx / 12 | 0) * 16, 16, 16, -S / 2, -S / 2, S, S);
      ctx.restore();
    }
    function ob(idx, x, y, alpha, gold) {
      ctx.save(); ctx.globalAlpha = alpha;
      if (gold) ctx.drawImage(tinted(sheets.ob, 48, idx, '#ffc21a', 0.75), x, y, S, S);
      else ctx.drawImage(sheets.ob, idx % 48 * 16, (idx / 48 | 0) * 16, 16, 16, x, y, S, S);
      ctx.restore();
    }
    function dot(color, x, y, n) { ctx.fillStyle = color; ctx.fillRect(Math.round(x / p) * p, Math.round(y / p) * p, (n || 1) * p, (n || 1) * p); }
    function step(period, n, off) { return still ? 0 : Math.floor((now + off) % period / period * n); }

    actors.forEach(function (a) {
      var X = (a.x - d.ox) * S, Y = (a.y - d.oy) * S, off = D.prng('t/' + a.id)() * 5000 | 0, k;
      if (a.kind === 'gm') return rest(a, a.idx); // always roams the hall; casts at each stop while work is going on
      if (a.kind === 'wf') return spr(a.idx, X + (a.state === 'fight' ? (step(300, 2, off) ? p : -p) : 0), Y, { alpha: a.failed ? 0.5 : 1 });

      var FX = (a.fx - d.ox) * S, el = now - a.since, tr = a.trip;
      if (tr && a.state === 'fight' && !still) { // just spawned: still walking in while its enemy waits
        if (!tr.cells) tr.cells = trip(d, a);
        var f = (now - tr.t0) / TRIP_MS, n = Math.floor(f), c1 = tr.cells[n], c0 = n ? tr.cells[n - 1] : a.from;
        if (c1) {
          var TX = Math.round((c0[0] + (c1[0] - c0[0]) * (f - n) - d.ox) * 16) * p, TY = Math.round((c0[1] + (c1[1] - c0[1]) * (f - n) - d.oy) * 16) * p;
          spr(a.idx, TX, TY - step(220, 2, off) * p, { flip: c1[0] < c0[0] });
          if (a.key) ob(OB_KEY, TX, TY - S + 2 * p, 1);
          return spr(a.foe, FX, Y - step(1600, 2, off) * p, { flip: true });
        }
      }
      if (a.state === 'fight') { // 6 beats: wind-up, lunge, hit (enemy flashes, slash, sparks), recoil, counter-attack, reset
        k = step(900, 6, off);
        var hx = [0, 2, 4, 1, 0, 0][k] * p, ex = [0, 0, 2, 1, -3, 0][k] * p;
        spr(a.idx, X + hx, Y);
        if (k === 4) spr(a.idx, X + hx, Y, { flash: true, alpha: 0.6 });
        spr(a.foe, FX + ex, Y, { flip: true, flash: k === 2 });
        if (k === 2) {
          for (i = 0; i < 4; i++) dot('#ffffff', X + S + i * p, Y + (2 + i * 3) * p, 2);
          dot('#ffd23f', FX + 2 * p, Y + 2 * p); dot('#ffd23f', FX + 12 * p, Y + 5 * p); dot('#ff5a5a', FX + 7 * p, Y);
        }
        return;
      }
      // Finished: for 1.6 s after the change the enemy blinks and falls, the hero hops twice under a raised trophy
      // with a burst of gold; after that the hero rests and cheers (a hop and a sparkle) every few seconds.
      var v = still ? 1 : Math.min(1, el / 1600), fell = v > 0.3;
      if (fell) { ob(OB_BONES, FX, Y + 2 * p, 0.9); spr(a.foe, FX, Y + 3 * p, { flip: true, rot: Math.PI / 2, alpha: 0.55 }); }
      else spr(a.foe, FX, Y, { flip: true, flash: step(200, 2, 0) === 1 });
      if (v < 1) {
        var hop = Math.round(Math.abs(Math.sin(v * 2 * Math.PI)) * 6) * p;
        spr(a.idx, X, Y - hop);
        ob(OB_TROPHY, X, Y - S - 3 * p - Math.round(v * 6) * p, v < 0.7 ? 1 : (1 - v) / 0.3, true); // above the hop's peak
        for (i = 0; i < 8; i++) {
          var g = i / 8 * 6.2832;
          dot(i % 2 ? '#ffd23f' : '#fff3b0', X + S / 2 + Math.cos(g) * v * 14 * p, Y + S / 2 - hop + Math.sin(g) * v * 14 * p);
        }
        return;
      }
      rest(a, a.idx);
    });
    // Not working: wander (hop while running, face the way it runs); while paused, bob and now and then cheer.
    function rest(a, idx) {
      var o = still ? { x: a.x, y: a.y, moving: false, face: 1 } : walk(a, now), off = D.prng('t/' + a.id)() * 5000 | 0;
      var X = Math.round((o.x - d.ox) * 16) * p, Y = Math.round((o.y - d.oy) * 16) * p;
      if (o.moving) return spr(idx, X, Y - step(220, 2, off) * p, { flip: o.face < 0 });
      if (a.state === 'cast') return cast(idx, X, Y, o.face, off);
      var k = step(4000, 10, off);
      spr(idx, X, Y - (k === 0 && a.kind === 'hero' ? 3 : step(1600, 2, off)) * p, { flip: o.face < 0 });
      if (k === 0 && a.kind === 'hero') { dot('#ffd23f', X + 2 * p, Y - 2 * p); dot('#fff3b0', X + 13 * p, Y - p); }
    }
    function cast(idx, X, Y, face, off) { // a turning pentagram on the floor, sparks round the hand, a rune rising off the staff
      var k = step(800, 8, off), j, i, cx = X + S / 2 - p, cy = Y + S - 2 * p;
      function pt(a) { return [cx + Math.cos(a) * 22 * p, cy + Math.sin(a) * 11 * p]; } // a circle lying on the floor, seen from above
      for (j = 0; j < 36; j++) { var c = pt(j / 36 * 6.2832); dot(k % 2 ? '#b48cff' : '#8f6bd6', c[0], c[1], 2); }
      for (j = 0; j < 5; j++) { // star: each point joins the one two along; one loop turns it a fifth, so the loop is seamless
        var a = pt((j + k / 8) * 1.2566 - 1.5708), b = pt((j + 2 + k / 8) * 1.2566 - 1.5708);
        for (i = 0; i <= 20; i++) dot(i % 20 ? '#ff5ad0' : '#fff3b0', a[0] + (b[0] - a[0]) * i / 20, a[1] + (b[1] - a[1]) * i / 20, i % 20 ? 1 : 2);
      }
      for (j = 0; j < 3; j++) {
        var b = (j / 3 + k / 8) * 6.2832;
        dot(['#ffffff', '#ffd23f', '#b48cff'][j], X + S / 2 + Math.cos(b) * 7 * p, Y + 4 * p + Math.sin(b) * 4 * p, 2);
      }
      dot('#b48cff', face < 0 ? X + p : X + 13 * p, Y - (k % 4) * 3 * p, 2);
      spr(idx, X, Y - (k % 2) * p, { flip: face < 0 });
    }
  }

  var Actors = { place: place, stamp: stamp, draw: draw, walk: walk, trip: trip, sprite: sprite, HERO: HERO, FOES: FOES, OPEN_CHEST: OPEN_CHEST };
  if (typeof module !== 'undefined' && module.exports) module.exports = Actors;
  root.Actors = Actors;
})(typeof window !== 'undefined' ? window : this);
