"""Turn one Claude Code session (main transcript, subagent transcripts, Workflow runs) into the data the viewer draws,
and write it as <out_dir>/<sid>.data.js next to the shared index.html and index.data.js (live sessions only)."""
import filecmp, glob, json, os, re, shutil, sys, tempfile, time
from datetime import datetime, timezone

CLAUDE_DIR = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
PROJECTS = os.path.join(CLAUDE_DIR, "projects")
OUT_DIR = os.path.join(CLAUDE_DIR, "agent-timelines")
AGENTS_DIR = os.path.join(CLAUDE_DIR, "agents")  # <type>.md frontmatter model:/effort: pin an agent type
HANDOVER_DIR = os.path.join(CLAUDE_DIR, "handovers")  # <date>-<agent_id>.md handoff files
DENY = "Main session does not execute"  # text of a guard hook that blocks the main session from doing work itself
TIERS = {"Explore": "scanner", "Plan": "plan", "writer": "writer", "runner": "runner", "general-purpose": "executor"}
CTX_LIMIT = 200000  # one turn's context (input + cache read + cache write) worth flagging
TOOL_LIMIT = None  # tool calls after which a hand-off hook tells an agent to stop; None = no such hook, the viewer shows a plain count
FLAG_NAMES = ("no-model", "no-effort", "auto-filled", "frontmatter", "model-mismatch", "effort-mismatch", "ctx", "handoff", "tool-limit",
              "ignored-limit", "orphan", "handoff-not-continued")
RULES = {"no-model": False, "no-effort": False}  # flag -> shown; a flag not listed is on. "ctx" stands for ctx-<N>k
BRIEF_LIMIT = 8000  # a spawn hook refusing longer briefs answers "Brief is N chars (>BRIEF_LIMIT)"
RETAIN_DAYS = 30
LOBBY_LIMIT = 200  # sessions in the lobby index (about 0.5 KB each; the page polls it every 3 s)
FAMILIES = ("fable", "mythos", "opus", "sonnet", "haiku")  # model families with their own colour; anything else is "other"
WEIGHTS = {"in": 1, "cc": 1.25, "cr": 0.1, "out": 5}  # cost per token, input = 1
PRICES_ASOF = "2026-11-10"
# USD per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output. Key = model id prefix after "claude-".
# Anthropic first-party API list prices (platform.claude.com/docs/en/about-claude/pricing). "over": [prompt tokens, multiplier] for a request above that size.
PRICES = {
    "fable-5-2": {"in": 8, "cc5": 10, "cc1": 16, "cr": 0.20, "out": 40},
    "mythos-5-2": {"in": 8, "cc5": 10, "cc1": 16, "cr": 0.20, "out": 40},
    "fable-5-1": {"in": 10, "cc5": 12.5, "cc1": 20, "cr": 0.25, "out": 50},
    "mythos-5-1": {"in": 10, "cc5": 12.5, "cc1": 20, "cr": 0.25, "out": 50},
    "fable-5": {"in": 10, "cc5": 12.5, "cc1": 20, "cr": 1, "out": 50},
    "mythos-5": {"in": 10, "cc5": 12.5, "cc1": 20, "cr": 1, "out": 50},
    "opus-5-5": {"in": 4, "cc5": 5, "cc1": 8, "cr": 0.20, "out": 20},
    "opus-5": {"in": 5, "cc5": 6.25, "cc1": 10, "cr": 0.50, "out": 25},
    "opus-4-8": {"in": 5, "cc5": 6.25, "cc1": 10, "cr": 0.50, "out": 25},
    "opus-4-7": {"in": 5, "cc5": 6.25, "cc1": 10, "cr": 0.50, "out": 25},
    "opus-4-6": {"in": 5, "cc5": 6.25, "cc1": 10, "cr": 0.50, "out": 25},
    "opus-4-5": {"in": 5, "cc5": 6.25, "cc1": 10, "cr": 0.50, "out": 25},
    "opus-4-1": {"in": 15, "cc5": 18.75, "cc1": 30, "cr": 1.50, "out": 75},
    "opus-4": {"in": 15, "cc5": 18.75, "cc1": 30, "cr": 1.50, "out": 75},
    "sonnet-5-5": {"in": 2, "cc5": 2.5, "cc1": 4, "cr": 0.10, "out": 10},
    "sonnet-5": {"in": 2, "cc5": 2.5, "cc1": 4, "cr": 0.20, "out": 10},
    "sonnet-4-6": {"in": 3, "cc5": 3.75, "cc1": 6, "cr": 0.30, "out": 15},
    "sonnet-4-5": {"in": 3, "cc5": 3.75, "cc1": 6, "cr": 0.30, "out": 15},
    "sonnet-4": {"in": 3, "cc5": 3.75, "cc1": 6, "cr": 0.30, "out": 15},
    "haiku-5-5": {"in": 0.10, "cc5": 0.125, "cc1": 0.20, "cr": 0.01, "out": 0.50, "over": [100000, 5]},
    "haiku-4-5": {"in": 1, "cc5": 1.25, "cc1": 2, "cr": 0.10, "out": 5},
}
PRICE_COLS = ("in", "cc5", "cc1", "cr", "out", "over")
FAST_MULT = 2  # usage.speed == "fast": every price column doubles
STALE = 600  # s: an unfinished agent whose transcript is idle this long is dead, not running
LIVE_AGE = 3600  # s: a session with no activity this long is ended
ASSETS = ("tiny-dungeon.png", "one-bit.png", "PressStart2P-Regular.ttf", "dungeon.js", "actors.js", "lobby.js", "gantt.js")  # sprites + font (assets/LICENSES.txt) + view scripts
CONFIG = os.path.expanduser(os.environ.get("AGENT_TIMELINES_CONFIG") or "~/.config/agent-timelines/config.json")
KEYS = {"out_dir": "OUT_DIR", "agents_dir": "AGENTS_DIR", "handover_dir": "HANDOVER_DIR", "tiers": "TIERS", "guard_text": "DENY",
        "ctx_limit": "CTX_LIMIT", "tool_limit": "TOOL_LIMIT", "brief_limit": "BRIEF_LIMIT", "retain_days": "RETAIN_DAYS", "lobby_limit": "LOBBY_LIMIT",
        "rules": "RULES", "prices": "PRICES"}


