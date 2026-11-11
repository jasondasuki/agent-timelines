/* Procedural dungeon for the agent tree: one room per node, one corridor per parent->child edge.
 * Layout is append-only: room i depends only on seed, node i and rooms 0..i-1, in world coordinates
 * (root at 0,0, may be negative). tiles[y][x] is world cell (x+ox, y+oy); rooms/paths/deco use world coords.
 * Every random look choice hashes (seed, room id) or (seed, world cell), so appending nodes never redecorates.
 * generate() lays it out, render() paints the still map, glow() adds the per-frame light and flames.
 * Plain ES5 syntax (Math.imul aside); window.Dungeon, and module.exports for Node. */
(function (root) {
  'use strict';
  // Sprite indices are row*cols+col, 16px. tiles[][] are all 'td'; deco and fx entries name their sheet.
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
  var ANVIL = 74, TOMB = 64, TOMB_B = 65, POTION = 114, POTION_B = 116, BLADE = 106; // td anvil, two gravestones, green and blue potion, sword
  var OB_SKULL = 720, OB_BONES = 721, OB_BONE = 608, OB_WEB = 722; // ob skull and crossbones, bone pile, single bone, cobweb
  var OB_CANDLE = 724, OB_CANDELABRA = 725; // ob lit candle, three-armed candelabra (both get a live flame and a light)
  var OB_NOTICE = 352;    // ob notice board on legs: the quest board
  var OB_ANTLERS = 590;   // ob mounted antlers
  var OB_SHELF = 293, OB_SHELF_B = 339, OB_DESK = 338, OB_DESK_B = 340, OB_BED = 389; // ob bookshelves, writing desks, bed
  var OB_FORGE = 393, OB_CAULDRON = 677, OB_FLASK = 570; // ob forge with chimney, cauldron, big flask
  var OB_GRAVE = 672, OB_GRAVE_B = 674; // ob gravestones
  var OB_COINS = 233, OB_CROWN = 139, OB_GEM = 512, OB_KEY = 560; // ob coin stack, crown, gem, gold key
  var OB_SHIELD = 229, OB_SHIELD_B = 231, OB_SHIELD_C = 183, OB_BOW = 277; // ob shields and a bow, hung on walls
  var OB_MAP = 752, OB_SCROLL = 753, OB_SCROLL_B = 754, OB_TABLET = 565, OB_MIRROR = 384, OB_SKULL_B = 610; // ob wall and floor pieces
  var OB_MEAT = 801, OB_CHEESE = 802, OB_APPLE = 897; // ob food on the hall table
  // One look per room, chosen by who works there (see TIER_THEME). floor: plank | stone | sand (td sand tiles);
  // col: floor colour, or a few to pick from per room; spots: [chance, colour, pixels] floor specks; props: corner props [sheet, idx, solid];
  // hang: wall hangings [sheet, idx]; fx: a live effect at the room's centre (see glow()).
  var THEMES = {
    hall:    { floor: 'plank', col: '#a5673c', spots: [[0.03, '#7a4a2e', 2]] },
    armory:  { floor: 'stone', col: ['#727a94', '#8c8078', '#6c8279'], spots: [[0.06, '#3d3f52', 4]],
      props: [['td', ANVIL, 1], ['ob', OB_FORGE, 1], ['td', CRATE, 1], ['td', BLADE, 1], ['ob', OB_SHIELD_C, 1], ['td', BARREL, 1]],
      hang: [['ob', OB_SHIELD], ['ob', OB_SHIELD_B], ['ob', OB_BOW]] },
    library: { floor: 'plank', col: '#7d5236', spots: [[0.05, '#e8dcc0', 2]],
      props: [['ob', OB_SHELF, 1], ['ob', OB_SHELF_B, 1], ['ob', OB_SHELF, 1], ['ob', OB_DESK_B, 1], ['td', CABINET, 1], ['ob', OB_SCROLL_B]],
      hang: [['ob', OB_MAP], ['ob', OB_SCROLL]] },
    lab:     { floor: 'stone', col: '#6f6490', spots: [[0.07, '#8f6bd6', 3]], fx: 'rune',
      props: [['ob', OB_CAULDRON, 1], ['td', POTION, 1], ['td', POTION_B, 1], ['ob', OB_FLASK, 1], ['td', TABLE, 1], ['ob', OB_CANDELABRA, 1]],
      hang: [['ob', OB_TABLET], ['ob', OB_MAP]] },
    study:   { floor: 'plank', col: '#8f6a45', spots: [[0.05, '#e8dcc0', 2]],
      props: [['ob', OB_DESK, 1], ['ob', OB_BED, 1], ['td', TABLE, 1], ['td', STOOL, 1], ['ob', OB_SCROLL], ['ob', OB_CANDELABRA, 1]],
      hang: [['ob', OB_MIRROR], ['ob', OB_MAP]] },
    pit:     { floor: 'sand', spots: [[0.07, '#8a2a2a', 4]],
      props: [['td', BARREL, 1], ['td', CRATE, 1], ['ob', OB_SKULL], ['ob', OB_BONES], ['ob', OB_BONE], ['ob', OB_MEAT]],
      hang: [['ob', OB_ANTLERS], ['ob', OB_BOW], ['td', BANNER]] },
    vault:   { floor: 'stone', col: '#8c7c52', spots: [[0.1, '#ffd23f', 2]], fx: 'gold',
      props: [['td', CHEST, 1], ['td', CHEST, 1], ['ob', OB_COINS, 1], ['ob', OB_CROWN, 1], ['ob', OB_GEM, 1], ['td', CRATE, 1]],
      hang: [['ob', OB_KEY], ['ob', OB_SHIELD_C]] },
    crypt:   { floor: 'stone', col: ['#586c7c', '#6a6080', '#5c7466'], spots: [[0.14, '#4f8a5b', 3], [0.05, '#3d5f86', 6]], fx: 'wisp',
      props: [['td', TOMB, 1], ['td', TOMB_B, 1], ['ob', OB_GRAVE, 1], ['ob', OB_GRAVE_B, 1], ['ob', OB_SKULL], ['ob', OB_BONES]],
      hang: [['ob', OB_WEB], ['ob', OB_SKULL_B]] }
  };
  // viewer tier -> theme; a workflow run gets the vault, anything else the crypt
  var TIER_THEME = { executor: 'armory', scanner: 'library', plan: 'lab', writer: 'study', runner: 'pit' };
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

  // Props for one room, from seed + room geometry + theme only. Agent rooms: interior corners, which door()
  // never uses. Hall: everything stays off its door zones. The hall's carpet is room.rug, drawn by render().
  function decorate(seed, q) {
    var out = [], X0 = q.x, Y0 = q.y, X1 = q.x + q.w - 1, Y1 = q.y + q.h - 1, cx = q.cx, cy = q.cy, x;
    function put(x, y, sheet, idx, solid) {
      if (x >= X0 && x <= X1 && y >= Y0 - 1 && y <= Y1) out.push({ x: x, y: y, sheet: sheet, idx: idx, solid: !!solid });
    }
    if (q.hall) {
      [X0, cx - 3, cx + 3, X1].forEach(function (x) { put(x, Y0 - 1, 'td', BANNER); });
      put(X0 + 2, Y0 - 1, 'td', HEARTH_L); put(X0 + 3, Y0 - 1, 'td', HEARTH_R); put(X0 + 1, Y0 - 1, 'ob', OB_NOTICE);
      put(X1 - 2, Y0 - 1, 'ob', OB_ANTLERS);
      for (x = cx - 3; x <= cx + 3; x++) put(x, cy, 'td', TABLE, 1);
      [cx - 3, cx - 1, cx + 1, cx + 3].forEach(function (x) { put(x, cy - 1, 'td', STOOL, 1); put(x, cy + 1, 'td', STOOL, 1); });
      put(cx - 4, cy, 'td', STOOL, 1); put(cx + 4, cy, 'td', STOOL, 1);
      put(cx - 2, cy, 'ob', OB_CANDLE); put(cx + 2, cy, 'ob', OB_CANDLE);
      put(cx - 3, cy, 'ob', OB_MEAT); put(cx, cy, 'ob', OB_CHEESE); put(cx + 1, cy, 'ob', OB_APPLE); put(cx + 3, cy, 'td', POTION);
      for (x = X1 - 3; x < X1; x++) put(x, Y0, 'td', x % 2 ? CABINET : CABINET_B, 1);
      put(X1, Y0, 'td', BARREL, 1); put(X1, Y0 + 1, 'td', BARREL, 1); put(X1, Y0 + 2, 'ob', OB_CANDELABRA, 1);
      put(X0, Y0, 'td', CRATE, 1); put(X0, Y0 + 1, 'td', BLADE, 1);
      put(X0, cy + 3, 'ob', OB_CANDELABRA, 1); put(X1, cy + 3, 'ob', OB_CANDELABRA, 1);
      put(X0, Y1 - 1, 'td', CRATE, 1); put(X0, Y1, 'td', BARREL, 1); put(X0 + 1, Y1, 'td', BARREL, 1);
      put(X1 - 2, Y1, 'ob', OB_COINS, 1); put(X1 - 1, Y1, 'td', CRATE, 1); put(X1, Y1, 'td', CHEST, 1);
      return out;
    }
    var r = prng(seed + '/deco/' + q.id), props = THEMES[q.theme].props;
    [[X0, Y0], [X1, Y0], [X0, Y1], [X1, Y1]].forEach(function (c, j) {
      var v = r(), p = j < 2 && v < 0.12 ? ['ob', OB_WEB] : props[r() * props.length | 0];
      if (v < 0.8) put(c[0], c[1], p[0], p[1], p[2]);
    });
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
      room.theme = !i ? 'hall' : n.kind === 'wf' ? 'vault' : TIER_THEME[n.tier] || 'crypt';
      if (!i) { room.hall = true; room.rug = { x: x + 2, y: room.cy - 2, w: w - 4, h: 5 }; }
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
    // fx: wall fixtures and live effects, read by render() (static part) and glow() (flames, light). Each names
    // its room index so its light stays inside that room. Wall pieces sit on the top wall face; the two end
    // cells never get a door, and a hanging in between gives way if a later door opens there.
    var deco = [], fx = [];
    rooms.forEach(function (q, i) {
      var th = THEMES[q.theme], r = prng(seed + '/fx/' + q.id), X1 = q.x + q.w - 1, yw = q.y - 1;
      decorate(seed, q).forEach(function (e) {
        deco.push(e);
        if (e.sheet === 'ob' && (e.idx === OB_CANDLE || e.idx === OB_CANDELABRA)) fx.push({ k: e.idx === OB_CANDLE ? 'candle' : 'candelabra', x: e.x, y: e.y, room: i });
      });
      if (q.hall) {
        fx.push({ k: 'hearth', x: q.x + 2, y: yw, room: i }, { k: 'lamp', x: q.cx, y: q.cy, room: i },
          { k: 'torch', x: X1 - 3, y: yw, room: i }, { k: 'torch', x: X1 - 1, y: yw, room: i });
        return;
      }
      fx.push({ k: 'torch', x: q.x, y: yw, room: i }, { k: 'torch', x: X1, y: yw, room: i });
      for (x = q.x + 2; x <= X1 - 2; x += 2) {
        var v = r(), hg = th.hang[r() * th.hang.length | 0];
        if (v < 0.5 && face(x, yw)) fx.push({ k: 'spr', x: x, y: yw, room: i, sheet: hg[0], idx: hg[1] });
      }
      if (th.fx) fx.push({ k: th.fx, x: q.cx, y: q.cy, room: i });
    });
    return { seed: seed, w: x1 - x0, h: y1 - y0, ox: x0, oy: y0, tiles: tiles, rooms: rooms, paths: paths, deco: deco, fx: fx };
  }

  var VOID = '#0d0912', INK = 'rgba(8,4,16,';   // outside the dungeon; shadow colour (alpha appended)
  function shade(hex, f) { // a #rrggbb colour, brightness scaled by f
    var n = parseInt(hex.slice(1), 16);
    function c(s) { return Math.max(0, Math.min(255, Math.round((n >> s & 255) * f))); }
    return 'rgb(' + c(16) + ',' + c(8) + ',' + c(0) + ')';
  }
  function noise(a, b) { var v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); } // cheap 0..1 hash, drawing only

  // The still picture, drawn once per layout: rock, themed floors, walls, shadows, carpet, props, wall fixtures.
  // sheets = { td: Image, ob: Image }. Floors and rock are painted in code, in whole sprite pixels, so they
  // stay pixel art; every random choice hashes (seed, world cell), so a growing dungeon never repaints old rooms.
  function render(ctx, d, sheets, scale) {
    var P = scale, S = 16 * P, room = {}, sn = prng(d.seed + '/paint')() * 997;
    function draw(sheet, t, x, y) {
      ctx.drawImage(sheets[sheet], (t % COLS[sheet]) * 16, ((t / COLS[sheet]) | 0) * 16, 16, 16, x * S, y * S, S, S);
    }
    function R(c, x, y, w, h) { ctx.fillStyle = c; ctx.fillRect(x * P, y * P, (w || 1) * P, (h || 1) * P); } // rect in sprite pixels
    function T(x, y) { var row = d.tiles[y]; return row && row[x] != null ? row[x] : -1; }
    function cap(t) { return t >= TOP_L && t <= TOP_LR; }
    function brick(t) { return t === WALL || t === WALL_GRATE; }
    function stone(q, wx, wy, X, Y) { // flagstones: 16x8 slabs, every other row shifted half a slab
      for (var k = 0; k < 2; k++) {
        var gy = wy * 2 + k, off = gy % 2 ? 8 : 0, y = Y + k * 8;
        if (off) R(shade(q, 0.86 + 0.24 * noise(wx - 1 + sn, gy)), X, y, 8, 8);
        R(shade(q, 0.86 + 0.24 * noise(wx + sn, gy)), X + off, y, 16 - off, 8);
        R(shade(q, 0.62), X, y + 7, 16, 1); R(shade(q, 0.62), X + off, y, 1, 8);
      }
    }
    function plank(q, wx, wy, X, Y) { // floorboards: 4px rows of 48px boards, each row's joints shifted
      for (var k = 0; k < 4; k++) {
        var gy = wy * 4 + k, at = wx * 16 + (noise(gy, sn) * 12 | 0) * 4, j = (48 - at % 48) % 48, id = Math.floor(at / 48), y = Y + k * 4;
        R(shade(q, 0.84 + 0.28 * noise(id + sn, gy)), X, y, 16, 4);
        if (j > 0 && j < 16) R(shade(q, 0.84 + 0.28 * noise(id + 1 + sn, gy)), X + j, y, 16 - j, 4);
        if (j < 16) R(shade(q, 0.55), X + j, y, 1, 4);
        R(shade(q, 0.62), X, y + 3, 16, 1);
      }
    }
    ctx.imageSmoothingEnabled = false;
    d.rooms.forEach(function (q) { for (var y = q.y; y < q.y + q.h; y++) for (var x = q.x; x < q.x + q.w; x++) room[(x - d.ox) + ',' + (y - d.oy)] = q; });
    R(VOID, 0, 0, d.w * 16, d.h * 16);
    d.tiles.forEach(function (row, y) { row.forEach(function (t, x) {
      var X = x * 16, Y = y * 16, wx = x + d.ox, wy = y + d.oy, r = prng(d.seed + '~' + wx + ',' + wy), q = room[x + ',' + y], i;
      if (t < 0) { if (r() < 0.3) R('#1a1424', X + (r() * 14 | 0), Y + (r() * 15 | 0), 2, 1); return; } // faint flecks in the dark
      if (cap(t)) { // wall top: rough rock, outlined where it meets anything but more wall, lit lip above a brick face
        R('#3a3350', X, Y, 16, 16);
        for (i = 0; i < 5; i++) R(i % 2 ? '#4a4263' : '#2c2640', X + (r() * 14 | 0), Y + (r() * 15 | 0), 2, 1);
        [[0, -1, 0, 0, 16, 1], [-1, 0, 0, 0, 1, 16], [1, 0, 15, 0, 1, 16], [0, 1, 0, 15, 16, 1]].forEach(function (e) {
          var n = T(x + e[0], y + e[1]);
          if (e[1] === 1 && brick(n)) R('#5d5579', X, Y + 14, 16, 2);
          else if (!cap(n) && !brick(n)) R('#1c1628', X + e[2], Y + e[3], e[4], e[5]);
        });
        return;
      }
      if (brick(t)) { // brick face: grime along the foot, now and then moss
        draw('td', t, x, y); R(INK + '.28)', X, Y + 13, 16, 3);
        if (r() < 0.14) for (i = 0; i < 4; i++) R(i % 2 ? '#4f8a5b' : '#3a6b48', X + (r() * 14 | 0), Y + 11 + (r() * 4 | 0), 2, 1);
        return;
      }
      var th = q && THEMES[q.theme], col = th && (typeof th.col === 'string' ? th.col : th.col && th.col[prng(d.seed + '/col/' + q.id)() * th.col.length | 0]);
      if (th && th.floor === 'stone') stone(col, wx, wy, X, Y);
      else if (th && th.floor === 'plank') plank(col, wx, wy, X, Y);
      else draw('td', t, x, y);
      if (th && t !== DOOR) {
        if (r() < 0.07) for (i = 0; i < 4; i++) R(INK + '.4)', X + 4 + i * 2, Y + 5 + i + (r() * 2 | 0), 2, 1); // crack
        th.spots.forEach(function (sp) {
          if (r() >= sp[0]) return;
          var px = 3 + (r() * 9 | 0), py = 3 + (r() * 9 | 0);
          for (i = 0; i < sp[2]; i++) R(sp[1], X + px + (r() * 4 | 0), Y + py + (r() * 3 | 0), 2, 1);
        });
      }
      // depth: the wall above and the wall to the left throw a shadow on the floor
      if (brick(T(x, y - 1)) || T(x, y - 1) === DOOR) { R(INK + '.4)', X, Y, 16, 3); R(INK + '.2)', X, Y + 3, 16, 2); }
      if (cap(T(x - 1, y))) R(INK + '.24)', X, Y, 2, 16);
    }); });

    d.rooms.forEach(function (q) { // the hall's carpet: red field, gold border and fringe, a diamond per cell
      var g = q.rug, x, y, j;
      if (!g) return;
      var X = (g.x - d.ox) * 16, Y = (g.y - d.oy) * 16, W = g.w * 16, H = g.h * 16;
      R(INK + '.3)', X + 1, Y + H, W, 1);
      R('#8e2334', X, Y, W, H); R('#d9a441', X + 2, Y + 2, W - 4, H - 4); R('#7a1c2c', X + 4, Y + 4, W - 8, H - 8);
      R('#5e1522', X + 6, Y + 6, W - 12, 1); R('#5e1522', X + 6, Y + H - 7, W - 12, 1);
      for (y = 0; y < g.h; y++) for (x = 0; x < g.w; x++) for (j = 0; j < 3; j++) {
        if (x && y && x < g.w - 1 && y < g.h - 1) R(j === 2 ? '#d9a441' : '#b8394a', X + x * 16 + 5 + j, Y + y * 16 + 5 + j, 6 - 2 * j, 6 - 2 * j);
      }
      for (j = 1; j < H; j += 2) { R('#d9a441', X - 2, Y + j, 2, 1); R('#d9a441', X + W, Y + j, 2, 1); }
    });
    d.fx.forEach(function (e) { // still part of the effects: the lab's rune ring, sprites hung on walls, torch brackets
      var X = (e.x - d.ox) * 16, Y = (e.y - d.oy) * 16, j;
      if (e.k === 'rune') for (j = 0; j < 20; j++) R('#4f3f86', X + 7 + Math.round(Math.cos(j / 20 * 6.2832) * 9), Y + 7 + Math.round(Math.sin(j / 20 * 6.2832) * 9), 2, 2);
      if (e.k === 'spr') draw(e.sheet, e.idx, e.x - d.ox, e.y - d.oy);
      if (e.k === 'torch') { R('#1c1628', X + 7, Y + 8, 2, 6); R('#8a5a33', X + 5, Y + 7, 6, 2); R('#1c1628', X + 5, Y + 9, 6, 1); }
    });
    d.deco.forEach(function (e) { // props in list order (table under candle); solid ones stand on a shadow
      if (e.solid) R(INK + '.32)', (e.x - d.ox) * 16 + 1, (e.y - d.oy) * 16 + 14, 14, 2);
      draw(e.sheet, e.idx, e.x - d.ox, e.y - d.oy);
    });
  }

  // Light for each kind of fx: [radius in cells, strength 0..1, colour "r,g,b", dx, dy of the source inside its cell].
  // A room that appears while you watch is not just there: its corridor is dug cell by cell from the parent's door,
  // then the room fades in from the dark in 4 steps. hidden() is the pure part: for a room born `age` ms ago,
  // the corridor cells not dug yet and how dark the room still is (1..0).
  var DIG_MS = 40, DIG_MAX = 800, FADE_MS = 480;
  function hidden(d, id, age) {
    var pa = d.paths.filter(function (p) { return p.to === id; })[0], L = pa ? pa.cells.length : 0, per = L ? Math.min(DIG_MS, DIG_MAX / L) : 0;
    var f = (age - L * per) / FADE_MS;
    return { cells: L ? pa.cells.slice(Math.max(0, Math.floor(age / per))) : [], dark: f >= 1 ? 0 : f <= 0 ? 1 : 1 - Math.floor(f * 4) / 4 };
  }
  // Drawn last, over the light: actors carry born (Actors.stamp); -Infinity = it was there when you first looked.
  function reveal(ctx, d, scale, now, actors) {
    var S = 16 * scale, rooms = {};
    d.rooms.forEach(function (q) { rooms[q.id] = q; });
    ctx.save(); ctx.fillStyle = VOID;
    actors.forEach(function (a) {
      var q = rooms[a.id], age = now - a.born;
      if (!q || !(age < DIG_MAX + FADE_MS)) return;
      var h = hidden(d, a.id, age);
      ctx.globalAlpha = 1; // an undug cell hides its walls too (one cell round it, two above for the wall face and cap)
      h.cells.forEach(function (c) { ctx.fillRect((c[0] - 1 - d.ox) * S, (c[1] - 2 - d.oy) * S, 3 * S, 4 * S); });
      ctx.globalAlpha = h.dark;
      ctx.fillRect((q.x - 1 - d.ox) * S, (q.y - 2 - d.oy) * S, (q.w + 2) * S, (q.h + 3) * S);
    });
    ctx.restore();
  }

  var LIGHT = { torch: [3, 0.9, '255,140,50', 0.5, 0.6], hearth: [4.8, 1, '255,120,40', 1, 0.9], lamp: [6.5, 0.45, '255,190,110', 0.5, 0.5],
    candle: [2, 0.8, '255,190,90', 0.5, 0.2], candelabra: [2.5, 0.85, '255,190,90', 0.5, 0.2] }; // rune, gold and wisp glow by themselves: a pool at the room's centre would light the monster
  var GL = 8; // light-map pixels per cell: the dark is drawn small and scaled up, so its edges are blocky like the art

  // The moving part, drawn every frame over the map and its characters: darkness with a stepped pool of light
  // round every flame (characters carry none), then the flames, embers and sparkles themselves on top (they glow).
  // A room where the agent is still working burns brighter; one that failed or went berserk turns sickly green;
  // a boss room (actor.rank) turns blood red while the boss fights (drawing only, the layout never reads rank).
  // actors = Actors.place() output after stamp(); still = true (reduced motion) freezes every flicker.
  function glow(ctx, d, scale, now, still, actors) {
    var P = scale, S = 16 * P, L = d.light, mood = {}, lights = [];
    function R(c, x, y, w, h) { ctx.fillStyle = c; ctx.fillRect(Math.round(x) * P, Math.round(y) * P, (w || 1) * P, (h || 1) * P); }
    function step(period, n, off) { return still ? 0 : Math.floor((now + off) % period / period * n); }
    if (!L) { // per dungeon: the light map, and a mask that keeps rooms and corridors dimly visible with no flame near
      L = d.light = { c: document.createElement('canvas'), m: document.createElement('canvas') };
      L.c.width = L.m.width = d.w * GL; L.c.height = L.m.height = d.h * GL;
      var m = L.m.getContext('2d');
      m.fillStyle = 'rgba(0,0,0,.5)';
      d.rooms.forEach(function (q) { m.fillRect((q.x - d.ox) * GL, (q.y - 1 - d.oy) * GL, q.w * GL, (q.h + 1) * GL); });
      m.fillStyle = 'rgba(0,0,0,.55)';
      d.paths.forEach(function (p) { p.cells.forEach(function (c) { m.fillRect((c[0] - d.ox) * GL, (c[1] - d.oy) * GL, GL, GL); }); });
    }
    var tick = still ? 0 : Math.floor(now / 70), key = tick + '|' + (actors || []).map(function (a) { return a.state + (a.rank || ''); }).join();
    if (L.key !== key) { // the light map only changes with a flicker step or a new state: redo it then, not every frame
      L.key = key;
      (actors || []).forEach(function (a) {
        mood[a.id] = a.failed ? 'bad' : a.rank === 'boss' && a.state === 'fight' ? 'boss' : a.state === 'fight' ? 'hot' : '';
      });
      d.fx.forEach(function (e, j) {
        var k = LIGHT[e.k], q = d.rooms[e.room], md = mood[q.id];
        if (k) lights.push({ x: e.x + k[3], y: e.y + k[4], r: k[0] * (md === 'hot' || md === 'boss' ? 1.2 : md ? 0.85 : 1), a: k[1],
          c: md === 'bad' ? '120,255,170' : md === 'boss' ? '255,50,40' : k[2], q: q, n: j, t: md === 'boss' ? 2.5 : 1 });
      });
      d.rooms.forEach(function (q) { // a boss room with no flame still gets the red glow: one pool at its centre
        if (mood[q.id] === 'boss' && !lights.some(function (l) { return l.q === q; }))
          lights.push({ x: q.x + q.w / 2, y: q.y + q.h / 2, r: Math.max(q.w, q.h) * 0.8, a: 0.5, c: '255,50,40', q: q, n: 99, t: 2.5 });
      });
      var g = L.c.getContext('2d');
      g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, L.c.width, L.c.height);
      g.fillStyle = 'rgba(14,7,20,.8)'; g.fillRect(0, 0, L.c.width, L.c.height);
      g.globalCompositeOperation = 'destination-out'; g.drawImage(L.m, 0, 0);
      [0, 1].forEach(function (pass) { // 0: cut each pool out of the dark in three hard steps; 1: tint its heart with the flame's colour
        g.globalCompositeOperation = pass ? 'source-over' : 'destination-out';
        lights.forEach(function (l, j) {
          var q = l.q, x = (l.x - d.ox) * GL, y = (l.y - d.oy) * GL;
          var r = l.r * GL * (still ? 1 : 0.94 + 0.12 * noise(l.n, Math.floor(now / 140))), gr = g.createRadialGradient(x, y, 0, x, y, r);
          [[0, 1], [0.36, 1], [0.37, 0.62], [0.68, 0.62], [0.69, 0.3], [1, 0.3]].forEach(function (s) {
            gr.addColorStop(s[0], pass ? 'rgba(' + l.c + ',' + (s[1] > 0.3 ? Math.min(0.15 * l.t * s[1] * l.a, 0.4) : 0) + ')' : 'rgba(0,0,0,' + s[1] * l.a + ')');
          });
          g.save(); g.beginPath(); g.rect((q.x - 1 - d.ox) * GL, (q.y - 1 - d.oy) * GL, (q.w + 2) * GL, (q.h + 2) * GL); g.clip(); // light stays in its room and on its walls
          g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); g.restore();
        });
      });
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(L.c, 0, 0, L.c.width, L.c.height, 0, 0, d.w * S, d.h * S);

    function flame(x, y, m, k) { // x = centre, y = base, m = size, k = frame 0..2
      var o = '#ff7a1a', tx = [0, -1, 1][k] * m;
      R(o, x - 2 * m, y - 3 * m, 4 * m, 3 * m); R(o, x - m + tx, y - (5 + (k === 1)) * m, 2 * m, 3 * m);
      R('#ffd23f', x - m, y - 3 * m, 2 * m, 2 * m); R('#ffd23f', x - m + tx + (k === 2 ? m : 0), y - 4 * m, m, m);
      R('#fff3b0', x - m + (k & 1) * m, y - 2 * m, m, m);
    }
    d.fx.forEach(function (e, j) {
      var X = (e.x - d.ox) * 16, Y = (e.y - d.oy) * 16, q = d.rooms[e.room], off = j * 137, k = step(360, 3, off), t = still ? 0 : now / 1000, n, a;
      if (e.k === 'torch') flame(X + 8, Y + 8, 1, k);
      if (e.k === 'hearth') {
        flame(X + 9, Y + 15, 1, step(360, 3, 120)); flame(X + 23, Y + 15, 1, step(360, 3, 240)); flame(X + 16, Y + 15, 2, k);
        for (n = 0; n < 6 && !still; n++) { a = (t / 2.4 + n / 6) % 1; R(n % 2 ? '#ffd23f' : '#ff7a1a', X + 16 + Math.sin(n * 2.4 + a * 6) * 8, Y + 8 - a * 24); } // sparks up the chimney
      }
      if (e.k === 'candle') R('#fff3b0', X + 7 + (k & 1), Y + 2);
      if (e.k === 'candelabra') for (n = 0; n < 3; n++) R('#fff3b0', X + 2 + n * 5 + ((k + n) & 1), Y + 1);
      if (e.k === 'rune') for (n = 0; n < 5; n++) { a = n / 5 * 6.2832 + t * 0.8; R(n % 2 ? '#c9a6ff' : '#8f6bd6', X + 7 + Math.cos(a) * 9, Y + 7 + Math.sin(a) * 9, 2, 2); }
      if (e.k === 'wisp') for (n = 0; n < 2; n++) R(n ? '#7dffb0' : '#d6ffe6', X + 8 + Math.sin(t * 0.7 + n * 3) * 14, Y + 4 + Math.cos(t * 1.1 + n * 2) * 6, 2 - n, 2 - n);
      if (e.k === 'gold') for (n = 0; n < 3; n++) { // a glint somewhere in the vault, moving every half second
        var f = Math.floor(t * 2) + n * 7, gx = (q.x - d.ox + noise(f, j) * q.w) * 16, gy = (q.y - d.oy + noise(j, f) * q.h) * 16;
        R('#fff3b0', gx - 1, gy, 3, 1); R('#fff3b0', gx, gy - 1, 1, 3);
      }
      if (e.k === 'lamp') for (n = 0; n < 10 && !still; n++) // dust drifting through the hall's light
        R('rgba(255,236,200,.55)', (q.x - d.ox + (noise(n, 3) + t * 0.012 * (1 + n % 3)) % 1 * q.w) * 16, (q.y - d.oy + (noise(n, 9) + Math.sin(t * 0.3 + n) * 0.03 + 1) % 1 * q.h) * 16);
    });
  }

  var Dungeon = { generate: generate, render: render, glow: glow, reveal: reveal, hidden: hidden, prng: prng, COLS: COLS, THEMES: THEMES, T: {
    FLOOR: FLOOR, CORRIDOR: CORRIDOR, DOOR: DOOR, WALL: WALL, WALL_GRATE: WALL_GRATE, WALL_TOP: WALL_TOP, WALK: WALK,
    BANNER: BANNER, HEARTH_L: HEARTH_L, TABLE: TABLE, CABINET: CABINET } };
  if (typeof module !== 'undefined' && module.exports) module.exports = Dungeon;
  root.Dungeon = Dungeon;
})(typeof window !== 'undefined' ? window : this);
