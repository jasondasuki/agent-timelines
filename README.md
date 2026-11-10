# agent-timelines

[![CI](https://github.com/jasondasuki/agent-timelines/actions/workflows/ci.yml/badge.svg)](https://github.com/jasondasuki/agent-timelines/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A pixel-art dashboard for Claude Code sessions. It shows which agent spawned which, the model and effort
requested vs. what actually ran, tool calls, weighted token cost, handoffs and Workflow runs, live while the
session works. Everything is read from your local transcripts; nothing leaves your machine.

![Chart view: the delegation tree as a party of heroes, with one hero's detail panel open](docs/chart.jpg)

- **Lobby**: every recent session as a retro game-server list (live dungeons + hall of records).
- **Chart view**: the delegation tree as a party of heroes, with flags for rule breaks (no model set,
  model mismatch, ignored tool limit, unanswered handoff, …).
- **Map view**: the same session as a procedurally generated dungeon. The main session is the guild master
  in the guild hall; each agent has its own room and fights an enemy while it works, then celebrates.

![Lobby: live dungeons and the hall of records](docs/lobby.jpg)
![Map view: a procedurally generated dungeon with one room per agent](docs/map.jpg)

(The screenshots show a synthetic demo session.)

## Install

Needs Python 3.9+ and [uv](https://docs.astral.sh/uv/) (or pipx). No other dependencies. Runs on macOS and Linux; Windows is not supported.

```sh
uv tool install git+https://github.com/jasondasuki/agent-timelines   # or: pipx install git+https://...
agent-timelines install    # adds 6 hooks to ~/.claude/settings.json (writes a backup next to it first)
agent-timelines rebuild    # optional: fills the lobby with your sessions from the last 30 days
agent-timelines serve      # opens http://127.0.0.1:8765/index.html (localhost only)
```

Start or continue a Claude Code session; it appears in the lobby on its first hook event.

| Command | What it does |
|---|---|
| `install [--settings PATH]` | Add the hooks (replaces earlier agent-timelines hooks, keeps all others). |
| `uninstall [--settings PATH]` | Remove the hooks. Your data folder stays. |
| `serve [--port N] [--no-browser]` | Serve the dashboard on 127.0.0.1. |
| `open [SESSION-PREFIX]` | Build one session (newest by default) and open it from disk, no server. |
| `rebuild [--days N]` | Regenerate data for recent sessions from their transcripts. |
| `list` | Recent sessions with their subagent counts. |

`--settings` targets another Claude config dir, e.g. `--settings ~/.claude-work/settings.json`.
`CLAUDE_CONFIG_DIR` is respected for the default paths.

Data lives in `~/.claude/agent-timelines/` (one `<session>.data.js` and one `<session>.prompts.js` per session, removed after 30 days untouched).
The pages hold prompt text from your sessions, which is why `serve` binds to localhost only and refuses requests that come from other sites (wrong `Host`, or a cross-site script or fetch).

## Config (optional)

`~/.config/agent-timelines/config.json` (or `$AGENT_TIMELINES_CONFIG`). Every key is optional:

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
  "tiers": {"Explore": "scanner", "Plan": "plan", "general-purpose": "executor"},
  "rules": {"no-model": true, "no-effort": true}
}
```

`tool_limit` is unset by default, so there are no hearts, only a tool count; set it to the number your hand-off hook uses.
`brief_limit`, `guard_text` and `handover_dir` match optional hand-off and guard hooks of your own;
without such hooks those flags never fire. `tiers` maps agent types to character classes.
`rules` turns single flags on or off by name; a flag you do not list keeps its default. `no-model` and `no-effort` are off by default;
turn them on if your setup requires every spawn to name a model and effort. The flag names are `no-model`, `no-effort`, `auto-filled`,
`frontmatter`, `model-mismatch`, `effort-mismatch`, `ctx` (the context-size flag), `handoff`, `tool-limit`, `ignored-limit`, `orphan`
and `handoff-not-continued`; an unknown name is an error.

## Development

```sh
python3 tests/test_timeline.py && python3 tests/test_cli.py   # Python
node tests/test_dungeon.js && node tests/test_actors.js       # map view (Node 18+)
open dev/dungeon-demo.html                                     # dungeon playground: agents, working, reset
```

## Credits

- Sprites: [Kenney](https://www.kenney.nl) "Tiny Dungeon" and "1-Bit Pack", CC0.
- Font: Press Start 2P by CodeMan38, SIL Open Font License 1.1.

Details in `src/agent_timelines/assets/LICENSES.txt`.

## License

MIT, see [LICENSE](LICENSE). Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
