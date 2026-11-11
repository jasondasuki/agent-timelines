"""python -m pytest tests  (or: python tests/test_cli.py). Install/uninstall keep other hooks and replace old ones."""
import argparse, http.client, io, json, os, re, sys, tempfile, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from agent_timelines import cli


def test_install_uninstall():
    d = tempfile.mkdtemp()
    p = os.path.join(d, "settings.json")
    other = {"type": "command", "command": "echo keep"}
    old = {"type": "command", "command": "python3 $HOME/.claude/helpers/agent-timeline.py x"}
    json.dump({"model": "opus", "hooks": {"Stop": [{"hooks": [other, old]}], "PostToolUse": [{"matcher": "*", "hooks": [old]}]}}, open(p, "w"))
    cli.main(["install", "--settings", p])
    cli.main(["install", "--settings", p])  # idempotent
    h = json.load(open(p))["hooks"]
    cmds = [x["command"] for ev in h.values() for g in ev for x in g["hooks"]]
    assert sum(cli.MARK in c for c in cmds) == len(cli.EVENTS) and "echo keep" in cmds and not any(cli.OLD in c for c in cmds), cmds
    assert any(g.get("matcher") == "*" for g in h["PostToolUse"])
    cli.main(["uninstall", "--settings", p])
    s = json.load(open(p))
    assert s["model"] == "opus" and s["hooks"] == {"Stop": [{"hooks": [other]}]}, s


ROOT = os.path.join(os.path.dirname(__file__), "..")


def test_plugin_files():
    j = lambda *p: json.load(open(os.path.join(ROOT, *p)))
    plugin, market, hooks = j(".claude-plugin", "plugin.json"), j(".claude-plugin", "marketplace.json"), j("hooks", "hooks.json")["hooks"]
    ver = re.search(r'^version = "([^"]+)"', open(os.path.join(ROOT, "pyproject.toml")).read(), re.M).group(1)
    assert plugin["version"] == ver and plugin["name"] == market["plugins"][0]["name"], (plugin, ver)
    assert re.match(r"\d+\.\d+\.\d+", cli.version()), cli.version()  # installed: the package's; from the source tree: the plugin manifest's
    assert set(hooks) == set(cli.EVENTS), hooks.keys()
    for ev, groups in hooks.items():
        for h in groups[0]["hooks"]:
            assert "agent_timelines hook --via plugin" in h["command"] and '"${CLAUDE_PLUGIN_ROOT}' in h["command"], h


def test_hook_via_plugin():
    from agent_timelines import timeline as tl
    d = tempfile.mkdtemp()
    calls, keep = [], (tl.CLAUDE_DIR, tl.OUT_DIR, cli.detach, sys.stdin)
    ev = json.dumps({"session_id": "s1", "transcript_path": "/x/s1.jsonl", "hook_event_name": "Stop"})

    def run(*argv):
        sys.stdin = io.StringIO(ev)
        cli.main(["hook", *argv])
    try:
        tl.CLAUDE_DIR, tl.OUT_DIR, cli.detach = d, os.path.join(d, "out"), lambda *a: calls.append(a)
        run("--via", "plugin")
        assert len(calls) == 1, calls  # no settings.json: go on
        open(os.path.join(d, "settings.json"), "w").write(json.dumps({"hooks": {"Stop": [{"hooks": [{"command": "python3 -m " + cli.MARK}]}]}}))
        run("--via", "plugin")
        assert len(calls) == 1, calls  # install hooks present: the plugin stays quiet
        run()
        assert len(calls) == 2, calls  # without --via it always builds
    finally:
        tl.CLAUDE_DIR, tl.OUT_DIR, cli.detach, sys.stdin = keep


