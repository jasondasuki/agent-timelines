/* Procedural dungeon for the agent tree: one room per node, one corridor per parent->child edge.
 * Layout is append-only: room i depends only on seed, node i and rooms 0..i-1, in world coordinates
 * (root at 0,0, may be negative). tiles[y][x] is world cell (x+ox, y+oy); rooms/paths/deco use world coords.
 * Every random look choice hashes (seed, room id) or (seed, world cell), so appending nodes never redecorates.
 * Plain ES5 syntax (Math.imul aside); window.Dungeon, and module.exports for Node. */
(function (root) {
  'use strict';
  // Sprite indices are row*cols+col, 16px. tiles[][] are all 'td'; deco entries name their sheet.
  var COLS = { td: 12, ob: 48 }; // td = Kenney Tiny Dungeon, ob = Kenney 1-Bit Pack (colored)
  var FLOOR = 48, FLOOR_SPECK = 49, FLOOR_STONES = 42; // td sand: plain, specks, loose stones (rooms)
  var CORRIDOR = 0, CORR_HOLES = 12, CORR_RUBBLE = 24; // td brown dirt: plain, holes, rubble (corridors)
  var DOOR = 45;          // td wooden door in a dark stone frame
  var WALL = 40;          // td grey brick wall face (walkable floor directly south)
  var WALL_GRATE = 28;    // td brick face with a barred grate (rare face variant)
  var WALL_TOP = 37;      // td wall cap, horizontal stone bars, wall on both sides
  var TOP_L = 36, TOP_R = 38, TOP_LR = 39; // td wall cap with a dark outline on the left / right / both ends
  var BANNER = 29;        // td red and gold shield banner hung on a brick face
  var HEARTH_L = 10, HEARTH_R = 11; // td two-wide dark fireplace arch with glowing embers (left, right half)
  var TABLE = 72;         // td wooden table
  var STOOL = 73;         // td small wooden stool
  var BARREL = 82;        // td banded wooden barrel
  var CRATE = 67;         // td wooden crate with iron bands
  var CHEST = 89;         // td closed treasure chest
  var CABINET = 63, CABINET_B = 75; // td tall wooden shelf/cabinets with drawers (two variants)
  var OB_SKULL = 720;     // ob skull and crossbones
  var OB_BONES = 721;     // ob bone pile
  var OB_WEB = 722;       // ob cobweb
  var OB_CANDLE = 724;    // ob lit candle (used as a wall sconce and on the table)
  var OB_CANDELABRA = 725; // ob three-armed lit candelabra
  var OB_FLAME = 495;     // ob orange flame, burning inside the hearth arch
  var OB_NOTICE = 352;    // ob notice board on legs
  var OB_RUG_L = 629, OB_RUG = 630, OB_RUG_R = 631; // ob red patterned carpet: left end, middle, right end
  var WALK = [FLOOR, FLOOR_SPECK, FLOOR_STONES, CORRIDOR, CORR_HOLES, CORR_RUBBLE, DOOR];
  var DEF = { minW: 5, maxW: 9, minH: 4, maxH: 7, rootW: 15, rootH: 11 };

  function prng(str) { // FNV-1a string hash -> mulberry32
    var a = 2166136261, i;
    for (i = 0; i < str.length; i++) a = Math.imul(a ^ str.charCodeAt(i), 16777619);
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function inBox(q, x, y, pad) { return x >= q.x - pad && x < q.x + q.w + pad && y >= q.y - pad && y < q.y + q.h + pad; }

  // Door cell in a's wall facing b, plus the free cell just outside it. Doors never sit at a wall's ends
  // (the hall: only its middle 5 cells), so corner and wall props placed earlier can never block a later door.
  function door(a, b) {
    var dx = b.cx - a.cx, dy = b.cy - a.cy, m = a.hall ? 2 : a.w + a.h;
    var hz = Math.abs(dx) * (a.h + b.h) > Math.abs(dy) * (a.w + b.w);
    var sx = hz ? (dx > 0 ? 1 : -1) : 0, sy = hz ? 0 : (dy > 0 ? 1 : -1);
    var x = hz ? (sx > 0 ? a.x + a.w : a.x - 1) : clamp(b.cx, Math.max(a.x + 1, a.cx - m), Math.min(a.x + a.w - 2, a.cx + m));
    var y = hz ? clamp(b.cy, Math.max(a.y + 1, a.cy - m), Math.min(a.y + a.h - 2, a.cy + m)) : (sy > 0 ? a.y + a.h : a.y - 1);
    return { d: [x, y], o: [x + sx, y + sy] };
  }

  // BFS between two door-outside cells around every room's wall ring; null if sealed in.
  function route(rooms, A, B) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, i;
    for (i = 0; i < rooms.length; i++) {
      x0 = Math.min(x0, rooms[i].x - 6); y0 = Math.min(y0, rooms[i].y - 6);
      x1 = Math.max(x1, rooms[i].x + rooms[i].w + 6); y1 = Math.max(y1, rooms[i].y + rooms[i].h + 6);
    }
    var W = x1 - x0, prev = {}, q = [A], head = 0, dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    function key(c) { return (c[1] - y0) * W + c[0] - x0; }
    prev[key(A)] = null;
    while (head < q.length) {
      var c = q[head++];
      if (c[0] === B[0] && c[1] === B[1]) {
        var out = [];
        for (; c; c = prev[key(c)]) out.unshift(c);
        return out;
      }
      for (i = 0; i < 4; i++) {
        var n = [c[0] + dirs[i][0], c[1] + dirs[i][1]], j, bad = n[0] < x0 || n[0] >= x1 || n[1] < y0 || n[1] >= y1 || key(n) in prev;
        for (j = 0; !bad && j < rooms.length; j++) bad = inBox(rooms[j], n[0], n[1], 1);
        if (!bad) { prev[key(n)] = c; q.push(n); }
      }
    }
    return null;
  }

  // Props for one room, from seed + room geometry only. Agent rooms: interior corners and the two end
  // cells of the top wall face, which door() never uses. Hall: everything stays off its door zones.
  function decorate(seed, q) {
    var out = [], X0 = q.x, Y0 = q.y, X1 = q.x + q.w - 1, Y1 = q.y + q.h - 1, cx = q.cx, cy = q.cy, x, y;
    function put(x, y, sheet, idx, solid) {
      if (x >= X0 && x <= X1 && y >= Y0 - 1 && y <= Y1) out.push({ x: x, y: y, sheet: sheet, idx: idx, solid: !!solid });
    }
    if (q.hall) {
      [X0, cx - 3, cx + 3, X1].forEach(function (x) { put(x, Y0 - 1, 'td', BANNER); });
      put(X0 + 2, Y0 - 1, 'td', HEARTH_L); put(X0 + 3, Y0 - 1, 'td', HEARTH_R);
      put(X0 + 2, Y0 - 1, 'ob', OB_FLAME); put(X0 + 3, Y0 - 1, 'ob', OB_FLAME); put(X0 + 1, Y0 - 1, 'ob', OB_NOTICE);
      for (y = cy - 2; y <= cy + 2; y++) for (x = X0 + 2; x <= X1 - 2; x++) put(x, y, 'ob', x === X0 + 2 ? OB_RUG_L : x === X1 - 2 ? OB_RUG_R : OB_RUG);
      for (x = cx - 3; x <= cx + 3; x++) put(x, cy, 'td', TABLE, 1);
      [cx - 3, cx - 1, cx + 1, cx + 3].forEach(function (x) { put(x, cy - 1, 'td', STOOL, 1); put(x, cy + 1, 'td', STOOL, 1); });
      put(cx - 4, cy, 'td', STOOL, 1); put(cx + 4, cy, 'td', STOOL, 1);
      put(cx - 2, cy, 'ob', OB_CANDLE); put(cx + 2, cy, 'ob', OB_CANDLE);
      for (x = X1 - 3; x < X1; x++) put(x, Y0, 'td', x % 2 ? CABINET : CABINET_B, 1);
      put(X0, Y0, 'td', CRATE, 1); put(X1, Y0, 'ob', OB_CANDELABRA, 1);
      put(X0, cy + 3, 'ob', OB_CANDELABRA, 1); put(X1, cy + 3, 'ob', OB_CANDELABRA, 1);
      put(X0, Y1, 'td', BARREL, 1); put(X0 + 1, Y1, 'td', BARREL, 1); put(X1 - 1, Y1, 'td', CRATE, 1); put(X1, Y1, 'td', CHEST, 1);
      return out;
    }
    var r = prng(seed + '/deco/' + q.id), props = [['td', BARREL, 1], ['td', BARREL, 1], ['td', CRATE, 1], ['td', CHEST, 1],
      ['ob', OB_SKULL], ['ob', OB_BONES], ['ob', OB_CANDELABRA, 1]];
    [[X0, Y0], [X1, Y0], [X0, Y1], [X1, Y1]].forEach(function (c, j) {
      var v = r(), p = j < 2 && v < 0.2 ? ['ob', OB_WEB] : props[r() * props.length | 0];
      if (v < 0.65) put(c[0], c[1], p[0], p[1], p[2]);
    });
    [X0, X1].forEach(function (x) { if (r() < 0.6) put(x, Y0 - 1, 'ob', OB_CANDLE); });
    return out;
  }

  function generate(seed, nodes, opts) {
    var o = {}, k, rooms = [], paths = [], cells = [], idx = {};
    for (k in DEF) o[k] = opts && opts[k] != null ? opts[k] : DEF[k];

    nodes.forEach(function (n, i) {
      var r = prng(seed + '/' + n.id), par = i ? rooms[idx[n.parent] || 0] : null;
      var w = o.rootW, h = o.rootH, x = -(w >> 1), y = -(h >> 1), room, p;
      for (k = 0; par; k++) { // candidate spots spiral outward from the parent until one fits and routes
        w = o.minW + (r() * (o.maxW - o.minW + 1) | 0); h = o.minH + (r() * (o.maxH - o.minH + 1) | 0);
        var a = r() * 6.2832, g = 3 + r() * (2 + k / 4);
        x = Math.round(par.cx + Math.cos(a) * ((par.w + w) / 2 + g) - w / 2);
        y = Math.round(par.cy + Math.sin(a) * ((par.h + h) / 2 + g) - h / 2);
        // 3 free cells (wall, lane, wall) between rooms; no corridor cell may touch the new walls
        var ok = rooms.every(function (q) { return x - 3 >= q.x + q.w || x + w + 3 <= q.x || y - 3 >= q.y + q.h || y + h + 3 <= q.y; });
        room = { id: n.id, x: x, y: y, w: w, h: h, cx: x + (w >> 1), cy: y + (h >> 1) };
        ok = ok && !cells.some(function (c) { return inBox(room, c[0], c[1], 1); });
        if (ok && (p = route(rooms.concat(room), door(par, room).o, door(room, par).o))) break;
      }
      room = { id: n.id, x: x, y: y, w: w, h: h, cx: x + (w >> 1), cy: y + (h >> 1) };
      if (!i) room.hall = true;
      if (par) {
        p = [door(par, room).d].concat(p, [door(room, par).d]);
        paths.push({ from: par.id, to: n.id, cells: p });
        cells.push.apply(cells, p);
      }
      idx[n.id] = i;
      rooms.push(room);
    });

    // Rasterise floors and doors, each floor cell's variant hashed from its world cell.
    var T = {}, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    function at(x, y) { return T[x + ',' + y]; }
    function hash(x, y) { return prng(seed + '#' + x + ',' + y)(); }
    function set(x, y, t) { T[x + ',' + y] = t; x0 = Math.min(x0, x - 1); y0 = Math.min(y0, y - 2); x1 = Math.max(x1, x + 2); y1 = Math.max(y1, y + 2); }
    rooms.forEach(function (q) {
      for (var yy = q.y; yy < q.y + q.h; yy++) for (var xx = q.x; xx < q.x + q.w; xx++) {
        var v = hash(xx, yy);
        set(xx, yy, v < 0.05 ? FLOOR_STONES : v < 0.2 ? FLOOR_SPECK : FLOOR);
      }
    });
    paths.forEach(function (pa) {
      pa.cells.forEach(function (c) { var v = hash(c[0], c[1]); set(c[0], c[1], v < 0.06 ? CORR_RUBBLE : v < 0.12 ? CORR_HOLES : CORRIDOR); });
    });
    paths.forEach(function (pa) { [pa.cells[0], pa.cells[pa.cells.length - 1]].forEach(function (c) { T[c[0] + ',' + c[1]] = DOOR; }); });

    // Walls, 3/4 view: a brick face where floor is directly south, a cap row above every face, and a cap
    // on any other empty cell touching floor. Caps get a dark outline on each end that is not more wall.
    var W = {}, x, y, dx, dy;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
      if (at(x, y) != null) continue;
      var near = false;
      for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) near = near || at(x + dx, y + dy) != null;
      if (at(x, y + 1) != null) W[x + ',' + y] = hash(x, y) < 0.08 ? WALL_GRATE : WALL;
      else if (near) W[x + ',' + y] = WALL_TOP;
    }
    function face(x, y) { var t = W[x + ',' + y]; return t === WALL || t === WALL_GRATE; }
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
      if (at(x, y) == null && !W[x + ',' + y] && (face(x - 1, y + 1) || face(x, y + 1) || face(x + 1, y + 1))) W[x + ',' + y] = 'cap';
    }
    var tiles = [];
    for (y = y0; y < y1; y++) {
      var row = [];
      for (x = x0; x < x1; x++) {
        var t = at(x, y) != null ? at(x, y) : W[x + ',' + y];
        if (t === WALL_TOP || t === 'cap') {
          var l = !!W[(x - 1) + ',' + y], r = !!W[(x + 1) + ',' + y];
          t = l && r ? WALL_TOP : l ? TOP_R : r ? TOP_L : TOP_LR;
        }
        row.push(t == null ? -1 : t);
      }
      tiles.push(row);
    }
    var deco = [];
    rooms.forEach(function (q) { deco.push.apply(deco, decorate(seed, q)); });
    return { w: x1 - x0, h: y1 - y0, ox: x0, oy: y0, tiles: tiles, rooms: rooms, paths: paths, deco: deco };
  }

  // sheets = { td: Image, ob: Image }; tiles first, then deco in list order (rug under table under candle).
  function render(ctx, d, sheets, scale) {
    var S = 16 * scale;
    function draw(sheet, t, x, y) {
      ctx.drawImage(sheets[sheet], (t % COLS[sheet]) * 16, ((t / COLS[sheet]) | 0) * 16, 16, 16, x * S, y * S, S, S);
    }
    ctx.imageSmoothingEnabled = false;
    d.tiles.forEach(function (row, y) { row.forEach(function (t, x) { if (t >= 0) draw('td', t, x, y); }); });
    d.deco.forEach(function (e) { draw(e.sheet, e.idx, e.x - d.ox, e.y - d.oy); });
  }

  var Dungeon = { generate: generate, render: render, prng: prng, COLS: COLS, T: {
    FLOOR: FLOOR, CORRIDOR: CORRIDOR, DOOR: DOOR, WALL: WALL, WALL_TOP: WALL_TOP, WALK: WALK,
    BANNER: BANNER, HEARTH_L: HEARTH_L, TABLE: TABLE, CABINET: CABINET, OB_RUG: OB_RUG } };
  if (typeof module !== 'undefined' && module.exports) module.exports = Dungeon;
  root.Dungeon = Dungeon;
})(typeof window !== 'undefined' ? window : this);