def load_config(path=CONFIG):
    """Override the defaults above from an optional JSON file; an unknown key is an error so a typo is not silently ignored."""
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        return
    bad = set(cfg) - set(KEYS)
    if bad:
        sys.exit("%s: unknown keys %s (known: %s)" % (path, sorted(bad), sorted(KEYS)))
    for k, v in cfg.items():
        if k == "rules":
            unknown = set(v) - set(FLAG_NAMES)
            if unknown:
                sys.exit("%s: unknown rules %s (known: %s)" % (path, sorted(unknown), sorted(FLAG_NAMES)))
            RULES.update(v)  # merged, so naming one rule keeps the defaults of the others
        elif k == "prices":
            num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
            for mid, e in (v.items() if isinstance(v, dict) else [("prices", v)]):
                badk = sorted(set(e) - set(PRICE_COLS)) if isinstance(e, dict) else [mid]
                badk += [c for c, x in (e.items() if isinstance(e, dict) else ()) if c in PRICE_COLS and not (
                    (isinstance(x, list) and len(x) == 2 and all(map(num, x))) if c == "over" else num(x))]
                if badk:
                    sys.exit("%s: bad prices entry %r, key(s) %s (known: %s, numbers only; over = [tokens, multiplier])" % (path, mid, badk, list(PRICE_COLS)))
            PRICES.update(v)  # merged per model, so one gateway model or one changed price needs no restated table
        else:
            globals()[KEYS[k]] = os.path.expanduser(v) if k.endswith("_dir") else v


