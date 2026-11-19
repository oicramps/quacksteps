# Quacksteps pilot checklist

For teammates trying Quacksteps and for the person running the pilot.

## Install

Follow [Quacksteps for macOS](../README.md#quacksteps-for-macos) in the README. The build is unsigned, so the order matters: move the app to Applications, open it once, then use Open Anyway in System Settings.

## First run

Onboarding runs five checks. All five should be green before you continue.

| Check | If it fails |
| --- | --- |
| Quack server is running | Quit and reopen Quacksteps. If it stays red, run `make mac-uninstall-server`, reopen the app, and report it with diagnostics. |
| GitHub CLI can see polarsteps | Not installed: `brew install gh`. Not logged in: `gh auth login`. Not authorised for SSO: `gh auth refresh -h github.com`, then click Authorize next to polarsteps. |
| git is available | `xcode-select --install`. |
| An agent is ready | Install and log in to Cursor (`cursor-agent login`) or Claude Code. One ready agent is enough. |
| Found a clone | Click **Choose folder…** and pick the folder that holds your clones, or clone a repo there. |

Each failing row shows these steps with a Copy button; click **Re-check** when done.

## What to try in the first week

- **Inbox.** Compare it with GitHub. It should match the review-requested and author lists on github.com/pulls. This is the M2 gate: report any PR that is missing or extra.
- **Start reviewing** on a real PR you have to review anyway.
- **Ask about selected lines** in the diff, at least once with a multi-line selection.
- **Notifications.** You get one for a new review request, when one of your PRs needs you or is ready to merge, when CI fails on your PR, and for new commits on a PR you're reviewing. Check that clicking one opens the right PR tab, and that Settings › Notifications turns each kind off.

## What to report and how

Open **Settings › Server › Copy diagnostics** and paste the result into your report. It removes secrets. Add what you did, what you expected, and what happened instead.

## Pilot metrics

The server logs one `pilot` line per event in `~/.quack/logs/server.log`, as `key=value` pairs:

| Event | Fields |
| --- | --- |
| `review_ready` | `pr`, `ms` (Start reviewing or Update → worktree ready), `sha`, `update` |
| `review_failed` | `pr`, `ms` |
| `labels_ready` | `pr`, `ms` (label job time), `sha`, `files`, `agent_files`, `agent`, `model` |
| `labels_failed` | `pr`, `ms`, `agent`, `model`, `timeout` |
| `ask` | `pr`, `outcome` (`done` or an error code), `ms`, `first_event_ms`, `agent`, `model`, `reviewing`, `follow_up` |

For example: `pilot labels_ready pr=acme/web#4127 ms=21530 sha=a41c9e2 files=12 agent_files=10 agent=cursor`.

To pull them out: `grep ' pilot ' ~/.quack/logs/server.log`.

## Known limits

- The build is unsigned, so the first open needs the steps above.
- Cursor and Claude Code are the only supported agents.
- Quacksteps never posts to GitHub.
- The inbox has no PR size column yet.
