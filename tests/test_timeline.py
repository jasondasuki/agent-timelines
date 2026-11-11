"""python3 tests/test_timeline.py (or pytest). Builds fake transcripts in a temp dir; never reads your real ~/.claude."""
import copy, json, os, sys, tempfile, threading, time
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from agent_timelines import timeline as tl

DEFAULT_PRICES = copy.deepcopy(tl.PRICES)  # load_config mutates the table; setup() puts it back

T = lambda sec: "2026-01-01T00:%02d:%02d.000Z" % (sec // 60, sec % 60)
wr = lambda p, ls: open(p, "w").write("\n".join(json.dumps(x) if not isinstance(x, str) else x for x in ls) + "\n")
use = lambda i, name, inp, sec: {"type": "assistant", "timestamp": T(sec), "cwd": "/w", "effort": "high", "message": {
    "id": "m" + i, "model": "claude-opus-5", "usage": {"input_tokens": 10, "output_tokens": 5}, "content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]}}
fin = lambda i, sec, model="claude-sonnet-5", effort="high": {"type": "assistant", "timestamp": T(sec), "effort": effort, "message": {
    "id": "f" + i, "stop_reason": "end_turn", "model": model, "content": [{"type": "text", "text": "done"}]}}
meta = lambda tid, **k: dict({"agentType": "general-purpose", "toolUseId": tid, "description": "d"}, **k)
spawn = lambda tid, typ, sec, **k: use(tid, "Agent", dict({"subagent_type": typ}, **k), sec)
FULL = {"model": "opus", "effort": "high"}
unwrap = lambda p: json.loads((lambda t: t[t.index("(") + 1:-2])(open(p).read().strip()))
by = lambda d: {a["id"]: a for a in d["agents"]}


def setup():
    d = tempfile.mkdtemp()
    tl.HANDOVER_DIR, tl.AGENTS_DIR = os.path.join(d, "handovers"), os.path.join(d, "agents")
    os.makedirs(tl.HANDOVER_DIR)
    os.makedirs(tl.AGENTS_DIR)
    for name, model in (("pinme", "sonnet"), ("runner", "haiku")):
        open(os.path.join(tl.AGENTS_DIR, name + ".md"), "w").write("---\nname: %s\nmodel: %s\neffort: high\n---\nbody\nmodel: nope\n" % (name, model))
    tl.TOOL_LIMIT = 50  # pin the values the assertions were written for, whatever the defaults are
    tl.RULES.clear()
    tl.RULES.update({"no-model": True, "no-effort": True})
    tl.LOBBY_LIMIT = 200
    tl.PRICES.clear()
    tl.PRICES.update(copy.deepcopy(DEFAULT_PRICES))
    return d


def session(pd, sid, main, agents, wf=""):
    sd = os.path.join(pd, sid, "subagents", wf)
    os.makedirs(sd, exist_ok=True)
    wr(os.path.join(pd, sid + ".jsonl"), main)
    for aid, m, lines in agents:
        wr(os.path.join(sd, "agent-%s.meta.json" % aid), [m])
        if lines is not None:
            wr(os.path.join(sd, "agent-%s.jsonl" % aid), lines)
    return os.path.join(pd, sid + ".jsonl")


def test_tree_flags_running_and_files():
    d = setup()
    pd = os.path.join(d, "proj")
    p = session(pd, "sess1", [
        use("t1", "Agent", {"subagent_type": "general-purpose", "model": "sonnet", "effort": "high", "description": "<b>A</b>"}, 0),
        {"type": "user", "timestamp": T(1), "message": {"content": [{"type": "tool_result", "tool_use_id": "x", "content": [{"type": "text", "text": tl.DENY + ". Delegate"}]}]}},
        "not json",
        use("t2", "Agent", {"subagent_type": "general-purpose", "prompt": "Continue from the handoff in /h/x.md; read it first."}, 100)], [
        ("A", meta("t1", model="sonnet", effort="high", description="<b>A</b>"), [use("t3", "Agent", {"subagent_type": "Explore", "model": "haiku", "effort": "xhigh"}, 10),
            {"type": "assistant", "timestamp": T(60), "message": {"id": "z", "model": "claude-sonnet-5", "stop_reason": "end_turn", "content": [{"type": "text", "text": "HANDOFF /h/x.md"}]}}]),
        ("B", meta("t2"), [use("b1", "Bash", {}, 110), use("b1", "Bash", {}, 111), use("b2", "Bash", {}, 150), fin("b", 151)]),
        ("C", meta("t3", agentType="Explore", model="haiku", effort="xhigh"), [use("c1", "Read", {}, 20), use("c2", "Read", {}, 35), fin("c", 35)]),
        ("D", meta("t4", description="<i>D</i><script>x</script>"), [use("d1", "Read", {}, 200)]),  # unfinished: last line is a tool_use
        ("E", meta("t5", model="sonnet", effort="high"), None),  # just started: no transcript yet
        ("F", meta("t6", model="sonnet", effort="high"), [fin("f", 300, "azure_ai/gpt-6-luna", "max")])])  # gateway renamed the model
    s = tl.load(p)
    b = by(s)
    assert [a["id"] for a in s["agents"]] == ["A", "C", "B", "D", "F", "E"] and [a["n"] for a in s["agents"]] == [1, 2, 3, 4, 5, 6]
    assert b["C"]["parent"] == "A" and b["A"]["parent"] == b["B"]["parent"] == "main"
    assert b["B"]["cont"] == "A" and b["A"]["handoff"] == "/h/x.md"
    assert b["B"]["flags"] == ["no-model", "no-effort"], b["B"]["flags"]
    assert b["B"]["toolsBy"] == [["Bash", 2]] and b["C"]["toolsBy"] == [["Read", 2]] and s["toolsBy"] == [["Agent", 2]], "the duplicated b1 id counts once"
    assert b["A"]["reply"] == "HANDOFF /h/x.md" and b["B"]["reply"] == "done" and b["B"]["replyLen"] == 4 and s["reply"] == ""
    assert b["A"]["flags"] == ["model-mismatch", "handoff"], b["A"]["flags"]
    assert b["C"]["flags"] == ["model-mismatch", "effort-mismatch"], b["C"]["flags"]
    assert b["F"]["flags"] == ["model-mismatch", "effort-mismatch", "orphan"], b["F"]["flags"]
    assert [a["id"] for a in s["agents"] if a["running"]] == ["D", "E"]
    assert b["D"]["end"] == s["now"] and b["C"]["end"] - b["C"]["start"] == 15 and b["B"]["tools"] == 2
    assert [a["id"] for a in tl.load(p, closed=("D",))["agents"] if a["running"]] == ["E"], "SubagentStop beat the final flush"
    assert not any(a["running"] for a in tl.load(p, ended=True)["agents"]) and tl.load(p, ended=True)["status"] == "ended"
    assert s["denials"] == 1 and len(s["errors"]) == 1 and s["tools"] == 2 and s["tokens"] == 70 and s["peak"] == 10  # 2 turns of 10 in + 5 out
    assert s["status"] == "live" and s["planner"] == "opus-5/high" and s["pfam"] == "opus"
    assert b["F"]["req"] == "sonnet/high" and b["F"]["ran"] == "gpt-6-luna/max" and b["F"]["fam"] == "other" and b["E"]["ran"] == "sonnet?/high?"
    assert sum(s["models"].values()) == s["tokens"] + sum(a["tokens"] for a in s["agents"])
    txt = [e["text"] for e in s["events"]]
    assert "#1 → spawned #2 d · opus-5/high" in txt and "#2 d · done in 15s" in txt and "#1 <b>A</b> · handed off" in txt, txt
    assert "#3 d · continues #1" in txt and any(e["k"] == "guard" for e in s["events"]) and [e["t"] for e in s["events"]] == sorted(e["t"] for e in s["events"])
    os.utime(os.path.join(pd, "sess1", "subagents", "agent-D.jsonl"), (1, 1))
    assert not by(tl.load(p))["D"]["running"], "idle past STALE: dead, not running"
    # files: escaping, index of live sessions, retention
    od = os.path.join(d, "out")
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0).timestamp()
    assert tl.publish(s, od) == os.path.join(od, "index.html") + "?sid=sess1"
    raw = open(os.path.join(od, "sess1.data.js")).read()
    assert raw.startswith("TL(") and "</" not in raw and "<\\/script>" in raw, "script-context escaping"
    jd = unwrap(os.path.join(od, "sess1.data.js"))
    assert "<script>x</script>" in by(jd)["D"]["desc"] and jd["closed"] == [] and jd["updated"] == s["updated"]
    praw = open(os.path.join(od, "sess1.prompts.js")).read()
    pj = json.loads(praw.strip()[4:-2])
    assert praw.startswith("TLP(") and "</" not in praw and pj["id"] == "sess1"
    assert pj["prompts"] == {"B": b["B"]["prompt"]} and "Continue from the handoff" in pj["prompts"]["B"]
    assert "Continue from the handoff" not in raw and all(a["prompt"] == "" for a in jd["agents"]) and by(jd)["B"]["brief"] == len(b["B"]["prompt"])
    html = open(os.path.join(od, "index.html")).read()
    assert "innerHTML" not in html and "index.data.js" in html and 'src="lobby.js"' in html and 'src="gantt.js"' in html and 'src="sky.js"' in html and {"lobby.js", "gantt.js", "sky.js", "trophy.js"} <= set(tl.ASSETS) and 'src="trophy.js"' in html
    assert "prompts.js" in html and "TLP" in html and "replies" in pj and pj["replies"]["B"] == "done" and pj["replies"]["A"] == "HANDOFF /h/x.md"
    # a long multi-line final reply: teaser in the data file, full text in the prompts file, neither can close a script tag
    longr = "line one\n</script><b>x</b>\n" + "y" * 473
    assert len(longr) == 500
    long_fin = fin("l", 9, "claude-opus-5")
    long_fin["message"]["content"][0]["text"] = longr
    pl = session(pd, "sessL", [spawn("l1", "general-purpose", 0, **FULL)], [("L1", meta("l1"), [use("l2", "mcp__x__y", {}, 5), long_fin])])
    sl = tl.load(pl)
    tl.publish(sl, os.path.join(d, "outL"))
    ld, lp = (open(os.path.join(d, "outL", "sessL." + k + ".js")).read() for k in ("data", "prompts"))
    la = by(unwrap(os.path.join(d, "outL", "sessL.data.js")))["L1"]
    assert len(la["reply"]) <= 160 and "\n" not in la["reply"] and la["replyLen"] == 500 and la["toolsBy"] == [["mcp__x__y", 1]]
    assert json.loads(lp.strip()[4:-2])["replies"]["L1"] == longr and "</" not in ld and "</" not in lp
    side = lambda sid, **k: tl.write_atomic(os.path.join(od, sid + ".data.js"), "TL(%s);\n" % tl.js(dict({"id": sid, "status": "live", "updated": now - 5, "agents": [], "ctxLimit": 1}, **k)))
    tl.write_atomic(os.path.join(od, "sess1.data.js"), "TL(%s);\n" % tl.js(dict(s, updated=now - 10)))  # full data, still live
    side("liveB")
    side("endA", status="ended", updated=now - 100)
    side("staleC", updated=now - tl.LIVE_AGE - 1)
    tl.write_atomic(os.path.join(od, "oldD.data.js"), 'TL({"id": "oldD", "status": "live", "updated": %d, "agents": []});\n' % now)  # pre-package format
    open(os.path.join(od, "bad.data.js"), "w").write("TL({not json);\n")
    tl.build_index(od, now)
    rows = unwrap(os.path.join(od, "index.data.js"))["sessions"]
    assert [x["id"] for x in rows] == ["liveB", "sess1", "endA", "staleC"], "every readable session, newest first"
    assert [x["live"] for x in rows] == [True, True, False, False], "ended and stale sessions are not live"
    r1 = rows[1]
    want = sum(f not in tl.INFO_FLAGS and not f.startswith("ctx-") for a in s["agents"] for f in a["flags"]) + s["denials"]
    assert r1["heroes"] == 6 and r1["running"] == 2 and r1["issues"] == want == 13 and r1["gold"] == sum(s["models"].values()) and len(r1["party"]) == 6, r1
    assert r1["party"][3] == ["executor", None, True, False] and r1["last"] == s["events"][-1]["text"]
    assert "prompt" not in json.dumps(rows) and "reply" not in json.dumps(rows) and "<\\/" not in json.dumps(rows), "lobby rows carry no prompt or reply text"
    for f in ("old.data.js", "ancient.html", "gone.prompts.js"):
        open(os.path.join(od, f), "w").write("x")
        os.utime(os.path.join(od, f), (1, 1))
    os.utime(os.path.join(od, "liveB.data.js"), (1, 1))
    tl.purge(od, "liveB", now)
    assert sorted(os.listdir(od)) == sorted(tl.ASSETS + (".achievements.lock", "achievements.js", "bad.data.js", "endA.data.js", "index.data.js", "index.html", "liveB.data.js", "sess1.data.js", "sess1.prompts.js", "staleC.data.js", "oldD.data.js"))
    # SubagentHandback ends an agent; a later assistant line resumes it; SubagentStop/Start keep the closed list
    hb = [use("g1", "Read", {}, 10), use("hb1", "SubagentHandback", {"message": "x"}, 20),
          {"type": "user", "timestamp": T(21), "message": {"content": [{"type": "tool_result", "tool_use_id": "hb1", "content": "Report delivered."}]}}]
    p3 = session(pd, "sess3", [spawn("m1", "general-purpose", 0, model="sonnet", effort="high")], [("G", meta("m1"), hb)])
    assert not tl.load(p3)["agents"][0]["running"] and tl.load(p3)["agents"][0]["reply"] == "x"
    wr(os.path.join(pd, "sess3", "subagents", "agent-G.jsonl"), hb + [use("g2", "Read", {}, 30)])
    assert tl.load(p3)["agents"][0]["running"]
    od2 = os.path.join(d, "out2")
    for ev, aid, want in (("SubagentStop", "G", {"G"}), ("Stop", "G", {"G"}), ("SubagentStart", "X", {"G"}), ("SubagentStop", "H", {"G", "H"}), ("SubagentStart", "G", {"H"})):
        cl = tl.closed_ids(od2, "sess3", ev, aid)
        s3 = tl.load(p3, closed=cl)
        tl.publish(s3, od2, cl)
        assert tl.closed_ids(od2, "sess3") == want and s3["agents"][0]["running"] == ("G" not in want), (ev, aid)


def test_limits_tokens_tiers():
    d = setup()
    pd = os.path.join(d, "proj")
    msg = "HANDOFF: you have made 50 tool calls. Stop at your next milestone."
    att = lambda sec, typ="hook_additional_context", text=msg: {"type": "attachment", "timestamp": T(sec), "attachment": {"type": typ, "content": [text], "stdout": text}}
    work = lambda aid, n, extra=(): [use("%s-%d" % (aid, i), "Bash", {}, 10 + i) for i in range(n)][:50] + list(extra) + [
        use("%s-%d" % (aid, i), "Bash", {}, 10 + i) for i in range(50, n)] + [fin(aid, 10 + n, "claude-opus-5")]
    open(os.path.join(tl.HANDOVER_DIR, "2026-01-01-H2.md"), "w").write("x")
    open(os.path.join(tl.HANDOVER_DIR, "2026-01-01-H3.md"), "w").write("x")
    p = session(pd, "sess4", [spawn("q1", "general-purpose", 0, **FULL), spawn("q2", "general-purpose", 1, **FULL), spawn("q3", "general-purpose", 2, **FULL),
                              spawn("q4", "writer", 3, **FULL), spawn("q5", "general-purpose", 4), spawn("q6", "general-purpose", 5, **FULL),
                              spawn("q7", "general-purpose", 400, prompt="Continue from the handoff in %s/2026-01-01-H3.md; read it first." % tl.HANDOVER_DIR, **FULL)], [
        ("H1", meta("q1"), work("H1", 52, [att(60), att(60, "hook_success"), att(60, text="SOME OTHER HOOK OUTPUT")])),  # ignored the limit
        ("H2", meta("q2"), work("H2", 51, [att(60)])),  # handoff file, nobody continues
        ("H3", meta("q3"), work("H3", 51, [att(60)])),  # handoff file, K continues
        ("W", meta("q4", agentType="writer"), work("W", 51, [att(60)])),  # writers are exempt
        ("X", meta("q5", model="opus", effort="high"), work("X", 3)),  # meta has the values the spawn input lacks
        ("Y", meta("q6"), work("Y", 3)), ("K", meta("q7"), work("K", 3))])
    b = by(tl.load(p))
    assert b["H1"]["flags"] == ["tool-limit", "ignored-limit"] and b["H1"]["limit"] == 50, b["H1"]["flags"]
    assert b["H2"]["flags"] == ["handoff", "tool-limit", "handoff-not-continued"], b["H2"]["flags"]
    assert b["H3"]["flags"] == ["handoff", "tool-limit"] and b["K"]["cont"] == "H3" and b["K"]["flags"] == []
    assert b["W"]["flags"] == [] and b["W"]["limit"] is None and b["W"]["exempt"]
    assert b["X"]["flags"] == ["auto-filled"] and b["X"]["req"] == "opus/high" and b["Y"]["flags"] == []
    turn = lambda i, model, **u: {"type": "assistant", "timestamp": T(10), "effort": "high", "message": {"id": i, "stop_reason": "end_turn", "model": model, "usage": u, "content": []}}
    refusal = {"type": "user", "timestamp": T(3), "message": {"content": [{"type": "tool_result", "tool_use_id": "q0", "content": [{"type": "text", "text":
               "PreToolUse:Agent hook blocking error: Brief is 8001 chars (>8000): pass file paths"}]}]}}
    p5 = session(pd, "sess5", [spawn("p1", "pinme", 0), spawn("p2", "runner", 1), spawn("p3", "Plan", 2, **FULL), spawn("p4", "general-purpose", 4, prompt="x" * 900, **FULL), refusal], [
        ("P1", meta("p1", agentType="pinme"), [turn("a", "claude-sonnet-5", input_tokens=5, cache_creation_input_tokens=20000, cache_read_input_tokens=210000, output_tokens=7)]),
        ("P2", meta("p2", agentType="runner"), [turn("b", "claude-haiku-5", input_tokens=100, cache_read_input_tokens=1000, output_tokens=10)]),
        ("P3", meta("p3", agentType="Plan"), [fin("c", 10, "claude-opus-5")]), ("P4", meta("p4"), [fin("d", 10, "claude-opus-5")])])
    s = tl.load(p5)
    b = by(s)
    assert b["P1"]["flags"] == ["frontmatter", tl.CTX_FLAG] and b["P1"]["req"] == "sonnet/high" and b["P2"]["flags"] == ["frontmatter"]
    assert [b[i]["tier"] for i in ("P1", "P2", "P3", "P4")] == ["executor", "runner", "plan", "executor"]
    assert tl.pinned("../x") == {} and tl.pinned("nothing") == {}
    assert b["P1"]["peak"] == 230005 and b["P1"]["tokens"] == 5 + 25000 + 21000 + 35 and b["P4"]["brief"] == 900 and b["P4"]["prompt"] == "x" * 900
    assert s["modelTok"]["sonnet"]["cr"] == 210000 and sum(s["models"].values()) == s["tokens"] + sum(a["tokens"] for a in s["agents"])
    assert [e["text"] for e in s["events"] if e["k"] == "refused"] == ["brief refused: 8001 chars (>8000)"]
    assert [tl.family(m) for m in ("claude-fable-5-2", "claude-mythos-5-2", "azure_ai/gpt-6-luna", None)] == ["fable", "mythos", "other", "other"]
    pf = session(pd, "sessF", [fin("x", 1, "claude-fable-5-2")], [])
    sf = tl.load(pf)
    assert sf["pfam"] == "fable" and set(sf["models"]) == set(tl.FAMILIES) | {"other"}


def test_workflows_and_main_running():
    d = setup()
    pd = os.path.join(d, "proj")
    launch = lambda i, rid, name, sec: [use(i, "Workflow", {}, sec), {"type": "user", "timestamp": T(sec + 1), "toolUseResult": {
        "taskType": "local_workflow", "workflowName": name, "runId": rid, "summary": "sum " + name},
        "message": {"content": [{"type": "tool_result", "tool_use_id": i, "content": "Workflow launched."}]}}]
    main = launch("w1", "wf_done-1", "<script>x</script>wf", 0) + launch("w2", "wf_run-1", "live", 100) + launch("w3", "wf_lost-1", "lost", 200) + launch(
        "w1b", "wf_done-1", "resumed", 300) + [use("e1", "Workflow", {}, 400), {"type": "user", "timestamp": T(401), "toolUseResult": "Error: x",
                                                                                "message": {"content": [{"type": "tool_result", "tool_use_id": "e1", "content": "Error: x"}]}}]
    p = session(pd, "sess6", main, [])
    os.makedirs(os.path.join(pd, "sess6", "workflows"))
    wr(os.path.join(pd, "sess6", "workflows", "wf_done-1.json"), [{"timestamp": T(90), "status": "killed", "startTime": tl.ts(T(5)) * 1000, "summary": "S<b>",
        "workflowName": "wfn", "agentCount": 2, "totalToolCalls": 7, "error": "Error: aborted\n  at x", "phases": [{"title": "Hunt"}], "logs": ["log1"],
        "workflowProgress": [{"type": "workflow_agent", "state": "error"}, {"type": "workflow_agent", "state": "done"}]}])
    wm = lambda aid: {"agentType": "general-purpose", "description": "lbl-" + aid, "workflowPhase": "Hunt"}  # no model/effort: not flagged
    session(pd, "sess6", main, [("W1", wm("W1"), [{"type": "user", "timestamp": T(6), "message": {"content": "[Workflow harness — user request] go"}},
                                                {"type": "user", "timestamp": T(7), "message": {"content": "real task"}}, use("w1a", "Read", {}, 8), fin("w1", 80)])], "workflows/wf_done-1")
    session(pd, "sess6", main, [("W2", wm("W2"), [use("w2a", "Read", {}, 110)])], "workflows/wf_run-1")
    session(pd, "sess6", main, [("W3", wm("W3"), [use("w3a", "Read", {}, 210)])], "workflows/wf_lost-1")
    os.utime(os.path.join(pd, "sess6", "subagents", "workflows", "wf_lost-1", "agent-W3.jsonl"), (1, 1))
    s = tl.load(p)
    b = by(s)
    assert sorted(x for x in b if x.startswith("wf_")) == ["wf_done-1", "wf_lost-1", "wf_run-1"] and not s["errors"]
    assert [b[i]["wf"]["state"] for i in ("wf_done-1", "wf_run-1", "wf_lost-1")] == ["failed", "running", "failed"]
    w = b["wf_done-1"]
    assert w["wf"]["status"] == "killed" and w["tools"] == 7 and w["wf"]["states"] == {"error": 1, "done": 1} and w["start"] == tl.ts(T(5)) and w["end"] == tl.ts(T(90))
    assert b["wf_run-1"]["end"] == s["now"] and b["wf_lost-1"]["wf"]["status"] == "no result recorded" and w["parent"] == "main" and w["desc"] == "S<b>"
    assert b["W1"]["parent"] == "wf_done-1" and b["W1"]["flags"] == [] and b["W1"]["prompt"] == "real task" and b["W1"]["phase"] == "Hunt"
    assert b["W2"]["running"] and not b["W3"]["running"] and w["tokens"] == b["W1"]["tokens"] > 0
    assert w["toolsBy"] == b["W1"]["toolsBy"] == [["Read", 1]] and b["wf_run-1"]["toolsBy"] == [["Read", 1]] and w["reply"] == ""
    assert sorted(s["toolsBy"]) == [["Workflow", 5]], s["toolsBy"]
    assert sum(s["models"].values()) == s["tokens"] + sum(a["tokens"] for a in s["agents"] if a.get("kind") != "wf"), "workflow nodes add no tokens"
    ev = [e["text"] for e in s["events"] if e["k"] == "wf"]
    assert "workflow wfn failed (killed) after 1m25s" in ev and "planner → started workflow wfn" in ev and sum("live" in e for e in ev) == 1, ev
    # main session running: mid tool loop, after its final reply, on UserPromptSubmit/Stop, after an Esc interrupt, when idle past STALE
    mp = os.path.join(pd, "sess7.jsonl")
    mrun = lambda ls, **k: (wr(mp, ls), tl.load(mp, **k)["prun"])[1]
    assert mrun([use("m1", "Bash", {}, 1)]) and not mrun([use("m1", "Bash", {}, 1), fin("m", 2)])
    assert mrun([fin("m", 2)], event="UserPromptSubmit") and not mrun([use("m1", "Bash", {}, 1)], event="Stop") and not mrun([use("m1", "Bash", {}, 1)], ended=True)
    assert not mrun([use("m1", "Bash", {}, 1), {"type": "user", "timestamp": T(3), "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}}])
    os.utime(mp, (1, 1))
    assert not tl.load(mp)["prun"], "idle past STALE"


def test_lobby_limit():
    d = setup()
    od, now = os.path.join(d, "out"), 1e9
    os.makedirs(od)
    for i in range(35):
        tl.write_atomic(os.path.join(od, "s%02d.data.js" % i), "TL(%s);\n" % tl.js({"id": "s%02d" % i, "status": "ended", "updated": now - 100 - i, "agents": [], "ctxLimit": 1}))
    tl.build_index(od, now)
    rows = unwrap(os.path.join(od, "index.data.js"))["sessions"]
    assert len(rows) == 35 and rows[0]["id"] == "s00", "more than the old 30"
    tl.LOBBY_LIMIT = 10
    tl.build_index(od, now)
    rows = unwrap(os.path.join(od, "index.data.js"))["sessions"]
    assert [r["id"] for r in rows] == ["s%02d" % i for i in range(10)], "newest first, cut at the limit"
    cfg = os.path.join(d, "config.json")
    json.dump({"lobby_limit": 25}, open(cfg, "w"))
    tl.load_config(cfg)
    assert tl.LOBBY_LIMIT == 25


def test_cost():
    d = setup()
    pd = os.path.join(d, "proj")
    pr = tl.price_of
    assert pr("claude-opus-5-5")["in"] == 4 and pr("claude-opus-5")["in"] == 5 and pr("claude-opus-5-20261201")["in"] == 5
    assert pr("claude-opus-4-1-20250805")["in"] == 15 and pr("claude-opus-4-8")["in"] == 5 and pr("us.anthropic.claude-sonnet-4-5-20250929-v1:0")["in"] == 3
    assert pr("claude-fable-5-2")["out"] == 40 and pr("claude-fable-5")["cr"] == 1
    assert pr("azure_ai/gpt-6-luna") is None and pr("claude-3-5-sonnet-20241022") is None and pr(None) is None
    # one assistant turn; usage goes in as given
    turn = lambda i, model, sec=10, **u: {"type": "assistant", "timestamp": T(sec), "effort": "high", "message": {
        "id": i, "stop_reason": "end_turn", "model": model, "usage": u, "content": [{"type": "text", "text": "done"}]}}
    one = iter(range(99))
    usd = lambda model, **u: tl.load(session(pd, "c%d" % next(one), [turn("t", model, **u)], []))["usd"]
    near = lambda a, b: abs(a - b) < 1e-9
    assert near(usd("claude-fable-5-2", input_tokens=1000, cache_creation_input_tokens=3000, cache_read_input_tokens=100000, output_tokens=500,
                    cache_creation={"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 2000}), 0.09)
    assert near(usd("claude-haiku-5-5", input_tokens=100, cache_read_input_tokens=150000, output_tokens=10), 0.007575), "over 100k prompt tokens: 5x"
    assert near(usd("claude-haiku-5-5", input_tokens=100, cache_read_input_tokens=50000, output_tokens=10), 0.000515), "under the threshold"
    assert near(usd("claude-opus-5-5", input_tokens=1000, output_tokens=1000, speed="fast"), 0.048)
    assert near(usd("claude-opus-5-5", input_tokens=1000, output_tokens=1000), 0.024)
    assert near(usd("claude-opus-5", cache_creation_input_tokens=1000000), 6.25), "no cache_creation breakdown: all writes at the 5-minute rate"
    # a tree: planner + opus agent + workflow with a gateway-model agent; streamed duplicate lines count once
    dup = turn("dup", "claude-opus-5", input_tokens=1000000, output_tokens=0)
    p = session(pd, "sessC", [spawn("c1", "general-purpose", 0, **FULL), spawn("c2", "general-purpose", 1, **FULL), turn("pm", "claude-sonnet-5", input_tokens=1000000)], [
        ("C1", meta("c1"), [dup, dup]), ("C2", meta("c2"), [turn("g", "azure_ai/gpt-6-luna", input_tokens=500, output_tokens=5)])])
    s = tl.load(p)
    b = by(s)
    assert near(b["C1"]["usd"], 5) and not b["C1"]["unpriced"], "same message id on two lines: once"
    assert b["C2"]["usd"] == 0 and b["C2"]["unpriced"] and s["cost"]["unpriced"] == ["azure_ai/gpt-6-luna"]
    assert abs(s["usd"] - 2.00035) < 1e-9, "1M sonnet tokens + two 10-in/5-out spawn turns"  # opus-5: (10 * 5 + 5 * 25) / 1e6 each
    assert near(s["cost"]["total"], s["usd"] + sum(a["usd"] for a in s["agents"])) and near(s["cost"]["total"], 7.00035)
    assert [m["model"] for m in s["cost"]["models"]] == ["claude-opus-5", "claude-sonnet-5", "azure_ai/gpt-6-luna"], "most expensive first"
    assert s["cost"]["asof"] == tl.PRICES_ASOF and s["cost"]["models"][0]["fam"] == "opus" and s["cost"]["models"][0]["tok"]["in"] == 1000020  # the agent's 1M plus two spawn turns
    assert s["tokens"] == 1000070 and tl.summary(s, s["now"])["usd"] == s["cost"]["total"] and tl.summary({"updated": 1}, 2)["usd"] is None
    # a workflow adds no cost of its own, its node shows its agents' sum
    wm = {"agentType": "general-purpose", "description": "w", "workflowPhase": "P"}
    run = [use("w1", "Workflow", {}, 0), {"type": "user", "timestamp": T(1), "toolUseResult": {"taskType": "local_workflow", "workflowName": "n", "runId": "wf_c-1"},
                                          "message": {"content": [{"type": "tool_result", "tool_use_id": "w1", "content": "Workflow launched."}]}}]
    pw = session(pd, "sessW", run, [("W1", wm, [turn("a", "claude-opus-5", input_tokens=1000000)]), ("W2", wm, [turn("b", "claude-opus-5", input_tokens=2000000)])], "workflows/wf_c-1")
    sw = tl.load(pw)
    assert near(by(sw)["wf_c-1"]["usd"], 15) and near(sw["cost"]["total"], 15 + sw["usd"]), "the workflow node adds nothing on top of its agents"
    # config: prices merge per model; a bad entry exits
    cfg = os.path.join(d, "config.json")
    json.dump({"prices": {"gpt-6": {"in": 1, "out": 2}}}, open(cfg, "w"))
    tl.load_config(cfg)
    assert tl.PRICES["opus-5"]["in"] == 5 and near(tl.usd_of(tl.price_of("azure_ai/gpt-6-luna"), dict(zip(("in", "cc", "cr", "out"), (1000000, 0, 0, 500000))), 0, False), 2)
    assert tl.load(p)["cost"]["unpriced"] == [], "the gateway model is priced now"
    for bad in ({"x": {"input": 1}}, {"x": {"in": "1"}}, {"x": {"over": [1]}}, {"x": 3}, [1]):
        json.dump({"prices": bad}, open(cfg, "w"))
        try:
            tl.load_config(cfg)
            assert False, "bad prices must exit: %r" % bad
        except SystemExit:
            pass


def test_rules_and_config():
    d = setup()
    pd = os.path.join(d, "proj")
    p = session(pd, "sessR", [spawn("r1", "general-purpose", 0), spawn("r2", "general-purpose", 1, model="inherit", effort="high")], [
        ("R1", meta("r1"), [fin("r", 5)]), ("R2", meta("r2"), [fin("s", 6)])])
    b = by(tl.load(p))
    assert b["R1"]["flags"] == ["no-model", "no-effort"] and b["R2"]["flags"] == [], "inherit is not a mismatch"
    tl.RULES.update({"no-model": False, "no-effort": False})
    assert by(tl.load(p))["R1"]["flags"] == []
    cfg = os.path.join(d, "config.json")
    json.dump({"rules": {"no-model": True}, "tool_limit": 40}, open(cfg, "w"))
    tl.load_config(cfg)
    assert tl.RULES["no-model"] and not tl.RULES["no-effort"] and tl.TOOL_LIMIT == 40 and tl.load(p)["toolLimit"] == 40
    json.dump({"rules": {"nope": True}}, open(cfg, "w"))
    try:
        tl.load_config(cfg)
        assert False, "unknown rule must be an error"
    except SystemExit:
        pass


# one hero's transcript: a single opus-5 turn of `mtok` million input tokens at second `sec` = $5 per million
spend = lambda i, mtok, sec=10: {"type": "assistant", "timestamp": T(sec), "effort": "high", "message": {
    "id": i, "stop_reason": "end_turn", "model": "claude-opus-5", "usage": {"input_tokens": int(mtok * 1e6)}, "content": [{"type": "text", "text": "done"}]}}


def test_rank():
    d = setup()
    pd = os.path.join(d, "proj")
    party = lambda sid, costs: tl.load(session(pd, sid, [spawn("s%d" % i, "general-purpose", i, **FULL) for i in range(len(costs))], [
        ("H%d" % i, meta("s%d" % i), [spend("x%d" % i, c, 10 + i)]) for i, c in enumerate(costs)]))
    rank = lambda s: [a["rank"] for a in s["agents"]]
    assert rank(party("r1", [2, 1, 0.8])) == ["boss", "elite", None], "elite from half the boss's cost up"
    assert rank(party("r2", [1, 4, 2.0001])) == [None, "boss", "elite"] and rank(party("r3", [1, 1, 1])) == ["boss", "elite", "elite"], "ties: the earliest spawn is the boss"
    assert rank(party("r4", [5, 1])) == [None, None], "fewer than 3 heroes: no boss, so no elite either"
    assert rank(party("r5", [0, 0, 0])) == [None] * 3, "a boss must cost something"
    assert rank(party("r6", [1.5, 1, 3, 0.5])) == ["elite", None, "boss", None]
    assert all("rank" in a for a in party("r7", [1, 3, 1])["agents"])
    # workflow nodes carry no rank and do not count as heroes
    run = [use("w1", "Workflow", {}, 0), {"type": "user", "timestamp": T(1), "toolUseResult": {"taskType": "local_workflow", "workflowName": "n", "runId": "wf_r-1"},
                                          "message": {"content": [{"type": "tool_result", "tool_use_id": "w1", "content": "Workflow launched."}]}}]
    wm = {"agentType": "general-purpose", "description": "w", "workflowPhase": "P"}
    sw = tl.load(session(pd, "r8", run + [spawn("s0", "general-purpose", 2, **FULL), spawn("s1", "general-purpose", 3, **FULL)],
                         [("H0", meta("s0"), [spend("a", 1)]), ("H1", meta("s1"), [spend("b", 2)])], ""))
    assert [a.get("rank", "none") for a in sw["agents"] if a.get("kind") == "wf"] == ["none"] and [a["rank"] for a in sw["agents"] if a.get("kind") != "wf"] == [None, None]


def hero(i=0, **k):
    return dict({"id": "h%d" % i, "kind": None, "running": False, "tier": "executor", "flags": [], "tools": 3, "start": 100 * i, "end": 100 * i + 50, "cont": None,
                 "handoff": None, "rank": None, "usd": 0.1}, **k)


def sdata(agents, usd=1.0, **k):
    return dict({"id": "x", "updated": 1e6, "t0": 1e6 - 500, "prun": False, "agents": agents, "cost": {"total": usd, "unpriced": []}}, **k)


def test_achievement_rules():
    ids = lambda d: set(tl.badges_of(d))
    five = [hero(i) for i in range(5)]
    assert len({a[0] for a in tl.ACHIEVEMENTS}) == len(tl.ACHIEVEMENTS) >= 16 and all(callable(a[3]) for a in tl.ACHIEVEMENTS)
    assert ids(sdata([])) == set() and ids(sdata([hero()])) == {"first"}, "one finished hero: first blood only"
    # settled only: a running hero, or the main session running, earns nothing yet
    assert tl.badges_of(sdata([hero(), hero(1, running=True)])) == [] and tl.badges_of(sdata(five, prun=True)) == []
    assert {"party5", "flawless", "penny"} <= ids(sdata(five, 0.5)) and "party5" not in ids(sdata(five[:4]))
    assert "legion" in ids(sdata([hero(i) for i in range(15)])) and "legion" not in ids(sdata([hero(i) for i in range(14)]))
    bad = five[:4] + [hero(4, flags=["no-model"])]
    assert "flawless" not in ids(sdata(bad)) and "flawless" in ids(sdata(five[:4] + [hero(4, flags=["handoff", "ctx-200k", "tool-limit"])])), "info flags are not issues"
    assert "flawless" not in ids(sdata(five[:4])), "5+ heroes"
    assert "flawless" not in ids(sdata(five, guard=0, denials=1)), "a guard block is an issue"
    assert "penny" not in ids(sdata(five, 2)) and "penny" not in ids(sdata(five, 0.5, cost={"total": 0.5, "unpriced": ["gpt"]})) and "penny" not in ids(sdata(five[:4], 0.5))
    assert "hoard" in ids(sdata([hero()], 50.01)) and "hoard" not in ids(sdata([hero()], 50))
    boss = lambda **k: [hero(0, rank="boss", **k), hero(1), hero(2)]
    assert "slayer" in ids(sdata(boss())) and "slayer" not in ids(sdata(boss(flags=["no-model"]))) and "slayer" not in ids(sdata(boss(handoff="/h/x.md")))
    assert "slayer" not in ids(sdata([hero(i) for i in range(3)])) and "slayer" not in ids(sdata(boss(running=True)))
    cont = lambda n: [hero(i, cont="p%d" % i if i < n else None) for i in range(4)]
    assert "relay" not in ids(sdata(cont(0))) and "relay" in ids(sdata(cont(1))) and "keys" not in ids(sdata(cont(2))) and "keys" in ids(sdata(cont(3)))
    wf = lambda st: {"id": "wf_1", "kind": "wf", "running": False, "wf": {"state": st}, "start": 0, "end": 9, "flags": []}
    assert "treasure" in ids(sdata([wf("done")])) and "treasure" not in ids(sdata([wf("failed")])) and "treasure" not in ids(sdata([wf("running")])), "a workflow is not a hero"
    assert "first" not in ids(sdata([wf("done")])) and "party5" not in ids(sdata([wf("done")] * 5))
    tiers = lambda *t: [hero(i, tier=x) for i, x in enumerate(t)]
    assert "assemble" in ids(sdata(tiers("executor", "scanner", "plan", "writer"))) and "assemble" not in ids(sdata(tiers("executor", "scanner", "plan", "plan", "plan")))
    assert "speedrun" in ids(sdata([hero(start=0, end=29.9)])) and "speedrun" not in ids(sdata([hero(start=0, end=30)])) and "speedrun" not in ids(sdata([hero(start=0, end=5, tools=0)]))
    at_once = lambda n, gap=0: [hero(i, start=i * gap, end=100 + i * gap) for i in range(n)]
    assert "swarm" in ids(sdata(at_once(5))) and "swarm" not in ids(sdata(at_once(4))) and "swarm" in ids(sdata(at_once(5, 10)))
    assert "swarm" not in ids(sdata([hero(i, start=i * 10, end=i * 10 + 10) for i in range(5)])) and "swarm" not in ids(sdata(at_once(5, 100))), "back to back is not at once"
    assert "haunted" in ids(sdata([hero(flags=["tool-limit", "ignored-limit"])])) and "haunted" not in ids(sdata([hero(flags=["tool-limit"])]))
    # lifetime rules read the totals only
    life = [a for a in tl.ACHIEVEMENTS if a[4]]
    assert [a[0] for a in life] == ["heroes100", "heroes1000", "sessions100", "usd1000", "streak7"]
    zero = {"heroes": 0, "sessions": 0, "usd": 0, "streak": 0}
    assert not any(a[3](None, zero) for a in life)
    for a, key, v in zip(life, ("heroes", "heroes", "sessions", "usd", "streak"), (100, 1000, 100, 1000, 7)):
        assert a[3](None, dict(zero, **{key: v})) and not a[3](None, dict(zero, **{key: v - 1})), a[0]
    # guild level: XP from heroes, sessions and trophies, never from spend; level n starts at 50*n*(n-1)
    assert tl.level(zero, 0) == {"n": 1, "title": "Tavern Regulars", "xp": 0, "lo": 0, "hi": 100}
    assert tl.level(dict(zero, usd=9999), 0)["xp"] == 0
    assert tl.level(dict(zero, heroes=9), 0)["n"] == 1 and tl.level(dict(zero, heroes=10), 0)["n"] == 2
    assert tl.level(dict(zero, heroes=10, sessions=5), 1) == {"n": 3, "title": "Chartered Company", "xp": 300, "lo": 300, "hi": 600}
    assert tl.level(dict(zero, heroes=49499), 0)["title"] == "Mythic Pantheon" and tl.level(dict(zero, heroes=49500), 0)["n"] == 100
    assert tl.level(dict(zero, heroes=100000), 0)["title"] == "Guild of Legends", "the last title holds past level 100"
    assert [lv for lv, _ in tl.TITLES] == sorted(lv for lv, _ in tl.TITLES) and tl.TITLES[0][0] == 1
    assert tl.level(zero, 0, 3)["xp"] == 3 * tl.QUEST_XP
    # daily quests: three a day, a window that moves by three (trophy.js picks the same: see test_trophy.js for these two days)
    qids = lambda day: [q[0] for q in tl.quests_for(day)]
    all_ids = [q[0] for q in tl.QUESTS]
    assert len(all_ids) == len(set(all_ids)) == 8 and len(all_ids) % 3, "test_trophy.js assumes 8; a multiple of 3 would freeze the trios"
    assert qids("2026-03-01") == all_ids[4:7] and qids("2026-03-02") == [all_ids[7], all_ids[0], all_ids[1]] and qids("1970-01-01") == all_ids[1:4]
    won = lambda d: {q[0] for q in tl.QUESTS if q[3](tl.facts(d))}
    assert won(sdata([hero(i) for i in range(3)])) >= {"muster", "clean"} and "muster" not in won(sdata([hero(0), hero(1)]))
    assert "clean" not in won(sdata([hero(0), hero(1), hero(2, flags=["tool-limit", "ignored-limit"])]))
    assert "scout" in won(sdata([hero()])) and "scout" not in won(sdata([hero(0), hero(1)])) and "scout" not in won(sdata([hero(flags=["tool-limit", "ignored-limit"])]))
    assert "pack" in won(sdata(at_once(3))) and "pack" not in won(sdata(at_once(2)))


def test_save_file():
    d = setup()
    od, now = os.path.join(d, "out"), datetime(2026, 3, 1, 12).timestamp()
    day = 86400
    sd = lambda sid, age=0, **k: dict(sdata(k.pop("agents", [hero()]), k.pop("usd", 2.0), id=sid, updated=now - age * day, t0=now - age * day - 60), **k)
    pub = lambda x: tl.publish(x, od, now=now)
    save = lambda: tl.read_save(os.path.join(od, tl.SAVE))
    # missing file: fresh. publish writes it as TLA({...}); and puts the session's own ids in its data
    assert tl.read_save(os.path.join(od, tl.SAVE)) == {"v": 1, "unlocked": {}, "sessions": {}, "folded": {"sessions": 0, "heroes": 0, "usd": 0.0}, "days": [], "quests": {}}
    five = [hero(i) for i in range(5)]
    pub(sd("s1", agents=five))
    raw = open(os.path.join(od, tl.SAVE)).read()
    sv = unwrap(os.path.join(od, tl.SAVE))
    assert raw.startswith("TLA(") and raw.endswith(");\n") and "</" not in raw and sv["v"] == 1 and sv["totals"] == {"heroes": 5, "sessions": 1, "usd": 2.0, "streak": 1}
    jd = unwrap(os.path.join(od, "s1.data.js"))
    assert jd["badges"] == tl.badges_of(sd("s1", agents=five)) and "party5" in jd["badges"] and set(jd["badges"]) <= set(sv["unlocked"])
    assert sv["unlocked"]["party5"] == {"t": now, "sid": "s1"} and [x[0] for x in sv["list"]] == [a[0] for a in tl.ACHIEVEMENTS] and all(len(x) == 3 for x in sv["list"])
    qn = sum(len(v) for v in sv["quests"].values())
    assert sv["level"] == tl.level(sv["totals"], len(sv["unlocked"]), qn) and sv["level"]["xp"] == 50 + 20 + 100 * len(sv["unlocked"]) + tl.QUEST_XP * qn, "the file carries the level the viewer draws"
    # quests (in their own folder): a settled session finishes the quests of its last day that it meets; again and again pays once; an unsettled one finishes none
    qd, today = os.path.join(d, "q"), datetime.fromtimestamp(now).strftime("%Y-%m-%d")
    os.makedirs(qd)
    qsave = lambda: tl.read_save(os.path.join(qd, tl.SAVE))
    pack = lambda **k: [hero(i, start=0, end=100, **k) for i in range(3)]
    assert "pack" in [q[0] for q in tl.quests_for(today)] and sv["quests"] == {} and [x[0] for x in sv["qlist"]] == [q[0] for q in tl.QUESTS] and all(len(x) == 3 for x in sv["qlist"])
    tl.save_achievements(qd, sd("run", agents=pack(running=True)), now)
    assert qsave()["quests"] == {}
    for _ in range(2):
        tl.save_achievements(qd, sd("p1", agents=pack()), now)
    assert qsave()["quests"] == {today: ["pack"]} and unwrap(os.path.join(qd, tl.SAVE))["level"]["xp"] == 2 * (30 + 20) + 100 * len(qsave()["unlocked"]) + tl.QUEST_XP
    tl.save_achievements(qd, sd("p2", 1, agents=pack()), now)
    assert qsave()["quests"] == {today: ["pack"], "2026-02-28": ["clean"]}, "yesterday's session counts for yesterday's three, where pack is not one"
    open(os.path.join(qd, tl.SAVE), "w").write('TLA({"quests": {"2026-03-01": ["b", "a", "a", 5], "nope": ["a"], "2026-03-02": "x"}});')
    assert qsave()["quests"] == {"2026-03-01": ["a", "b"]}
    # idempotent: the same session published again and again counts once; it grows, the totals follow (not add up)
    for _ in range(3):
        pub(sd("s1", agents=five))
    assert save()["unlocked"] == sv["unlocked"] and tl.totals(save()) == {"heroes": 5, "sessions": 1, "usd": 2.0, "streak": 1}
    pub(sd("s1", agents=five + [hero(5)], usd=3.0))
    assert tl.totals(save()) == {"heroes": 6, "sessions": 1, "usd": 3.0, "streak": 1}
    pub(sd("s2", 1, agents=[hero()], usd=1.5))
    assert tl.totals(save()) == {"heroes": 7, "sessions": 2, "usd": 4.5, "streak": 2}, "a second session on the day before: a 2-day streak"
    # first unlock wins: a later session never moves it; an earlier one (rebuilds go newest first) does
    assert save()["unlocked"]["first"] == {"t": now - day, "sid": "s2"}, "s2 is the earlier session"
    pub(sd("s0", 3, agents=[hero()]))
    assert save()["unlocked"]["first"] == {"t": now - 3 * day, "sid": "s0"} and save()["unlocked"]["party5"]["sid"] == "s1"
    pub(sd("s9", 0.5, agents=[hero()]))
    assert save()["unlocked"]["first"]["sid"] == "s0", "a later session never moves it"
    # an unsettled session counts in the totals but earns no session badge
    pub(sd("live", 0, agents=[hero(running=True)] * 1, prun=True))
    assert unwrap(os.path.join(od, "live.data.js"))["badges"] == [] and tl.totals(save())["sessions"] == 5
    # retention: a record older than RETAIN_DAYS folds into the totals once; a session already that old is never entered
    later = now + 31 * day
    tl.publish(sd("n1", 0, agents=[hero()], updated=later), od, now=later)
    t = tl.totals(save())
    assert save()["folded"]["sessions"] == 5 and sorted(save()["sessions"]) == ["n1"], save()
    assert (t["heroes"], t["sessions"], t["usd"]) == (11, 6, 12.5), "5 folded (6+1+1+1+1 heroes, $10.50) plus n1"
    tl.publish(sd("s1", 31, agents=five + [hero(5)], usd=3.0), od, now=later)  # a rebuild of a transcript that old
    assert tl.totals(save()) == t and "s1" not in save()["sessions"], "never entered, so never counted twice"
    tl.publish(sd("n1", 0, agents=[hero()], updated=later), od, now=later)
    assert tl.totals(save()) == t
    # lifetime rules: 7 days in a row
    for i in range(7):
        tl.publish(sd("k%d" % i, 20 + i, agents=[hero()]), od, now=now)
    assert "streak7" in save()["unlocked"] and tl.totals(save())["streak"] >= 7
    # a session that is 100 heroes, 1000 heroes, $1000, 100 sessions on its own or together
    tl.publish(sd("big", 0, agents=[hero(i) for i in range(1000)], usd=1000), od, now=now)
    assert {"heroes100", "heroes1000", "usd1000", "hoard", "legion"} <= set(save()["unlocked"]) and "sessions100" not in save()["unlocked"]
    for i in range(100):
        tl.save_achievements(od, sd("m%d" % i, 5, agents=[hero()]), now)
    assert "sessions100" in save()["unlocked"]


def test_save_file_corrupt_and_files():
    d = setup()
    od, now = os.path.join(d, "out"), datetime(2026, 3, 1, 12).timestamp()
    os.makedirs(od)
    path = os.path.join(od, tl.SAVE)
    x = lambda sid: dict(sdata([hero()], 1.0, id=sid, updated=now, t0=now - 9), ctxLimit=1)
    fresh = lambda: tl.read_save(path)
    # corrupt or wrong-typed files start fresh without raising; the next publish rewrites a good one
    for junk in (b"TLA({not json", b"", b"\xff\xfe\x00", b"TLA([1,2]);", b'TLA({"unlocked": 5, "sessions": [1], "folded": "x", "days": ["nope", 3]});', b"TLA(null);"):
        open(path, "wb").write(junk)
        assert fresh() == tl.read_save(os.path.join(d, "missing")), junk
        tl.publish(x("a"), od, now=now)
        assert tl.totals(fresh()) == {"heroes": 1, "sessions": 1, "usd": 1.0, "streak": 1} and "first" in fresh()["unlocked"], junk
    # a field that is fine survives a field that is not
    open(path, "w").write('TLA({"unlocked": {"first": {"t": 5, "sid": "q"}, "bad": 3}, "sessions": {"z": {"updated": 5}}});')
    assert fresh()["unlocked"] == {"first": {"t": 5, "sid": "q"}} and fresh()["sessions"] == {}
    # the hook never fails: an unwritable save file loses the trophy, not the session
    os.remove(path)
    os.mkdir(path)
    tl.publish(x("b"), od, now=now)
    assert os.path.exists(os.path.join(od, "b.data.js")) and unwrap(os.path.join(od, "b.data.js"))["badges"] == []
    os.rmdir(path)
    # purge never touches the save file or its lock, however old; build_index does not read it as a session
    tl.publish(x("c"), od, now=now)
    for f in (tl.SAVE, ".achievements.lock", "c.data.js"):
        os.utime(os.path.join(od, f), (1, 1))
    tl.purge(od, "other", now + 90 * 86400)
    left = set(os.listdir(od))
    assert {tl.SAVE, ".achievements.lock"} <= left and "c.data.js" not in left
    tl.build_index(od, now)
    assert {r["id"] for r in unwrap(os.path.join(od, "index.data.js"))["sessions"]} == {"a", "b"} and tl.SAVE not in tl.ASSETS
    # concurrent publishes of different sessions: no lost update
    keep = tl.read_save

    def slow(p):
        r = keep(p)
        time.sleep(0.02)
        return r
    tl.read_save = slow
    try:
        ts = [threading.Thread(target=tl.publish, args=(x("t%d" % i), od), kwargs={"now": now}) for i in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
    finally:
        tl.read_save = keep
    assert {"t%d" % i for i in range(8)} <= set(keep(path)["sessions"]), sorted(keep(path)["sessions"])


if __name__ == "__main__":
    for t in (test_tree_flags_running_and_files, test_limits_tokens_tiers, test_workflows_and_main_running, test_lobby_limit, test_cost, test_rules_and_config, test_rank, test_achievement_rules, test_save_file, test_save_file_corrupt_and_files):
        t()
    print("ok")