load_config()
CTX_FLAG = "ctx-%dk" % (CTX_LIMIT // 1000)
BRIEF_RE = re.compile(r"Brief is (\d+) chars \(>%d\)" % BRIEF_LIMIT)
LIMIT_RE = re.compile(r"you have made (\d+) tool calls")
HANDOFF_RE = re.compile(r"^\s*HANDOFF\s+(\S+)")
CONT_RE = re.compile(r"Continue from the handoff in\s+[`'\"(*<]*(\S+)")  # briefs often wrap the path in backticks or quotes
WF_RE = re.compile(r"^wf_[\w-]+$")  # Workflow run id; it names sidecar paths, so nothing else is joined into one


def ts(s):
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?", s or "")
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp() + float(m.group(2) or 0)


def text_of(c):
    """Content is a str or a list of blocks (text / tool_result with str-or-list content)."""
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(text_of(b.get("text", b.get("content", ""))) if isinstance(b, dict) else text_of(b) for b in c)
    return ""


def top(counts):
    return max(counts, key=counts.get) if counts else None


def family(model):
    m = (model or "").lower()
    return next((f for f in FAMILIES if f in m), "other")


def price_of(model):
    """The PRICES entry for a model id: the longest key that prefixes the id (so opus-5-5 beats opus-5), else None. Never guesses."""
    m = (model or "").lower().rsplit("/", 1)[-1]
    forms = [m] + [m[m.index(f):] for f in FAMILIES if f in m]  # claude-opus-5-5, us.anthropic.claude-sonnet-4-5-2025...-v1:0
    best = max((k for k in PRICES if any(x.startswith(k) for x in forms)), key=len, default=None)
    return PRICES[best] if best else None


def usd_of(p, c, c1, fast):
    """Cost of one message with price entry p; c = in/cc/cr/out counts, c1 = the 1-hour part of cc."""
    x = (c["in"] * p.get("in", 0) + (c["cc"] - c1) * p.get("cc5", 0) + c1 * p.get("cc1", 0) + c["cr"] * p.get("cr", 0) + c["out"] * p.get("out", 0)) / 1e6
    if p.get("over") and c["in"] + c["cc"] + c["cr"] > p["over"][0]:
        x *= p["over"][1]
    return x * (FAST_MULT if fast else 1)


def ran(model, effort, actual, actual_effort):
    """What ran (short model/effort); before the first assistant line, the requested values marked with ?"""
    if actual:
        return "%s/%s" % (re.sub(r"^claude-", "", actual.rsplit("/", 1)[-1]), actual_effort or "-")
    return "%s?/%s?" % (model or "-", effort or "-")


def weighted(c):
    return int(round(sum(c.get(k, 0) * w for k, w in WEIGHTS.items())))


def add_tok(a, b):
    for k in WEIGHTS:
        a[k] = a.get(k, 0) + b.get(k, 0)
    return a


def total_tok(fams):
    t = dict.fromkeys(WEIGHTS, 0)
    for c in fams.values():
        add_tok(t, c)
    return t


def sdur(sec):
    sec = int(round(sec))
    return "%dh%02dm" % (sec // 3600, sec % 3600 // 60) if sec >= 3600 else "%dm%02ds" % (sec // 60, sec % 60) if sec >= 60 else "%ds" % sec


def pinned(typ):
    """model/effort from the frontmatter of <AGENTS_DIR>/<type>.md."""
    out = {}
    if not typ or "/" in typ:
        return out
    try:
        with open(os.path.join(AGENTS_DIR, typ + ".md"), encoding="utf-8") as f:
            lines = f.read().splitlines()[1:]
    except (OSError, ValueError):
        return out
    for ln in lines:
        if ln == "---":
            break
        m = re.match(r"(model|effort):\s*(\S+)", ln)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def read_jsonl(path, errors):
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except ValueError:
                d = None
            if isinstance(d, dict):
                out.append(d)
            else:
                errors.append("%s:%d bad line" % (os.path.basename(path), n))
    return out


def scan(lines):
    """Facts common to main and subagent transcripts."""
    r = {"t0": None, "t1": None, "tools": 0, "spawns": {}, "tok": {}, "peak": 0, "models": {}, "efforts": {}, "last_text": "",
         "denials": [], "refused": [], "cwd": None, "final": False, "limit_hits": [], "wf": [], "by_model": {}, "usd": 0.0, "unpriced": set(),
         "tool_names": {}, "reply": ""}
    seen, usage, hb, wfu = set(), {}, set(), {}  # hb: SubagentHandback tool_use ids; wfu: Workflow tool_use id -> launch time
    for d in lines:
        t = ts(d.get("timestamp"))
        if t is not None:
            r["t0"] = t if r["t0"] is None else min(r["t0"], t)
            r["t1"] = t if r["t1"] is None else max(r["t1"], t)
        r["cwd"] = r["cwd"] or d.get("cwd")
        at = d.get("attachment") if d.get("type") == "attachment" and isinstance(d.get("attachment"), dict) else {}
        if at.get("type") == "hook_additional_context":  # hook_success repeats the text; count this one only
            hit = LIMIT_RE.search(text_of(at.get("content")))
            if hit:
                r["limit_hits"].append((t, int(hit.group(1))))
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}
        content = msg.get("content")
        # final: the last turn line is an assistant reply not mid tool loop (the tool_result echoing a handback changes nothing), or an Esc interrupt
        if d.get("type") in ("assistant", "user") and not (d["type"] == "user" and isinstance(content, list) and content and all(
                isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in hb for b in content)):
            r["final"] = d["type"] == "assistant" and msg.get("stop_reason") not in (None, "tool_use") or (
                d["type"] == "user" and text_of(content).startswith("[Request interrupted by user"))
        if d.get("type") == "assistant":
            m = msg.get("model")
            if m and m != "<synthetic>":
                r["models"][m] = r["models"].get(m, 0) + 1
                if d.get("effort"):
                    r["efforts"][d["effort"]] = r["efforts"].get(d["effort"], 0) + 1
            if isinstance(msg.get("usage"), dict):
                u = msg["usage"]  # streamed lines repeat a message id; keep the last
                cc = u.get("cache_creation")  # {ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}; missing = all 5-minute writes
                usage[msg.get("id") or d.get("uuid")] = (family(m), {k: u.get(f) or 0 for k, f in (
                    ("in", "input_tokens"), ("cc", "cache_creation_input_tokens"), ("cr", "cache_read_input_tokens"), ("out", "output_tokens"))},
                    m or "?", (cc.get("ephemeral_1h_input_tokens") or 0) if isinstance(cc, dict) else 0, u.get("speed") == "fast")
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use" and b.get("name") == "SubagentHandback":
                    hb.add(b.get("id"))
                    r["reply"] = text_of((b.get("input") or {}).get("message"))
                    r["final"] = True  # stop_reason is usually null on this line
                if b.get("type") == "tool_use" and b.get("id") not in seen:
                    seen.add(b.get("id"))
                    r["tools"] += 1
                    nm = b.get("name") or "?"
                    r["tool_names"][nm] = r["tool_names"].get(nm, 0) + 1
                    if b.get("name") == "Workflow":
                        wfu[b.get("id")] = t
                    if b.get("name") == "Agent":
                        r["spawns"][b.get("id")] = b.get("input") or {}
                elif b.get("type") == "text" and b["text"].strip():
                    r["last_text"] = b["text"]
                    r["reply"] = ""  # a handback's message is stale once the agent speaks again
        elif d.get("type") == "user" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    tur = d.get("toolUseResult")  # a launch answers {taskType: local_workflow, runId, workflowName, summary, ...}
                    if isinstance(tur, dict) and tur.get("taskType") == "local_workflow" and WF_RE.match(str(tur.get("runId"))):
                        r["wf"].append({"t": wfu.get(b.get("tool_use_id"), t), "res": tur})
                    s = text_of(b.get("content"))
                    if len(s) < 800:  # longer results (plans) merely quote these texts
                        if DENY in s:
                            r["denials"].append(t)
                        br = BRIEF_RE.search(s)
                        if br:
                            r["refused"].append((t, int(br.group(1))))
    for fam, c, m, c1, fast in usage.values():
        add_tok(r["tok"].setdefault(fam, dict.fromkeys(WEIGHTS, 0)), c)
        r["peak"] = max(r["peak"], c["in"] + c["cc"] + c["cr"])
        bm, p = r["by_model"].setdefault(m, dict.fromkeys(WEIGHTS, 0)), price_of(m)
        add_tok(bm, c)
        bm.setdefault("usd", 0.0)
        if p:
            x = usd_of(p, c, min(c1, c["cc"]), fast)
            bm["usd"] += x
            r["usd"] += x
        elif any(c.values()):
            r["unpriced"].add(m)
    return r


def tools_by(counts):
    return [list(kv) for kv in sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))]


