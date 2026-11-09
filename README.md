# agent-timelines

Live graph of a Claude Code session: which agent spawned which, model and effort requested vs. what ran,
tool calls, weighted token cost, handoffs and Workflow runs. Built from the local transcripts; nothing leaves your machine.

## Install

```sh
uv tool install ~/Documents/personal-repo/agent-timelines   # or: pipx install <path>
agent-timelines install    # adds 6 hooks to ~/.claude/settings.json (backup written next to it)
agent-timelines serve      # opens http://127.0.0.1:8765/index.html
```

Other commands: `open [session-prefix]` (builds and opens one session, no server needed), `list`, `uninstall`.
Tests: `python3 tests/test_timeline.py && python3 tests/test_cli.py`.
For a second Claude config dir: `agent-timelines install --settings ~/.claude-work/settings.json`.

## Config (optional)

`~/.config/agent-timelines/config.json` (or `$AGENT_TIMELINES_CONFIG`). All keys optional:

```json
{
  "out_dir": "~/.claude/agent-timelines",
  "ctx_limit": 200000,
  "tool_limit": 50,
  "brief_limit": 8000,
  "retain_days": 30,
  "handover_dir": "~/.claude/handovers",
  "agents_dir": "~/.claude/agents",
  "guard_text": "Main session does not execute",
  "tiers": {"Explore": "scanner", "Plan": "plan", "general-purpose": "executor"}
}
```

`ctx_limit`, `tool_limit`, `brief_limit`, `guard_text` and `handover_dir` match the hand-off and guard hooks of the author's setup;
without such hooks those flags simply never fire.
