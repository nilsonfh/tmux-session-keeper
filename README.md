# tmux Session Keeper

Manage your [Claude Code](https://claude.com/claude-code) sessions that live in **tmux**, and their **Remote Control**, from a side panel in VS Code.

> Not an official Anthropic product. "Claude" is a trademark of Anthropic, PBC.

Español: [README.es.md](README.es.md)

## Why
Claude Code sessions started in a normal terminal die when you close VS Code or SSH. Running them inside tmux keeps them
alive, but then you juggle `tmux ls`, window indexes, conversation ids and `--remote-control` flags by hand. This
extension puts that in one panel.

## Features
- **Tree view:** systemd services → tmux sessions → windows, with the Remote Control state of each window
  (active, disconnected, taken by another connection, unconfirmed).
- **Duplicate warning:** flags a conversation that is open in more than one process (the cause of Remote Control error 4090).
- **Groups:** organise windows by purpose. A group is a tmux session; choose it when you create a window, move a window to another group (its process keeps running) or rename a group. The restore list remembers each window's group.
- **Open** a window in the integrated terminal.
- **New session / resume** a saved conversation (`--resume`), with or without Remote Control.
- **Reconnect Remote Control** by typing `/remote-control` into a window (asks first).
- **Restore after reboot:** mark windows to be recreated when the server restarts, from any project (each keeps its own directory).
  One command installs a systemd user service for it. No `jq` or `python` needed.
- **Remote Control server:** set up `claude remote-control` as a service that restarts itself if it exits (network loss, etc.)
  and starts at boot, so you can start new sessions from the Claude mobile app or claude.ai/code. One server per project,
  with a first-time assistant for the two questions Claude Code asks, a log viewer and a remove command.
- **Safer stops:** confirmations say what would end, and services that could take every tmux session down with them are flagged and can be fixed in one click.
- **Import running windows** into the restore list. Saved sessions that are not running are listed with the reason when they cannot be restored.
- Start, restart or stop the restore service. Close a window (asks first; the conversation stays saved).

## Requirements
- Linux, with `tmux` and `systemd --user` (restore-on-boot needs systemd; the rest works with tmux alone).
- Claude Code (`claude`) in your `PATH`, or set `tmuxKeeper.claudeBin`.
- VS Code connected to the machine that runs the sessions (local, or Remote-SSH). The extension runs where the sessions are.
- To start at boot without logging in, enable lingering once: `sudo loginctl enable-linger $USER`.
  The extension tells you when this is missing; it never runs `sudo` for you.

## Install
Download the latest `.vsix` from [Releases](https://github.com/nilsonfh/tmux-session-keeper/releases) and install it. Run this in the terminal of the machine that runs your sessions (with Remote-SSH, that is the remote terminal):

    curl -fsSL -o /tmp/tmux-session-keeper.vsix https://github.com/nilsonfh/tmux-session-keeper/releases/latest/download/tmux-session-keeper.vsix \
      && code --install-extension /tmp/tmux-session-keeper.vsix

`code --install-extension` only accepts a local file or a Marketplace id, not a URL, so it is two steps. Each release lists the file's SHA-256 in its notes. To pin a version, use `.../releases/download/vX.Y.Z/tmux-session-keeper-X.Y.Z.vsix`. Then reload the VS Code window.

## Getting started
1. Open the **Session Keeper** panel in the activity bar.
2. Click **+**, pick a conversation (or a new one), name the window.
3. Answer **Yes** to "Restore after reboot?" for sessions you want to survive a restart.
4. Once, run **Session Keeper: Install restore-on-boot service** from the Command Palette (or the panel's `...` menu).
5. To start sessions from your phone, run **Session Keeper: Set up a Remote Control server**. Your `claude` login must be a
   claude.ai account (`claude auth login`); `setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` do not work for Remote Control.

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `tmuxKeeper.tmuxSession` | `claude` | tmux session that holds the windows |
| `tmuxKeeper.projectDir` | open folder | project whose conversations are listed |
| `tmuxKeeper.claudeBin` | from `PATH` | path to `claude` |
| `tmuxKeeper.sessionsFile` | `~/.config/claude-tmux/sessions.json` | restore list |
| `tmuxKeeper.services` | `["claude-tmux-restore"]` | systemd user services to show (only existing ones appear) |
| `tmuxKeeper.serverAutoUpdate` | `false` | run `claude update` each time a server starts (off: updating can change the launcher) |
| `tmuxKeeper.refreshSeconds` | `10` | refresh interval |

## Privacy and safety
- Everything stays on your machine. The extension makes no network calls.
- It reads only the **id, date and title** of conversations in `~/.claude/projects/<project>/*.jsonl` (the last 256 KB of each
  file, to find the title). It does not read credentials.
- It runs `tmux`, `ps`, `systemctl --user` and `loginctl` without a shell. The one command line tmux receives is quoted.
- It writes `~/.config/claude-tmux/sessions.json` (+ a `.list` copy) and, only when you install the service,
  `~/.local/share/claude-tmux/restore-sessions.sh` and `~/.config/systemd/user/claude-tmux-restore.service`; for each
  Remote Control server, `server-<name>.sh` and `claude-rc-<name>.service`, with logs in `~/.local/state/claude-tmux/`.
- The server log viewer shows your restart log and only error-like lines (shortened) of the debug log, because the full
  debug log can contain conversation text.
- Actions that type into or end a session ask for confirmation first.
- Not supported in untrusted workspaces.

## Known limits
- The Remote Control state is **inferred from the last 300 lines of the tmux pane**. If the message has scrolled away it shows
  "unconfirmed", and a future Claude Code version may change the wording. The authoritative view is the Claude app or claude.ai/code.
- Windows opened from the tree share the active window of the same tmux session.
- Stopping a Remote Control server ends the sessions it serves (the conversations stay saved). The extension cannot check
  your login: if it is wrong the server restarts in a loop; use **View log** to see it.
- It depends on the current flags of `claude remote-control` (`--name`, `--verbose`, `--debug-file`).
- Conversation titles depend on Claude Code's local file format, which is not a public API.

## Development
    npm install
    npm test          # compile and run the tests of the pure logic
    npm run package   # build the .vsix
    scripts/release.sh  # publish a GitHub release with both the versioned and the fixed-name .vsix
    code --install-extension tmux-session-keeper-0.4.2.vsix

License: MIT.
