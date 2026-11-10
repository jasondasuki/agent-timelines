---
name: dashboard
description: Start the Agent Timelines dashboard (live pixel-art view of Claude Code sessions and subagents) and give the URL. Use when the user asks to open, start or show the agent timelines dashboard, or to backfill past sessions into it.
---

Start the dashboard server in the background (Bash tool, `run_in_background`) and report the URL it prints:

```
PYTHONPATH="${CLAUDE_PLUGIN_ROOT}/src" python3 -m agent_timelines serve --no-browser
```

Sessions are built by the plugin's hooks as they run. To fill the lobby with sessions that ran before the plugin was installed, run once:

```
PYTHONPATH="${CLAUDE_PLUGIN_ROOT}/src" python3 -m agent_timelines rebuild
```

Needs `python3` 3.9 or newer on the PATH.