def agent(aid, m, s, first, wf, age, inp, now, closed, ended):
    """One subagent node. Keys starting with _ are for load() only."""
    running = not (ended or s["final"] or aid in closed) and age < STALE
    typ = m.get("agentType") or inp.get("subagent_type") or "?"
    fm = pinned(typ)  # a spawn hook leaves pinned types alone, so the agent file is the request
    model = inp.get("model") or m.get("model") or fm.get("model")
    effort = inp.get("effort") or m.get("effort") or fm.get("effort")
    actual, actual_effort = top(s["models"]), top(s["efforts"])
    exempt = typ == "writer"
    h = HANDOFF_RE.match(s["last_text"])
    hf = glob.glob(os.path.join(HANDOVER_DIR, "*-%s.md" % glob.escape(aid)))
    handoff = os.path.expanduser(h.group(1)) if h else (hf[0] if hf and not running else None)
    limit = s["limit_hits"][0] if s["limit_hits"] and not exempt else None
    flags = [f for f, on in (
        ("no-model", not model and not wf), ("no-effort", not effort and not wf),  # a workflow script sets them per agent() call
        ("auto-filled", inp and ((not inp.get("model") and m.get("model")) or (not inp.get("effort") and m.get("effort")))),
        ("frontmatter", fm),
        ("model-mismatch", model and model != "inherit" and actual and model.lower() not in actual.lower()),
        ("effort-mismatch", effort and actual_effort and effort != actual_effort),
        (CTX_FLAG, s["peak"] >= CTX_LIMIT and not exempt),
        ("handoff", handoff),
        ("tool-limit", limit),
        ("ignored-limit", limit and not handoff and not running and s["tools"] > limit[1])) if on]
    prompt = inp.get("prompt") or first
    reply = s["reply"] or s["last_text"]  # a running agent's latest text doubles as a progress line
    tok = total_tok(s["tok"])
    return {"id": aid, "parent": wf, "type": typ, "tier": TIERS.get(typ) or ("executor" if "sonnet" in (model or actual or "").lower() else "other"),
            "desc": m.get("description") or inp.get("description") or "", "req": "%s/%s" % (model or "-", effort or "-"),
            "ran": ran(model, effort, actual, actual_effort), "fam": family(actual or model), "running": running,
            "start": s["t0"] or (now if running else None), "end": now if running else s["t1"], "tools": s["tools"],
            "tokens": weighted(tok), "tok": tok, "usd": round(s["usd"], 6), "unpriced": bool(s["unpriced"]), "toolsBy": tools_by(s["tool_names"]), "reply": reply, "replyLen": len(reply), "peak": s["peak"], "brief": len(prompt), "flags": flags, "handoff": handoff, "cont": None,
            "limit": limit[1] if limit else None, "exempt": exempt, "prompt": prompt, "phase": str(m.get("workflowPhase") or "")[:40] if wf else "",
            "_s": s, "_age": age, "_limit_t": limit[0] if limit else None, "_owner": m.get("toolUseId")}


