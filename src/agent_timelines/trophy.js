/* Pure helpers for the trophy room: the achievements.js save file in, rows and toasts out. Plain ES5; window.Trophy, and module.exports for Node.
 * save = {list: [[id, name, description]], unlocked: {id: {t, sid}}, totals: {heroes, sessions, usd, streak}}; every field may be missing or wrong
 * (an old or hand-edited file), and then reads as nothing unlocked. The names and conditions come from the file, so a new rule needs no viewer change. */
(function (root) {
  'use strict';
  function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
  function str(x) { return typeof x === 'string'; }

  // [{id, name, desc, got, t, sid}] in the file's order; t is the unlock time (s) and sid the session that earned it.
  function rows(save) {
    var s = obj(save), u = obj(s.unlocked);
    return (Array.isArray(s.list) ? s.list : []).filter(function (r) { return Array.isArray(r) && str(r[0]); }).map(function (r) {
      var k = u[r[0]], got = !!k && typeof k === 'object';
      return { id: r[0], name: String(r[1]), desc: String(r[2]), got: got, t: got ? +k.t || 0 : 0, sid: got && str(k.sid) ? k.sid : '' };
    });
  }
  function count(save) { var r = rows(save); return { got: r.filter(function (x) { return x.got; }).length, all: r.length }; }
  function totals(save) {
    var t = obj(obj(save).totals);
    return { heroes: +t.heroes || 0, sessions: +t.sessions || 0, usd: +t.usd || 0, streak: +t.streak || 0 };
  }
  function parseSeen(text) { try { var a = JSON.parse(text); return Array.isArray(a) ? a.filter(str) : []; } catch (e) { return []; } }
  // Unlocked rows whose id is not in seen, oldest first (equal times keep the file's order).
  function fresh(save, seen) {
    seen = Array.isArray(seen) ? seen : [];
    return rows(save).filter(function (r) { return r.got && seen.indexOf(r.id) < 0; }).sort(function (a, b) { return a.t - b.t; });
  }
  // The rows for some ids (a session's badges), in that order; ids the file does not know are skipped.
  function pick(save, ids) {
    var by = {};
    rows(save).forEach(function (r) { by[r.id] = r; });
    return (Array.isArray(ids) ? ids : []).filter(function (i) { return by[i]; }).map(function (i) { return by[i]; });
  }
  // The toast text for new rows: names for up to 3, else a count.
  function toast(rs) {
    if (!rs.length) return '';
    if (rs.length > 3) return rs.length + ' NEW TROPHIES';
    return (rs.length === 1 ? 'NEW TROPHY: ' : 'NEW TROPHIES: ') + rs.map(function (r) { return r.name; }).join(', ');
  }

  var Trophy = { rows: rows, count: count, totals: totals, parseSeen: parseSeen, fresh: fresh, pick: pick, toast: toast };
  if (typeof module !== 'undefined' && module.exports) module.exports = Trophy;
  root.Trophy = Trophy;
})(typeof window !== 'undefined' ? window : this);
