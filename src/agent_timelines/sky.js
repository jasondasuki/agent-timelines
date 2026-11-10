/* The lobby's backdrop: a pixel night over the guild's towers (a bright day in the light colour scheme).
 * draw() paints one frame from the time alone, so it needs no state and can be tested with a fake context;
 * start() sizes a small canvas (one canvas pixel = PX screen pixels, so it stays chunky) and repaints ~11 times a second.
 * Plain ES5; window.Sky, and module.exports for Node. */
(function (root) {
  'use strict';
  var PX = 3, BAT = 120, GHOST = 121; // td sprite indices (12 columns)
  var LOOK = {
    night: { sky: ['#0d0920', '#130e2e', '#1b1340', '#281a54', '#3d2064', '#5a2a6a'], orb: '#f4ead5', spot: '#cfc3ae', cloud: 'rgba(130,105,185,.3)',
      far: '#1a1233', near: '#120c24', wall: '#241a38', edge: '#33264d', lit: ['#ffd23f', '#ff9f43'], flag: '#c62828' },
    day: { sky: ['#3f8fd8', '#56a2e2', '#74b7ec', '#98cdf3', '#c3e1f7', '#f3ead0'], orb: '#ffd23f', spot: '#ffe680', cloud: 'rgba(255,255,255,.85)',
      far: '#7fae8f', near: '#4f8a5b', wall: '#8a8fa3', edge: '#a9aec0', lit: ['#3b2a1e', '#3b2a1e'], flag: '#c62828' }
  };
  function noise(a, b) { var v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); }

  // g: 2d context of a W x H canvas; t: milliseconds; day: light scheme; bats: the Tiny Dungeon sheet once loaded (or null).
  function draw(g, W, H, t, day, bats) {
    var c = day ? LOOK.day : LOOK.night, hz = Math.round(H * 0.74), i, x, y;
    function R(col, x, y, w, h) { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w || 1, h || 1); }
    function disc(col, cx, cy, r) { for (var dy = -r; dy <= r; dy++) { var w = Math.round(Math.sqrt(r * r - dy * dy)); R(col, cx - w, cy + dy, 2 * w, 1); } }
    for (i = 0; i < 6; i++) R(c.sky[i], 0, Math.floor(hz * i / 6), W, Math.ceil(hz / 6) + 1); // sky in six flat bands
    R(c.sky[5], 0, hz, W, H - hz);
    if (!day) {
      for (i = 0; i < 110; i++) { // stars: each blinks off now and then, every eleventh is a cross
        if ((Math.floor(t / 500) + i * 3) % 9 === 0) continue;
        x = noise(i, 1) * W; y = noise(i, 2) * hz * 0.92;
        R(i % 4 ? '#b9a8e6' : '#fff3b0', x, y);
        if (i % 11 === 0) { R('#fff3b0', x - 1, y, 3, 1); R('#fff3b0', x, y - 1, 1, 3); }
      }
      var k = Math.floor(t / 7000), f = t % 7000 / 600; // a shooting star every 7 s
      if (f < 1) for (i = 0; i < 7; i++) R(i ? 'rgba(255,243,176,' + (0.8 - i * 0.11) + ')' : '#ffffff', noise(k, 5) * W * 0.8 + f * 70 - i * 2, noise(k, 6) * hz * 0.4 + f * 30 - i);
    }
    var mx = Math.round(W * 0.84), my = Math.round(H * 0.17); // moon or sun, with a halo
    disc(day ? 'rgba(255,230,128,.3)' : 'rgba(244,234,213,.1)', mx, my, 19); disc(c.orb, mx, my, 13);
    disc(c.spot, mx - 4, my - 3, 3); disc(c.spot, mx + 5, my + 4, 2); disc(c.spot, mx + 2, my - 7, 1);
    for (i = 0; i < 6; i++) { // clouds drift right and come round again
      x = (noise(i, 7) * (W + 80) + t * (0.002 + 0.0015 * (i % 3))) % (W + 80) - 40; y = (0.08 + noise(i, 8) * 0.42) * hz;
      R(c.cloud, x, y, 30, 4); R(c.cloud, x + 6, y - 3, 16, 3); R(c.cloud, x - 5, y + 4, 24, 2);
    }
    for (x = 0; x < W; x++) { // two ridges of hills
      R(c.far, x, hz - 16 - 12 * Math.sin(x * 0.031 + 1) - 7 * Math.sin(x * 0.083) - 3 * Math.sin(x * 0.2), 1, H);
      R(c.near, x, hz + 6 - 9 * Math.sin(x * 0.022 + 4) - 4 * Math.sin(x * 0.11 + 2), 1, H);
    }
    [3, W - 31].forEach(function (tx, n) { // a guild tower at each edge: battlements, brick lines, flickering windows, a flag
      var ty = Math.round(H * 0.3);
      R(c.wall, tx, ty, 28, H); R(c.edge, tx, ty, 2, H);
      for (i = 0; i < 4; i++) R(c.wall, tx - 1 + i * 8, ty - 5, 6, 5);
      for (y = ty + 9; y < H; y += 9) for (x = (y / 9 | 0) % 2 * 5; x < 26; x += 10) R(c.edge, tx + 2 + x, y, 4, 1);
      for (i = 0; i < 4; i++) { y = ty + 14 + i * 26; R(c.lit[(Math.floor(t / 260) + i * 5 + n * 3) % 5 ? 0 : 1], tx + 11, y, 6, 9); R(c.wall, tx + 13, y, 2, 9); R(c.wall, tx + 11, y + 4, 6, 1); }
      R(c.edge, tx + 13, ty - 19, 1, 14);
      var wv = Math.floor(t / 300 + n) % 2; R(c.flag, tx + 14, ty - 19, 9, 3); R(c.flag, tx + 14, ty - 16 + wv, 7 - wv * 2, 2 + wv);
    });
    for (i = 0; i < 5; i++) { // night: bats cross the sky, every other one the opposite way; day: birds
      var sp = 0.012 + 0.006 * (i % 3), bx = (noise(i, 11) * (W + 40) + t * sp) % (W + 40) - 20, by = (0.12 + noise(i, 12) * 0.5) * hz + Math.sin(t / 380 + i * 2) * 5;
      if (i % 2) bx = W - bx;
      if (day) { var up = Math.floor(t / 220 + i) % 2; R('#2b1d14', bx, by + up, 3, 1); R('#2b1d14', bx + 3, by + 1 - up, 1, 1); R('#2b1d14', bx + 4, by + up, 3, 1); }
      else if (bats) g.drawImage(bats, BAT % 12 * 16, (BAT / 12 | 0) * 16, 16, 16, Math.round(bx), Math.round(by + (Math.floor(t / 160 + i) % 2)), 16, 16);
    }
    if (!day) {
      if (bats) { g.globalAlpha = 0.55; g.drawImage(bats, GHOST % 12 * 16, (GHOST / 12 | 0) * 16, 16, 16, W - 52 + Math.round(Math.sin(t / 2600) * 6), Math.round(H * 0.42 + Math.sin(t / 900) * 5), 16, 16); g.globalAlpha = 1; } // the tower's ghost
      for (i = 0; i < 18; i++) { // fireflies rise from the hills
        var a = (noise(i, 13) + t * 0.00004 * (1 + i % 4)) % 1;
        R('rgba(255,210,63,' + (0.9 - a * 0.9).toFixed(2) + ')', noise(i, 14) * W + Math.sin(t / 700 + i) * 4, H - a * H * 0.45);
      }
    }
  }

  function start(canvas, sheet) {
    var g = canvas.getContext('2d'), last = -1e9, light = root.matchMedia('(prefers-color-scheme: light)'), calm = root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function paint(t) {
      var W = Math.ceil(root.innerWidth / PX), H = Math.ceil(root.innerHeight / PX);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      g.imageSmoothingEnabled = false;
      draw(g, W, H, t, light.matches && document.documentElement.dataset.theme !== 'dark', sheet && sheet.complete && sheet.naturalWidth ? sheet : null);
    }
    function frame(t) { // reduced motion: one still picture, repainted only when the window changes
      if (!calm) root.requestAnimationFrame(frame);
      if (t - last >= 90 && document.visibilityState === 'visible') { last = t; paint(calm ? 0 : t); }
    }
    root.addEventListener('resize', function () { paint(calm ? 0 : last); });
    if (sheet && !sheet.complete) sheet.addEventListener('load', function () { paint(calm ? 0 : last < 0 ? 0 : last); });
    root.requestAnimationFrame(frame);
  }

  var Sky = { draw: draw, start: start };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sky;
  root.Sky = Sky;
})(typeof window !== 'undefined' ? window : this);
