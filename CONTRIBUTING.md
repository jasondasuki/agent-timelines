# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```sh
git clone https://github.com/jasondasuki/agent-timelines && cd agent-timelines
uv tool install --force .          # or: pipx install -e .
```

The package has no runtime dependencies. Python 3.9+ and Node 18+ (tests only).

## Before you open a pull request

```sh
python3 tests/test_timeline.py && python3 tests/test_cli.py
node tests/test_dungeon.js && node tests/test_actors.js
```

- Add or update a test for any new logic (parsing, flags, layout, placement).
- Keep the viewer dependency-free and working over `file://`; no external requests.
- Never insert transcript text as HTML: use `textContent` (the tests check for `innerHTML`).
- Map changes must keep the dungeon stable: adding an agent never moves existing rooms.
- New art must be CC0 or similarly permissive; record it in `src/agent_timelines/assets/LICENSES.txt`.
- Try a visual change in the playground: `open dev/dungeon-demo.html`.

## Reporting bugs

Use the bug report template. Please do not paste transcripts or prompts that contain private data.

By contributing you agree that your work is released under the MIT License, and you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
