/* Pure helpers for the lobby list: search, project filter, paging, totals. Plain ES5; window.Lobby, and module.exports for Node.
 * Rows are the lobby rows of index.data.js (no prompt or reply text, so search covers cwd, id, planner and last event only). */
(function (root) {
  'use strict';
  function s(x) { return x == null ? '' : String(x); }
  function parts(cwd) { return s(cwd).split('/').filter(Boolean); }

  // Rows in proj (when set) whose cwd + id + planner + last text contain every space-separated word of q, case-insensitive.
  function filter(rows, q, proj) {
    var words = s(q).toLowerCase().split(/\s+/).filter(Boolean);
    return (rows || []).filter(function (r) {
      if (proj && s(r.cwd) !== proj) return false;
      var hay = [r.cwd, r.id, r.planner, r.last].map(s).join('\n').toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }

  // [{cwd, name, n}] newest first. name = last path part; two cwds with the same last part get their parent folder added: "api (work)".
  function projects(rows) {
    var by = {}, list = [];
    (rows || []).forEach(function (r) {
      var c = s(r.cwd);
      if (!c) return;
      if (!by[c]) { by[c] = { cwd: c, name: parts(c).pop() || '/', n: 0, t: -Infinity }; list.push(by[c]); }
      by[c].n++;
      by[c].t = Math.max(by[c].t, +r.updated || 0);
    });
    var seen = {};
    list.forEach(function (p) { seen[p.name] = (seen[p.name] || 0) + 1; });
    list.forEach(function (p) { if (seen[p.name] > 1) p.name += ' (' + (parts(p.cwd).slice(-2, -1)[0] || p.cwd) + ')'; });
    list.sort(function (a, b) { return b.t - a.t; });  // stable in modern engines: equal times keep first-seen order
    return list.map(function (p) { return { cwd: p.cwd, name: p.name, n: p.n }; });
  }

  // One page of list; page is 0-based and clamped, so a list that shrank never leaves you on an empty page.
  function page(list, pg, size) {
    list = list || [];
    size = size > 0 ? Math.floor(size) : 1;
    var pages = Math.max(1, Math.ceil(list.length / size)), p = Math.max(0, Math.min(pages - 1, Math.floor(+pg) || 0));
    return { items: list.slice(p * size, p * size + size), page: p, pages: pages };
  }

  // Sums over rows for the ledger. days = the 7 local calendar days ending today (now, in seconds), oldest first;
  // top = the 5 costliest projects. shortcut: a session's whole cost lands on the day of its last activity
  // (rows carry no per-day split); upgrade if sessions that run past midnight skew the days.
  function totals(rows, now) {
    var d0 = new Date(now * 1000), days = [], cost = {}, t = { n: 0, heroes: 0, issues: 0, usd: 0, today: 0, week: 0 }, i;
    d0.setHours(0, 0, 0, 0);
    for (i = 6; i >= 0; i--) { var d = new Date(d0); d.setDate(d0.getDate() - i); days.push({ t: d / 1000, usd: 0, n: 0 }); } // setDate keeps local midnight across DST
    (rows || []).forEach(function (r) {
      var u = +r.usd || 0;
      t.n++; t.heroes += +r.heroes || 0; t.issues += +r.issues || 0; t.usd += u;
      cost[s(r.cwd)] = (cost[s(r.cwd)] || 0) + u;
      for (i = 6; i >= 0; i--) if (+r.updated >= days[i].t) { days[i].usd += u; days[i].n++; break; }
    });
    days.forEach(function (d) { t.week += d.usd; });
    t.today = days[6].usd; t.days = days;
    t.top = projects(rows).map(function (p) { return { cwd: p.cwd, name: p.name, n: p.n, usd: cost[p.cwd] }; })
      .sort(function (a, b) { return b.usd - a.usd; }).slice(0, 5);
    return t;
  }

  var Lobby = { filter: filter, projects: projects, page: page, totals: totals };
  if (typeof module !== 'undefined' && module.exports) module.exports = Lobby;
  root.Lobby = Lobby;
})(typeof window !== 'undefined' ? window : this);