def workflow(rid, w, kids, base, now, ended, errors):
    """One Workflow run node; the harness writes <sid>/workflows/<runId>.json when the run ends, so no file means still going (or lost)."""
    try:
        with open(os.path.join(base, "workflows", rid + ".json")) as f:
            j = json.load(f)
    except OSError:
        j = {}
    except ValueError:
        errors.append(rid + ".json unreadable")
        j = {}
    j = j if isinstance(j, dict) else {}
    ages = [a["_age"] for a in kids] + ([now - w["t"]] if w["t"] else [])
    idle = min(ages) if ages else STALE
    running = not j and not ended and idle < STALE
    st, res = j.get("startTime"), w["res"]
    start = st / 1000 if isinstance(st, (int, float)) else w["t"] or min([a["start"] for a in kids if a["start"]] or [now])
    tok = dict.fromkeys(WEIGHTS, 0)
    for a in kids:
        add_tok(tok, a["tok"])
    usd = round(sum(a["usd"] for a in kids), 6)
    names = {}
    for a in kids:
        for name, k in a["toolsBy"]:
            names[name] = names.get(name, 0) + k
    states = {}
    for x in j.get("workflowProgress") or []:
        if isinstance(x, dict) and x.get("type") == "workflow_agent":
            states[str(x.get("state"))] = states.get(str(x.get("state")), 0) + 1
    name = str(j.get("workflowName") or res.get("workflowName") or rid)
    status = str(j.get("status") or ("running" if running else "no result recorded"))
    n = j["agentCount"] if isinstance(j.get("agentCount"), int) else len(kids)
    return {"id": rid, "kind": "wf", "parent": w["owner"], "type": "workflow", "tier": "workflow",
            "desc": str(j.get("summary") or res.get("summary") or name), "req": "-", "ran": "%s · %d agent%s" % (status, n, "" if n == 1 else "s"),
            "fam": "wf", "running": running, "start": start, "end": now if running else ts(j.get("timestamp")) or (now - idle if ages else start),
            "tools": j["totalToolCalls"] if isinstance(j.get("totalToolCalls"), int) else sum(a["tools"] for a in kids),
            "tokens": weighted(tok), "tok": tok, "usd": usd, "unpriced": any(a["unpriced"] for a in kids), "toolsBy": tools_by(names), "reply": "", "replyLen": 0, "peak": 0, "brief": 0, "flags": [], "handoff": None, "cont": None, "limit": None, "exempt": True,
            "prompt": "", "phase": "", "wf": {"name": name, "status": status, "agents": n, "states": states,
                                              "state": "running" if running else "done" if j.get("status") == "completed" else "failed",
                                              "phases": [str(x.get("title")) for x in j.get("phases") or [] if isinstance(x, dict)],
                                              "error": str(j.get("error") or "").split("\n")[0][:200], "logs": [str(x)[:200] for x in (j.get("logs") or [])[:3]]}}


