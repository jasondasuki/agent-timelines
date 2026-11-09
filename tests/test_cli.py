"""python -m pytest tests  (or: python tests/test_cli.py). Install/uninstall keep other hooks and replace old ones."""
import json, os, sys, tempfile
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


if __name__ == "__main__":
    test_install_uninstall()
    print("ok")
