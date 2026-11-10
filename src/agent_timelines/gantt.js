/* Pure layout for the timeline (Gantt) view: one row per node in tree order, one bar per node on a shared time axis. Plain ES5;
 * window.Gantt, and module.exports for Node. The viewer draws the result; it applies a minimum bar width in CSS, not here.
 * shortcut: a session with a long idle gap squeezes its bars into the two ends; zoom is the answer for now, gap compression is the upgrade. */
(function (root) {
  'use strict';
  var STEPS = [10, 30, 60, 300, 600, 1800, 3600, 7200, 21600, 86400];  // tick spacing in seconds
  var MAXTICKS = 8;
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }

  function ticks(t0, t1, x) {
    var span = t1 - t0, step = STEPS[STEPS.length - 1];
    for (var i = 0; i < STEPS.length; i++) { if (Math.floor(span / STEPS[i]) + 1 <= MAXTICKS) { step = STEPS[i]; break; } }
    if (Math.floor(span / step) + 1 > MAXTICKS) step = 86400 * Math.ceil(span / 86400 / MAXTICKS);  // longer than 8 days: whole days
    var off = -new Date(t0 * 1000).getTimezoneOffset() * 60, out = [];  // ticks fall on local clock multiples of step
    for (var t = Math.ceil((t0 + off) / step) * step - off; t <= t1; t += step) {
      var d = new Date(t * 1000);
      out.push({ x: x(t), label: step >= 86400 ? p2(d.getMonth() + 1) + '-' + p2(d.getDate()) : p2(d.getHours()) + ':' + p2(d.getMinutes()) + (step < 60 ? ':' + p2(d.getSeconds()) : '') });
    }
    return out;
  }

  // nodes: main first, each {id, parent, start, end, running}. t0 / t1 (optional) only widen the range: the caller passes "now" for a live session.
  // Returns {t0, t1, rows: [{id, depth, x, w}], ticks: [{x, label}]}; x and w are fractions of the range, 0..1.
  function layout(nodes, t0, t1) {
    nodes = nodes || [];
    var starts = nodes.map(function (n) { return n.start; }).filter(num), ends = nodes.map(function (n) { return n.end; }).filter(num).concat(starts);
    var lo = Math.min.apply(null, starts.concat(num(t0) ? [t0] : [])), hi = Math.max.apply(null, ends.concat(num(t1) ? [t1] : []));
    if (!isFinite(lo)) lo = isFinite(hi) ? hi : 0;
    if (!isFinite(hi) || hi <= lo) hi = lo + 1;
    var span = hi - lo, fx = function (t) { return clamp((t - lo) / span, 0, 1); };
    var by = {}, kids = {}, rows = [], seen = {};
    nodes.forEach(function (n) { by[n.id] = n; });
    var rootId = nodes.length ? nodes[0].id : null;
    nodes.slice(1).forEach(function (n) {  // an unknown (or self) parent hangs the node under main
      var p = by[n.parent] && n.parent !== n.id ? n.parent : rootId;
      (kids[p] = kids[p] || []).push(n);
    });
    function bar(n, depth) {
      var x = 1, w = 0;
      if (num(n.start)) {
        var e = num(n.end) ? n.end : n.running ? hi : n.start;
        x = fx(n.start); w = Math.max(0, fx(e) - x);
      }
      rows.push({ id: n.id, depth: depth, x: x, w: w });
    }
    function walk(n, depth) {
      if (seen[n.id]) return;
      seen[n.id] = 1;
      bar(n, depth);
      (kids[n.id] || []).sort(function (a, b) { return (num(a.start) ? a.start : Infinity) - (num(b.start) ? b.start : Infinity) || 0; })
        .forEach(function (k) { walk(k, depth + 1); });
    }
    if (nodes.length) walk(nodes[0], 0);
    nodes.forEach(function (n) { walk(n, 1); });  // a parent cycle is unreachable from main: still shown once, under it
    return { t0: lo, t1: hi, rows: rows, ticks: ticks(lo, hi, fx) };
  }

  var Gantt = { layout: layout };
  if (typeof module !== 'undefined' && module.exports) module.exports = Gantt;
  root.Gantt = Gantt;
})(typeof window !== 'undefined' ? window : this);
