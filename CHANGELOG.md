# Changelog

## 0.6.0
- **Groups:** windows are organised in groups (a group is a tmux session). Pick the group when creating a window with +, move a window to another group from its context menu without restarting its process, and rename a group. The restore-on-boot list remembers each window's group.
- The restore script has a format marker; the extension offers to update an older installed script (it touches no process).
- Importing running windows now covers every group.

## 0.5.0
- **Safer stops:** before stopping, restarting or removing a service or receiver, the confirmation shows what would end (how many tmux sessions and windows). If the service does not use `KillMode=process`, it warns that every tmux session could end and offers to fix it first.
- **Check on startup:** the extension looks for services without `KillMode=process` and offers a one-click fix that edits the unit and reloads systemd without restarting anything. Also available as **Check services for the KillMode risk**.
- **Pre-install checks:** refuses to install when `claude` does not run, or when another `claude remote-control` already serves that folder (Claude Code would reject the second one).
- **Saved sessions that are not running** now show in the panel with the reason (missing directory, conversation not in that directory), with buttons to open one now or remove it from the list.
- **Clearer names:** the tmux group of windows is shown as "Windows", the Remote Control server as "phone receiver", and the receiver's own tmux session is hidden.
- `npm run package` now runs the tests first.

## 0.4.2
- **Fix (important):** the generated services now use `KillMode=process`. Before, stopping or restarting the service that had started the tmux server killed the whole server and every session in it. Services installed with an older version must be reinstalled (or get `KillMode=process` added under `[Service]`).

## 0.4.1
- "View log" now also shows the errors the server prints in its tmux window (for example "This folder is already served by a terminal claude remote-control"), which never reach the debug log. Only lines starting with Error or Warning are shown, because that window also shows conversation text.

## 0.4.0
- Remote Control servers: set up, start, stop, view the log of and remove `claude remote-control` services,
  one per project, with a first-time assistant. They restart themselves if the process exits and start at boot.
- Saving sessions no longer drops the servers stored in the same file.
- Tests check that every text has a Spanish translation.

## 0.3.1
- New icon: stacked terminal windows (one-colour version for the activity bar).

## 0.3.0
- Independent of any one project: no hard-coded paths or service names.
- Finds `claude` in your PATH (or use the `tmuxKeeper.claudeBin` setting).
- New "Install restore-on-boot service" command: creates and enables a systemd user service that
  recreates your saved windows after a reboot. No `jq` or `python` needed.
- Only shows services that actually exist.
- Per-session directory, so sessions from different projects can be restored.
- Import running windows into the restore list.
- English UI with Spanish translation.

## 0.2.0
- Per-session directory and "add running windows" command.

## 0.1.0
- First version: tree of services, tmux sessions and windows with Remote Control state; open, create,
  resume, reconnect, close.