def load(path, now=None, closed=(), ended=False, event=None):
    """The viewer data of one session. Running agent = last turn not final, not in `closed` (SubagentStop), transcript touched within STALE.
    The main session also runs from UserPromptSubmit (its prompt line may not be flushed yet) and stops on Stop (its last line may not be)."""
    errors, now = [], now or time.time()
    sid = os.path.basename(path)[:-6]
    base = os.path.join(os.path.dirname(path), sid)
    main = scan(read_jsonl(path, errors))
    owner, inputs, agents = dict.fromkeys(main["spawns"], "main"), dict(main["spawns"]), []
    sub = os.path.join(base, "subagents")  # a Workflow's agents live in subagents/workflows/<runId>/
    for mp in sorted(glob.glob(os.path.join(sub, "agent-*.meta.json")) + glob.glob(os.path.join(sub, "workflows", "wf_*", "agent-*.meta.json"))):
        aid = os.path.basename(mp)[6:-10]
        try:
            with open(mp) as f:
                m = json.load(f)
        except (OSError, ValueError):
            errors.append(os.path.basename(mp) + " unreadable")
            continue
        tp = mp[:-10] + ".jsonl"
        lines = read_jsonl(tp, errors) if os.path.exists(tp) else []
        s = scan(lines)
        first = next((x for x in (text_of(d["message"].get("content")) for d in lines  # a workflow agent's first line is the harness preamble
                                  if d.get("type") == "user" and isinstance(d.get("message"), dict)) if not x.startswith("[Workflow harness")), "")
        wid = os.path.basename(os.path.dirname(mp))
        agents.append((aid, m, s, first, wid if WF_RE.match(wid) else None, now - os.path.getmtime(tp) if os.path.exists(tp) else 0))
        owner.update(dict.fromkeys(s["spawns"], aid))
        inputs.update(s["spawns"])
    agents = [agent(aid, m, s, first, wf, age, inputs.get(m.get("toolUseId"), {}), now, closed, ended) for aid, m, s, first, wf, age in agents]
    handoffs = {a["handoff"]: a["id"] for a in agents if a["handoff"]}
    for a in agents:
        a["parent"] = a["parent"] or owner.get(a["_owner"])
        c = CONT_RE.search(a["prompt"])
        if c:
            a["cont"] = handoffs.get(os.path.expanduser(c.group(1).rstrip("`;,)'\".")))
        if a["parent"] is None:
            a["parent"] = "main"
            a["flags"].append("orphan")
    continued = {a["cont"] for a in agents}
    for a in agents:
        if a["handoff"] and a["id"] not in continued:
            a["flags"].append("handoff-not-continued")
    wfs = {}  # launches in any transcript (a resumed run repeats its runId), plus runs known only from their agent files
    for src, sc in [("main", main)] + [(a["id"], a["_s"]) for a in agents]:
        for w in sc["wf"]:
            wfs.setdefault(w["res"]["runId"], {"owner": src, "t": w["t"], "res": w["res"]})
    for a in agents:
        if WF_RE.match(a["parent"]):
            wfs.setdefault(a["parent"], {"owner": "main", "t": None, "res": {}})
    nodes = agents + [workflow(rid, w, [a for a in agents if a["parent"] == rid], base, now, ended, errors) for rid, w in wfs.items()]
    nodes.sort(key=lambda a: a["start"] or 0)
    for i, a in enumerate(nodes, 1):
        a["n"] = i  # spawn order: the #n on cards and in the feed
    by = {a["id"]: a for a in nodes}
    who = lambda pid: "planner" if pid == "main" else "#%d" % by[pid]["n"] if pid in by else "?"
    events = [{"t": t or now, "k": "guard", "text": "guard block: the main session tried to execute"} for t in main["denials"]]
    events += [{"t": t or now, "k": "refused", "text": "brief refused: %d chars (>%d)" % (n, BRIEF_LIMIT)}
               for t, n in main["refused"] + [x for a in agents for x in a["_s"]["refused"]]]
    for a in nodes:
        name = "#%d %s" % (a["n"], (a["desc"] or a["type"])[:60])
        ev = lambda t, k, text: events.append({"t": t if t is not None else now, "k": k, "aid": a["id"], "text": text})
        if a.get("kind") == "wf":
            ev(a["start"], "wf", "%s → started workflow %s" % (who(a["parent"]), a["wf"]["name"]))
            if not a["running"]:
                ev(a["end"], "wf", "workflow %s %s after %s" % (a["wf"]["name"], "finished" if a["wf"]["state"] == "done" else "failed (%s)" % a["wf"]["status"],
                                                               sdur(a["end"] - a["start"])))
            continue
        ev(a["start"], "spawn", "%s → spawned %s · %s" % (who(a["parent"]), name, a["ran"]))
        if not a["running"] and a["end"] is not None and a["start"] is not None:
            ev(a["end"], "done", "%s · done in %s" % (name, sdur(a["end"] - a["start"])))
        if a["handoff"]:
            ev(a["end"], "handoff", "%s · handed off" % name)
        if a["limit"]:
            ev(a["_limit_t"] or a["start"], "limit", "%s · hit %d tool calls" % (name, a["limit"]))
        if a["cont"]:
            ev(a["start"], "cont", "%s · continues %s" % (name, who(a["cont"])))
    events.sort(key=lambda e: e["t"])
    ftok = {f: dict.fromkeys(WEIGHTS, 0) for f in FAMILIES + ("other",)}  # planner and agents together
    for sc in [main] + [a["_s"] for a in agents]:
        for f, c in sc["tok"].items():
            add_tok(ftok[f], c)
    bm, unpriced = {}, set()  # cost per model id, planner and agents together; workflow nodes add nothing (their agents are counted)
    for sc in [main] + [a["_s"] for a in agents]:
        unpriced |= sc["unpriced"]
        for mid, c in sc["by_model"].items():
            e = bm.setdefault(mid, dict.fromkeys(WEIGHTS, 0))
            add_tok(e, c)
            e["usd"] = e.get("usd", 0.0) + c["usd"]
    musd = round(main["usd"], 6)
    cost = {"total": round(musd + sum(a["usd"] for a in agents), 6), "asof": PRICES_ASOF, "unpriced": sorted(unpriced),
            "models": sorted(({"model": mid, "fam": family(mid), "tok": {k: e[k] for k in WEIGHTS}, "usd": round(e["usd"], 6)} for mid, e in bm.items()),
                             key=lambda x: (-x["usd"], x["model"]))}
    mage = now - os.path.getmtime(path) if os.path.exists(path) else 0
    mrun = not ended and event != "Stop" and (event == "UserPromptSubmit" or (not main["final"] and mage < STALE))
    activity = max([main["t1"] or 0] + [a["end"] or 0 for a in nodes])  # running nodes end at now
    for a in agents:
        a["flags"] = [f for f in a["flags"] if RULES.get("ctx" if f.startswith("ctx-") else f, True)]
        for k in [k for k in a if k[0] == "_"]:
            del a[k]
    mtok = total_tok(main["tok"])
    mreply = main["reply"] or main["last_text"]
    return {"id": sid, "cwd": main["cwd"], "status": "ended" if ended or now - activity >= LIVE_AGE else "live", "now": now, "updated": activity,
            "t0": main["t0"], "t1": max(main["t1"] or 0, now) if mrun or any(a["running"] for a in nodes) else main["t1"],
            "planner": ran(None, None, top(main["models"]), top(main["efforts"])) if main["models"] else "?", "pfam": family(top(main["models"])),
            "prun": mrun, "tools": main["tools"], "tokens": weighted(mtok), "tok": mtok, "usd": musd, "unpriced": bool(main["unpriced"]), "toolsBy": tools_by(main["tool_names"]), "reply": mreply, "replyLen": len(mreply), "cost": cost, "peak": main["peak"], "denials": len(main["denials"]),
            "toolLimit": TOOL_LIMIT, "ctxLimit": CTX_LIMIT, "models": {f: weighted(c) for f, c in ftok.items()}, "modelTok": ftok,
            "events": events[-30:], "errors": errors[:5], "agents": nodes}


