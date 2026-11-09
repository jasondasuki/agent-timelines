# Security policy

agent-timelines reads your local Claude Code transcripts and writes pages that contain prompt text.
It never sends data anywhere, and `agent-timelines serve` listens on 127.0.0.1 only.

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/jasondasuki/agent-timelines/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it and the version (`pip show agent-timelines`).
You should get a first reply within a week.

Of particular interest: anything that lets transcript text run as script in the pages, makes the server
reachable from another machine, or lets the `install` command damage `settings.json`.

## Supported versions

Only the latest release on `main` gets fixes.
