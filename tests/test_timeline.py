"""python3 tests/test_timeline.py (or pytest). Builds fake transcripts in a temp dir; never reads your real ~/.claude."""
import json, os, sys, tempfile
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from agent_timelines import timeline as tl

T = lambda sec: "2026-01-01T00:%02d:%02d.000Z" % (sec // 60, sec % 60)
wr = lambda p, ls: open(p, "w").write("\n".join(json.dumps(x) if not isinstance(x, str) else x for x in ls) + "\n")
use = lambda i, name, inp, sec: {"type": "assistant", "timestamp": T(sec), "cwd": "/w", "effort": "high", "message": {
    "id": "m" + i, "model": "claude-opus-5", "usage": {"input_tokens": 10, "output_tokens": 5}, "content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]}}
fin = lambda i, sec, model="claude-sonnet-5", effort="high": {"type": "assistant", "timestamp": T(sec), "effort": effort, "message": {
    "id": "f" + i, "stop_reason": "end_turn", "model": model, "content": [{"type": "text", "text": "done"}]}}
meta = lambda tid, **k: dict({"agentType": "general-purpose", "toolUseId": tid, "description": "d"}, **k)
spawn = lambda tid, typ, sec, **k: use(tid, "Agent", dict({"subagent_type": typ}, **k), sec)
FULL = {"model": "opus", "effort": "high"}
unwrap = lambda p: json.loads(open(p).read().strip()[3:-2])
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
    assert "innerHTML" not in html and "index.data.js" in html
    assert "prompts.js" in html and "TLP" in html
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
    assert "prompt" not in json.dumps(rows) and "<\\/" not in json.dumps(rows), "lobby rows carry no prompt text"
    for f in ("old.data.js", "ancient.html", "gone.prompts.js"):
        open(os.path.join(od, f), "w").write("x")
        os.utime(os.path.join(od, f), (1, 1))
    os.utime(os.path.join(od, "liveB.data.js"), (1, 1))
    tl.purge(od, "liveB", now)
    assert sorted(os.listdir(od)) == sorted(tl.ASSETS + ("bad.data.js", "endA.data.js", "index.data.js", "index.html", "liveB.data.js", "sess1.data.js", "sess1.prompts.js", "staleC.data.js", "oldD.data.js"))
    # SubagentHandback ends an agent; a later assistant line resumes it; SubagentStop/Start keep the closed list
    hb = [use("g1", "Read", {}, 10), use("hb1", "SubagentHandback", {"message": "x"}, 20),
          {"type": "user", "timestamp": T(21), "message": {"content": [{"type": "tool_result", "tool_use_id": "hb1", "content": "Report delivered."}]}}]
    p3 = session(pd, "sess3", [spawn("m1", "general-purpose", 0, model="sonnet", effort="high")], [("G", meta("m1"), hb)])
    assert not tl.load(p3)["agents"][0]["running"]
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


if __name__ == "__main__":
    for t in (test_tree_flags_running_and_files, test_limits_tokens_tiers, test_workflows_and_main_running, test_rules_and_config):
        t()
    print("ok")