# ---- files

def js(obj):
    """JSON for a <script> body: ensure_ascii stays on and "</" is broken so no prompt text can close the tag."""
    return json.dumps(obj).replace("</", "<\\/")


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def read_data(path):
    """The dict inside a <sid>.data.js ("TL(...);"), or None."""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.loads(f.read().strip()[3:-2])
        return d if isinstance(d, dict) and isinstance(d.get("updated"), (int, float)) else None
    except (OSError, ValueError):
        return None


INFO_FLAGS = ("handoff", "tool-limit", "auto-filled", "frontmatter")  # shown as info, not counted as issues (ctx-* too)


def summary(d, now):
    """One lobby row: what the front page shows for a session, small so the index stays light whatever the prompts."""
    ags = d.get("agents") or []
    heroes = [a for a in ags if a.get("kind") != "wf"]
    live = d.get("status") == "live" and now - d["updated"] < LIVE_AGE
    den = d.get("denials") or 0
    return {"id": d.get("id"), "cwd": d.get("cwd"), "live": live, "updated": d["updated"], "planner": d.get("planner"),
            "heroes": len(heroes), "running": sum(bool(a.get("running")) for a in heroes) if live else 0, "workflows": len(ags) - len(heroes),
            "gold": sum((d.get("models") or {}).values()), "usd": (d.get("cost") or {}).get("total"),
            "issues": sum(f not in INFO_FLAGS and not f.startswith("ctx-") for a in ags for f in a.get("flags") or []) + (len(den) if isinstance(den, list) else den),
            "party": [[a.get("tier"), a.get("kind"), bool(a.get("running")) and live, "ignored-limit" in (a.get("flags") or [])] for a in ags[:12]],
            "last": ((d.get("events") or [{}])[-1] or {}).get("text", "")}


