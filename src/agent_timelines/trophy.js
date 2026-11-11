/* Pure helpers for the trophy room: the achievements.js save file in, rows and toasts out. Plain ES5; window.Trophy, and module.exports for Node.
 * save = {list: [[id, name, description]], unlocked: {id: {t, sid}}, totals: {heroes, sessions, usd, streak}, level: {n, title, xp, lo, hi},
 * qlist: [[id, name, description]], quests: {"YYYY-MM-DD": [ids done]}}; every field may be missing or wrong
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
  // The guild level the file carries: {n, title, xp, hi, pct}, pct = how far through the current level (0-100); null when the file has none (an older save).
  function level(save) {
    var l = obj(obj(save).level), n = Math.floor(+l.n), xp = +l.xp, lo = +l.lo, hi = +l.hi;
    if (!(n >= 1) || !str(l.title) || !(xp >= 0) || !(lo >= 0) || !(hi > lo)) return null;
    return { n: n, title: l.title, xp: xp, hi: hi, pct: Math.max(0, Math.min(100, Math.round((xp - lo) * 100 / (hi - lo)))) };
  }
  // The toast text for a level this browser has not seen (seen = the last level it showed; level 1 is where everyone starts, so it is never news).
  function levelUp(save, seen) {
    var l = level(save);
    return l && l.n > Math.max(1, +seen || 0) ? 'GUILD LEVEL ' + l.n + ': ' + l.title.toUpperCase() : '';
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  // Today's three quests, [{id, name, desc, done, key}], for the local day of d: the same window on qlist that quests_for() in timeline.py takes
  // (719163 = Python's date.toordinal() of 1970-01-01). key ("day:id") is what the viewer remembers as seen. A file without a sound qlist has no quests.
  function quests(save, d) {
    var s = obj(save), l = Array.isArray(s.qlist) ? s.qlist : [], day = dayKey(d), won = obj(s.quests)[day], out = [], k, r;
    var o = (Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5) + 719163) * 3;
    if (l.length < 3 || !l.every(function (x) { return Array.isArray(x) && str(x[0]); })) return [];
    won = Array.isArray(won) ? won : [];
    for (k = 0; k < 3; k++) { r = l[(o + k) % l.length]; out.push({ id: r[0], name: String(r[1]), desc: String(r[2]), done: won.indexOf(r[0]) >= 0, key: day + ':' + r[0] }); }
    return out;
  }
  // The toast text for today's finished quests whose key is not in seen.
  function questToast(qs, seen) {
    seen = Array.isArray(seen) ? seen : [];
    var n = qs.filter(function (q) { return q.done && seen.indexOf(q.key) < 0; }).map(function (q) { return q.name; });
    return n.length ? (n.length === 1 ? 'QUEST DONE: ' : 'QUESTS DONE: ') + n.join(', ') : '';
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

  var Trophy = { rows: rows, count: count, totals: totals, level: level, levelUp: levelUp, quests: quests, questToast: questToast, parseSeen: parseSeen, fresh: fresh, pick: pick, toast: toast };
  if (typeof module !== 'undefined' && module.exports) module.exports = Trophy;
  root.Trophy = Trophy;
})(typeof window !== 'undefined' ? window : this);