def test_build_keeps_both_closed_ids():
    """Two SubagentStop builds of one session at the same moment: neither loses the other's closed agent."""
    from agent_timelines import timeline as tl
    d = tempfile.mkdtemp()
    tp = os.path.join(d, "race1.jsonl")
    open(tp, "w").write(json.dumps({"type": "user", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": "hi"}}) + "\n")
    keep, load = tl.OUT_DIR, tl.load

    def slow(*a, **k):  # wide enough that, unlocked, both builds read the closed list before either writes it
        time.sleep(0.2)
        return load(*a, **k)
    try:
        tl.OUT_DIR, tl.load = os.path.join(d, "out"), slow
        ts = [threading.Thread(target=cli.build, args=(argparse.Namespace(transcript=tp, event="SubagentStop", closed=x, recheck=0),)) for x in "AB"]
        [t.start() for t in ts]
        [t.join() for t in ts]
        assert tl.closed_ids(tl.OUT_DIR, "race1") == {"A", "B"}, tl.closed_ids(tl.OUT_DIR, "race1")
    finally:
        tl.OUT_DIR, tl.load = keep, load


def test_rebuild_and_achievements():
    """rebuild fills achievements.js (once per session, however often it runs) and `achievements` lists it."""
    from datetime import datetime, timezone
    from agent_timelines import timeline as tl
    d = tempfile.mkdtemp()
    pd = os.path.join(d, "projects", "p")
    os.makedirs(os.path.join(pd, "r1", "subagents"))
    t0 = time.time() - 120
    ts = lambda sec: datetime.fromtimestamp(t0 + sec, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    line = lambda sec, msg: json.dumps({"type": "assistant", "timestamp": ts(sec), "cwd": "/w", "message": msg}) + "\n"
    spawn = {"id": "m1", "model": "claude-opus-5", "content": [{"type": "tool_use", "id": "s0", "name": "Agent", "input": {"subagent_type": "general-purpose", "model": "opus", "effort": "high"}}]}
    open(os.path.join(pd, "r1.jsonl"), "w").write(line(0, spawn) + line(20, {"id": "m2", "stop_reason": "end_turn", "model": "claude-opus-5", "content": [{"type": "text", "text": "ok"}]}))
    json.dump({"agentType": "general-purpose", "toolUseId": "s0", "description": "d"}, open(os.path.join(pd, "r1", "subagents", "agent-a0.meta.json"), "w"))
    open(os.path.join(pd, "r1", "subagents", "agent-a0.jsonl"), "w").write(line(10, {"id": "f", "stop_reason": "end_turn", "model": "claude-opus-5", "content": [{"type": "text", "text": "done"}]}))
    keep = (tl.PROJECTS, tl.OUT_DIR)
    out = io.StringIO()
    try:
        tl.PROJECTS, tl.OUT_DIR = os.path.join(d, "projects"), os.path.join(d, "out")
        for _ in range(2):
            cli.main(["rebuild"])
        sv = tl.read_save(os.path.join(tl.OUT_DIR, tl.SAVE))
        assert "first" in sv["unlocked"] and tl.totals(sv)["sessions"] == 1 and tl.totals(sv)["heroes"] == 1, sv
        assert re.search(r'"badges": ?\["first"\]', open(os.path.join(tl.OUT_DIR, "r1.data.js")).read())
        old, sys.stdout = sys.stdout, out
        try:
            cli.main(["achievements"])
        finally:
            sys.stdout = old
    finally:
        tl.PROJECTS, tl.OUT_DIR = keep
    lines = out.getvalue().splitlines()
    assert len(lines) == len(tl.ACHIEVEMENTS) + 3 and lines[-3].startswith("Guild level %d, " % tl.level_of(sv)["n"]) and lines[-2].startswith("Quests today ") and lines[-2].count("[") == 3 and lines[0].startswith("[x] First Blood") and lines[1].startswith("[ ] Full Party"), out.getvalue()
    assert lines[-1].startswith("1/%d unlocked" % len(tl.ACHIEVEMENTS)) and "1 heroes" in lines[-1], lines[-1]


def test_serve_refuses_cross_site():
    d = tempfile.mkdtemp()
    open(os.path.join(d, "index.data.js"), "w").write("TL({});\n")
    srv = cli.make_server(0, d)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    me = "127.0.0.1:%d" % port

    def get(headers):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request("GET", "/index.data.js", headers=headers)
        r = c.getresponse()
        r.read()
        c.close()
        return r.status, r.getheader("Cross-Origin-Resource-Policy")

    try:
        assert get({}) == (200, "same-origin")
        assert get({"Sec-Fetch-Site": "same-origin", "Referer": "http://%s/index.html" % me})[0] == 200
        assert get({"Sec-Fetch-Site": "none"})[0] == 200
        assert get({"Host": "localhost:%d" % port})[0] == 200
        assert get({"Sec-Fetch-Site": "cross-site"})[0] == 403
        assert get({"Sec-Fetch-Site": "same-site"})[0] == 403
        assert get({"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})[0] == 200, "opening the page from a link"
        assert get({"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script"})[0] == 403
        assert get({"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"})[0] == 403
        assert get({"Host": "evil.example:%d" % port, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})[0] == 403
        assert get({"Host": "evil.example:%d" % port})[0] == 403
        assert get({"Referer": "https://evil.example/"})[0] == 403
    finally:
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    test_install_uninstall()
    test_plugin_files()
    test_hook_via_plugin()
    test_build_keeps_both_closed_ids()
    test_rebuild_and_achievements()
    test_serve_refuses_cross_site()
    print("ok")