def build_index(out_dir=None, now=None):
    """index.html (the viewer) and index.data.js (lobby rows for the LOBBY_LIMIT most recent sessions, newest first), from the <sid>.data.js files.
    shortcut: no lock, concurrent hooks each rebuild from all data files and the last writer is at most one event behind; add an fcntl lock if it shows."""
    out_dir, now = out_dir or OUT_DIR, now or time.time()
    os.makedirs(out_dir, exist_ok=True)
    # "ctxLimit" marks the current data format: files from the pre-package script are skipped (agent-timelines rebuild redoes them)
    side = [d for d in (read_data(p) for p in glob.glob(os.path.join(out_dir, "*.data.js")) if not p.endswith("index.data.js")) if d and "ctxLimit" in d]
    rows = [summary(d, now) for d in sorted(side, key=lambda d: d["updated"], reverse=True)[:LOBBY_LIMIT]]
    write_atomic(os.path.join(out_dir, "index.data.js"), "TL(%s);\n" % js({"index": True, "now": now, "sessions": rows}))
    here = os.path.dirname(__file__)
    with open(os.path.join(here, "viewer.html"), encoding="utf-8") as f:
        write_atomic(os.path.join(out_dir, "index.html"), f.read())
    for name in ASSETS:  # copied only when the contents differ, not on every hook run
        src, dst = os.path.join(here, name if name.endswith(".js") else os.path.join("assets", name)), os.path.join(out_dir, name)
        if not os.path.exists(dst) or not filecmp.cmp(src, dst, shallow=False):
            shutil.copyfile(src, dst + ".%d.tmp" % os.getpid())  # per-process temp: hooks run concurrently
            os.replace(dst + ".%d.tmp" % os.getpid(), dst)


def purge(out_dir, keep, now=None):
    """Delete session files untouched for RETAIN_DAYS (also legacy <sid>.html/.json); never session `keep` or the shared files."""
    now = now or time.time()
    for p in glob.glob(os.path.join(out_dir, "*")):
        b = os.path.basename(p)
        if b.split(".")[0] in ("index", "latest", "viewer", keep) or not re.search(r"\.(data\.js|prompts\.js|html|json)$", b):
            continue
        try:
            if now - os.path.getmtime(p) > RETAIN_DAYS * 86400:
                os.remove(p)
        except OSError:
            pass


def closed_ids(out_dir, sid, event=None, aid=None):
    """Agent ids SubagentStop closed, kept in <sid>.data.js so later rebuilds still know; SubagentStart (a resume) reopens one."""
    ids = {x for x in (read_data(os.path.join(out_dir, sid + ".data.js")) or {}).get("closed", []) if isinstance(x, str)}
    if aid and event == "SubagentStop":
        ids.add(aid)
    elif aid and event == "SubagentStart":
        ids.discard(aid)
    return ids


def publish(d, out_dir=None, closed=()):
    """Write <sid>.data.js (prompts emptied, replies cut to a teaser) and <sid>.prompts.js (the prompts and full replies), rebuild the index, drop expired sessions; returns the session's page."""
    out_dir = out_dir or OUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    prompts = {a["id"]: a["prompt"] for a in d["agents"] if a.get("prompt")}
    replies = {a["id"]: a["reply"] for a in d["agents"] if a.get("reply")}
    if d.get("reply"):
        replies["main"] = d["reply"]
    short = lambda t: " ".join((t or "").split())[:160]  # the data file carries a one-line teaser; replyLen keeps the real length
    slim = dict(d, reply=short(d.get("reply")), agents=[dict(a, prompt="", reply=short(a.get("reply"))) for a in d["agents"]], closed=sorted(closed))
    # prompts first: the data file must never point at prompts that are not on disk yet
    write_atomic(os.path.join(out_dir, d["id"] + ".prompts.js"), "TLP(%s);\n" % js({"id": d["id"], "prompts": prompts, "replies": replies}))
    write_atomic(os.path.join(out_dir, d["id"] + ".data.js"), "TL(%s);\n" % js(slim))
    build_index(out_dir)
    purge(out_dir, d["id"])
    return os.path.join(out_dir, "index.html") + "?sid=" + d["id"]


def find(prefix=None):
    files = glob.glob(os.path.join(PROJECTS, "*", (prefix or "") + "*.jsonl"))
    return sorted(files, key=os.path.getmtime, reverse=True)
