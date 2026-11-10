"""agent-timelines: install the Claude Code hooks, build session data, serve the dashboard."""
import argparse, functools, glob, http.server, json, os, shlex, shutil, subprocess, sys, tempfile, time, urllib.parse, webbrowser
from datetime import datetime

from . import timeline as tl

EVENTS = {"UserPromptSubmit": "", "PostToolUse": "*", "SubagentStart": "", "SubagentStop": "", "Stop": "", "SessionEnd": ""}  # event -> matcher
MARK = "agent_timelines hook"  # every hook command this tool writes contains it
OLD = "agent-timeline.py"  # hooks of the pre-package script, replaced on install
THROTTLE = 3  # s between PostToolUse rebuilds of one session


def detach(*args):
    subprocess.Popen(list(args), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def strip(hooks):
    """Remove this tool's (and the old script's) hook commands; drop groups and events left empty."""
    for ev in list(hooks):
        for g in hooks[ev]:
            g["hooks"] = [h for h in g.get("hooks", []) if not any(m in str(h.get("command", "")) for m in (MARK, OLD))]
        hooks[ev] = [g for g in hooks[ev] if g["hooks"]]
        if not hooks[ev]:
            del hooks[ev]


def edit_settings(path, edit):
    path = os.path.expanduser(path or os.path.join(tl.CLAUDE_DIR, "settings.json"))
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
        bak = "%s.bak-agent-timelines-%s" % (path, time.strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(path, bak)
        print("backup:", bak)
    except FileNotFoundError:
        cfg = {}
        os.makedirs(os.path.dirname(path), exist_ok=True)
    edit(cfg.setdefault("hooks", {}))
    if not cfg["hooks"]:
        del cfg["hooks"]
    tl.write_atomic(path, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    return path


def install(a):
    cmd = "%s -m %s" % (shlex.quote(sys.executable), MARK)  # absolute python: hooks do not get the login PATH

    def edit(hooks):
        strip(hooks)
        for ev, matcher in EVENTS.items():
            hooks.setdefault(ev, []).append(dict({"matcher": matcher} if matcher else {}, hooks=[{"type": "command", "command": cmd}]))
    print("installed %d hooks in %s\nfill the lobby with past sessions: agent-timelines rebuild\nopen the dashboard: agent-timelines serve" % (len(EVENTS), edit_settings(a.settings, edit)))


def uninstall(a):
    print("removed agent-timelines hooks from", edit_settings(a.settings, strip))


def hook(a):
    """Claude Code passes the event JSON on stdin. Never fail the hook, never block it: the rebuild runs detached."""
    try:
        d = json.load(sys.stdin)
        sid, tp, ev = d.get("session_id"), d.get("transcript_path"), d.get("hook_event_name") or ""
        data = os.path.join(tl.OUT_DIR, "%s.data.js" % sid)
        if not sid or not tp or ev == "PostToolUse" and os.path.exists(data) and time.time() - os.path.getmtime(data) < THROTTLE:
            return  # shortcut: the last tool call of a burst may be skipped; Stop/SubagentStop catch up
        detach(sys.executable, "-m", "agent_timelines", "build", tp, "--event", ev, "--closed", d.get("agent_id") or "")
    except Exception:
        pass


def build(a):
    tp = a.transcript.split("/subagents/")[0] + ".jsonl" if "/subagents/" in a.transcript else a.transcript  # subagent events may name their own file
    sid = os.path.basename(tp)[:-6]
    closed = tl.closed_ids(tl.OUT_DIR, sid, a.event, a.closed)
    d = tl.load(tp, closed=closed, ended=a.event == "SessionEnd", event=a.event)
    page = tl.publish(d, closed=closed)
    # No hook fires when a Workflow ends, so while one looks live this re-runs itself every 20s.
    # shortcut: gives up after 30 re-runs (10 min); upgrade if Claude Code adds a workflow-end hook event.
    if a.event and a.recheck < 30 and any(n.get("kind") == "wf" and n["running"] for n in d["agents"]):
        mark = os.path.join(tempfile.gettempdir(), "agent-timeline-%s.recheck" % sid)
        if a.recheck or not os.path.exists(mark) or time.time() - os.path.getmtime(mark) >= 25:  # else another chain is polling
            open(mark, "w").close()
            detach("sh", "-c", 'sleep 20; exec "$@"', "sh", sys.executable, "-m", "agent_timelines", "build", tp, "--event", "Recheck",
                   "--recheck", str(a.recheck + 1))
    return page


def open_(a):
    files = tl.find(a.session)
    if not files:
        sys.exit("no session found")
    page = build(argparse.Namespace(transcript=files[0], event=None, closed=None, recheck=0))
    print(page)
    webbrowser.open("file://" + page)


def rebuild(a):
    """Regenerate data for every transcript touched in the last `days` (fills the lobby on a first install)."""
    files = [f for f in tl.find() if time.time() - os.path.getmtime(f) < a.days * 86400]
    for i, f in enumerate(files, 1):
        try:
            build(argparse.Namespace(transcript=f, event=None, closed=None, recheck=0))
        except Exception as e:  # one unreadable transcript must not stop the rest
            print("skipped %s: %s" % (os.path.basename(f), e))
        if sys.stdout.isatty():  # a live counter in a terminal; captured output gets only the summary
            print("\r%d/%d" % (i, len(files)), end="", flush=True)
    print("\r" if sys.stdout.isatty() else "", end="")
    print("rebuilt %d sessions into %s" % (len(files), tl.OUT_DIR))


def list_(a):
    for p in tl.find()[:20]:
        n = len(glob.glob(os.path.join(p[:-6], "subagents", "*.meta.json")))
        print(os.path.basename(p)[:-6], datetime.fromtimestamp(os.path.getmtime(p)).strftime("%Y-%m-%d %H:%M"), n, "subagents")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_head(self):
        """Serve only same-origin requests: the files hold prompt text and are scripts any other site could include."""
        port = self.server.server_address[1]
        ours = ("127.0.0.1:%d" % port, "localhost:%d" % port)
        ref = self.headers.get("Referer") or ""
        # a top-level page load (typed URL, link from another site, tool-driven browser) exposes nothing: only scripts and fetches could read the data
        nav = self.headers.get("Sec-Fetch-Mode") == "navigate" and self.headers.get("Sec-Fetch-Dest") == "document"
        if self.headers.get("Host") not in ours or not nav and (self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")
                                                                or ref and urllib.parse.urlsplit(ref).netloc not in ours):
            self.send_error(403, "cross-site request refused")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()


def make_server(port, directory=None):
    # 127.0.0.1 only: the pages hold prompt text from your sessions
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=directory or tl.OUT_DIR))


def serve(a):
    tl.build_index()
    srv = make_server(a.port)
    url = "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    print("serving", tl.OUT_DIR, "at", url, "(ctrl-c to stop)")
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    p = argparse.ArgumentParser(prog="agent-timelines", description="Live delegation graph of Claude Code sessions and subagents.")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn, help_ in (("install", install, "add the hooks to Claude Code settings"), ("uninstall", uninstall, "remove the hooks")):
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("--settings", help="settings.json to edit (default: $CLAUDE_CONFIG_DIR or ~/.claude)")
        sp.set_defaults(fn=fn)
    sp = sub.add_parser("serve", help="serve the dashboard on localhost and open it")
    sp.add_argument("--port", type=int, default=8765)
    sp.add_argument("--no-browser", action="store_true")
    sp.set_defaults(fn=serve)
    sp = sub.add_parser("open", help="rebuild one session (newest, or by id prefix) and open it")
    sp.add_argument("session", nargs="?")
    sp.set_defaults(fn=open_)
    sub.add_parser("list", help="list recent sessions").set_defaults(fn=list_)
    sp = sub.add_parser("rebuild", help="regenerate data for recent sessions from their transcripts")
    sp.add_argument("--days", type=float, default=tl.RETAIN_DAYS)
    sp.set_defaults(fn=rebuild)
    sub.add_parser("hook", help="(called by Claude Code) handle one hook event from stdin").set_defaults(fn=hook)
    sp = sub.add_parser("build", help="(called by the hook) rebuild one session's data")
    sp.add_argument("transcript")
    sp.add_argument("--event")
    sp.add_argument("--closed")
    sp.add_argument("--recheck", type=int, default=0)
    sp.set_defaults(fn=build)
    a = p.parse_args(argv)
    a.fn(a)
