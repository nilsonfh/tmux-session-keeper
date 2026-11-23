import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from './core';
import * as sys from './system';
import * as boot from './boot';
import { Provider, WindowNode, ServiceNode, ServerNode, SavedNode, SessionNode } from './tree';

const t = vscode.l10n.t;

function cfg(): sys.Cfg {
  const c = vscode.workspace.getConfiguration('tmuxKeeper');
  const d = sys.defaults();
  return {
    tmuxSession: c.get<string>('tmuxSession') || 'claude',
    projectDir: c.get<string>('projectDir') || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
    claudeBin: sys.resolveClaudeBin(c.get<string>('claudeBin') || undefined),
    sessionsFile: c.get<string>('sessionsFile') || d.sessionsFile,
    services: c.get<string[]>('services') ?? [boot.UNIT_NAME],
  };
}

const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const target = (n: WindowNode) => `${sys.exact(n.session)}:${n.win.index}`;
const scriptPath = () => path.join(os.homedir(), '.local', 'share', 'claude-tmux', 'restore-sessions.sh');
const unitPath = () => path.join(os.homedir(), '.config', 'systemd', 'user', `${boot.UNIT_NAME}.service`);

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new Provider(cfg);
  ctx.subscriptions.push(vscode.window.createTreeView('tmuxKeeper.sessions', { treeDataProvider: provider }));

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    const s = vscode.workspace.getConfiguration('tmuxKeeper').get<number>('refreshSeconds') ?? 10;
    timer = setInterval(() => provider.refresh(), Math.max(3, s) * 1000);
  };
  schedule();
  ctx.subscriptions.push(
    { dispose: () => timer && clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('tmuxKeeper')) { schedule(); provider.refresh(); } }),
  );

  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const fail = (m: string) => vscode.window.showErrorMessage(`Session Keeper: ${m}`);
  const noClaude = () => fail(t('could not find the "claude" command. Install Claude Code or set "tmuxKeeper.claudeBin".'));

  reg('tmuxKeeper.refresh', () => provider.refresh());

  reg('tmuxKeeper.open', (n?: WindowNode) => {
    if (!n) return;
    const name = `claude: ${n.win.name}`;
    const existing = vscode.window.terminals.find(x => x.name === name);
    if (existing) { existing.show(); return; }
    // ";" as a separate argument separates tmux commands; "=" forces an exact match.
    const term = vscode.window.createTerminal({
      name, shellPath: 'tmux',
      shellArgs: ['attach-session', '-t', sys.exact(n.session), ';', 'select-window', '-t', target(n)],
    });
    term.show();
  });

  reg('tmuxKeeper.new', async () => {
    const c = cfg();
    if (!c.claudeBin) return noClaude();
    const conv = await pickConversation(c);
    if (conv === undefined) return;
    const winName = await vscode.window.showInputBox({
      title: t('tmux window name'), value: conv.id ? slug(conv.title) : '',
      validateInput: v => NAME_RE.test(v) ? undefined : t('Letters, digits, dot, dash and underscore only (max. 40).'),
    });
    if (!winName) return;
    const group = await pickGroup(c);
    if (!group) return;
    const existing = await sys.listWindows(group);
    if (existing.some(w => w.name === winName)) return fail(t('a window named "{0}" already exists in {1}.', winName, group));
    const remote = await vscode.window.showInputBox({
      title: t('Name shown in Remote Control (empty = no Remote Control)'), value: winName,
    });
    if (remote === undefined) return;
    const command = core.buildClaudeCommand(c.claudeBin, { resumeId: conv.id, remoteName: remote || undefined });
    const args = (await sys.sessionExists(group))
      ? ['new-window', '-t', `${sys.exact(group)}:`, '-n', winName, '-c', c.projectDir, command]
      : ['new-session', '-d', '-s', group, '-n', winName, '-c', c.projectDir, command];
    const r = await sys.tmux(args);
    if (!r.ok) return fail(r.err.trim() || t('tmux could not create the window.'));
    if (conv.id) {
      const yes = t('Yes'), no = t('No');
      const pick = await vscode.window.showInformationMessage(t('Window "{0}" created. Restore it automatically after a server reboot?', winName), yes, no);
      if (pick === yes) savePersist(c, { window: winName, id: conv.id, name: remote, dir: c.projectDir, group });
    } else {
      vscode.window.showInformationMessage(t('Window "{0}" created.', winName));
    }
    provider.refresh();
  });

  reg('tmuxKeeper.reconnect', async (n?: WindowNode) => {
    if (!n) return;
    const go = t('Type it');
    const ok = await vscode.window.showWarningMessage(
      t('"/remote-control" will be typed into window "{0}". Only do this if claude is waiting for input, not in the middle of a task.', n.win.name),
      { modal: true }, go);
    if (ok !== go) return;
    const r = await sys.tmux(['send-keys', '-t', target(n), '/remote-control', 'Enter']);
    if (!r.ok) return fail(r.err.trim());
    setTimeout(() => provider.refresh(), 4000);
  });

  reg('tmuxKeeper.togglePersist', (n?: WindowNode) => {
    if (!n) return;
    const c = cfg();
    try {
      const data = sys.readSessionsFile(c.sessionsFile);
      const same = (s: core.SavedSession) => s.window === n.win.name && core.groupOf(s, c.tmuxSession) === n.session;
      if (data.sessions.some(same)) {
        data.sessions = data.sessions.filter(s => !same(s));
        sys.writeSessionsFile(c.sessionsFile, { dir: data.dir ?? c.projectDir, sessions: data.sessions });
        vscode.window.showInformationMessage(t('"{0}" will no longer be restored after a reboot.', n.win.name));
      } else {
        if (!n.convId) return fail(t('this window has no conversation id (it was opened without --resume or with the picker). Close it and create it with "New session".'));
        savePersist(c, { window: n.win.name, id: n.convId, name: n.remoteName ?? n.win.name, dir: n.cwd ?? c.projectDir, group: n.session });
      }
    } catch (e: any) { return fail(e.message); }
    provider.refresh();
  });

  reg('tmuxKeeper.importRunning', async () => {
    const c = cfg();
    let data: core.SessionsFile;
    try { data = sys.readSessionsFile(c.sessionsFile); } catch (e: any) { return fail(e.message); }
    const hidden = new Set((data.servers ?? []).map(v => boot.serverUnitName(v.slug)));
    const ps = await sys.psRows();
    const known = new Set(data.sessions.map(x => `${core.groupOf(x, c.tmuxSession)}\u0000${x.window}`));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const group of (await sys.listSessions()).filter(x => !hidden.has(x))) {
      for (const w of await sys.listWindows(group)) {
        const p = core.findClaudeUnder(ps, w.pid);
        const id = p ? core.extractResumeId(p.args) : undefined;
        if (!p || !id) { if (p) skipped.push(t('{0} (no conversation id)', w.name)); continue; }
        if (known.has(`${group}\u0000${w.name}`)) continue;
        data.sessions.push({ window: w.name, id, name: core.extractRemoteName(p.args) ?? w.name, dir: sys.procCwd(p.pid) ?? c.projectDir, group });
        added.push(group === c.tmuxSession ? w.name : `${group}/${w.name}`);
      }
    }
    if (added.length) sys.writeSessionsFile(c.sessionsFile, { dir: data.dir ?? c.projectDir, sessions: data.sessions });
    const msg = [added.length ? t('Added: {0}.', added.join(', ')) : t('No new windows to add.'),
      skipped.length ? t('Skipped: {0}.', skipped.join('; ')) : ''].filter(Boolean).join(' ');
    vscode.window.showInformationMessage(msg);
    provider.refresh();
  });

  reg('tmuxKeeper.moveToGroup', async (n?: WindowNode) => {
    if (!n) return;
    const c = cfg();
    const dest = await pickGroup(c, n.session);
    if (!dest || dest === n.session) return;
    if ((await sys.listWindows(dest)).some(w => w.name === n.win.name)) return fail(t('a window named "{0}" already exists in {1}.', n.win.name, dest));
    const r = await sys.moveWindowTo(target(n), dest);
    if (!r.ok) return fail(r.err || 'tmux move-window');
    try { // keep the restore list in step with where the window now lives
      const data = sys.readSessionsFile(c.sessionsFile);
      const hit = data.sessions.find(s => s.window === n.win.name && core.groupOf(s, c.tmuxSession) === n.session);
      if (hit) { hit.group = dest; sys.writeSessionsFile(c.sessionsFile, data); }
    } catch (e: any) { fail(e.message); }
    provider.refresh();
  });

  reg('tmuxKeeper.renameGroup', async (g?: SessionNode) => {
    if (!g) return;
    const c = cfg();
    if (g.isDefault) return fail(t('"{0}" is the default group (setting tmuxKeeper.tmuxSession); change that setting instead.', g.session));
    const live = await sys.listSessions();
    const nu = await vscode.window.showInputBox({
      title: t('New name for the group "{0}"', g.session), value: g.session,
      validateInput: v => !core.GROUP_RE.test(v) ? t('Letters, digits, dot, dash and underscore only (max. 40).') : live.includes(v) && v !== g.session ? t('That group already exists.') : undefined,
    });
    if (!nu || nu === g.session) return;
    if (live.includes(g.session)) {
      const r = await sys.tmux(['rename-session', '-t', sys.exact(g.session), nu]);
      if (!r.ok) return fail(r.err.trim() || 'tmux rename-session');
    }
    try {
      const data = sys.readSessionsFile(c.sessionsFile);
      let touched = false;
      for (const s of data.sessions) if (s.group === g.session) { s.group = nu; touched = true; }
      if (touched) sys.writeSessionsFile(c.sessionsFile, data);
    } catch (e: any) { return fail(e.message); }
    provider.refresh();
  });

  reg('tmuxKeeper.startSaved', async (n?: SavedNode) => {
    if (!n) return;
    const c = cfg();
    if (!c.claudeBin) return noClaude();
    if (n.problem === 'no-dir') return fail(t('the directory of "{0}" does not exist.', n.entry.window));
    if (n.problem === 'no-conversation') return fail(t('the conversation of "{0}" is not in its directory, so claude cannot resume it.', n.entry.window));
    const dir = n.entry.dir || sys.readSessionsFile(c.sessionsFile).dir || c.projectDir;
    const command = core.buildClaudeCommand(c.claudeBin, { resumeId: n.entry.id, remoteName: n.entry.name || undefined });
    const grp = core.groupOf(n.entry, c.tmuxSession);
    const args = (await sys.sessionExists(grp))
      ? ['new-window', '-t', `${sys.exact(grp)}:`, '-n', n.entry.window, '-c', dir, command]
      : ['new-session', '-d', '-s', grp, '-n', n.entry.window, '-c', dir, command];
    const r = await sys.tmux(args);
    if (!r.ok) return fail(r.err.trim() || t('tmux could not create the window.'));
    provider.refresh();
  });

  reg('tmuxKeeper.removeSaved', async (n?: SavedNode) => {
    if (!n) return;
    const go = t('Remove from list');
    const ok = await vscode.window.showWarningMessage(t('Remove "{0}" from the restore list? Its conversation stays saved.', n.entry.window), { modal: true }, go);
    if (ok !== go) return;
    const c = cfg();
    try {
      const data = sys.readSessionsFile(c.sessionsFile);
      sys.writeSessionsFile(c.sessionsFile, { ...data, sessions: data.sessions.filter(s => !(s.window === n.entry.window && core.groupOf(s, c.tmuxSession) === core.groupOf(n.entry, c.tmuxSession))) });
    } catch (e: any) { return fail(e.message); }
    provider.refresh();
  });

  reg('tmuxKeeper.checkUnits', () => diagnose(true));
  ctx.subscriptions.push({ dispose: () => clearTimeout(diagTimer) });
  const diagTimer = setTimeout(() => diagnose(false), 4000);

  /** Looks for services that would take every tmux session down with them, and offers to fix them. */
  async function diagnose(announce: boolean) {
    const c = cfg();
    await checkRestoreScript(c);
    const units = new Set<string>();
    for (const u of c.services) if (await sys.serviceExists(u)) units.add(u);
    try { for (const s of sys.readSessionsFile(c.sessionsFile).servers ?? []) units.add(boot.serverUnitName(s.slug)); } catch { /* unreadable file */ }
    const bad: string[] = [];
    for (const u of units) if ((await sys.killModeOf(u)) !== 'process') bad.push(u);
    if (!bad.length) { if (announce) vscode.window.showInformationMessage(t('All services use KillMode=process. Stopping one will not end other tmux sessions.')); return; }
    const fix = t('Fix');
    const pick = await vscode.window.showWarningMessage(
      t('These services do not use KillMode=process, so stopping or restarting one can end every tmux session: {0}.', bad.join(', ')), fix);
    if (pick !== fix) return;
    const done: string[] = [], failed: string[] = [];
    for (const u of bad) (sys.fixKillMode(u) === 'unfixable' ? failed : done).push(u);
    await sys.run('systemctl', ['--user', 'daemon-reload'], 30000);
    provider.refresh();
    vscode.window.showInformationMessage([done.length ? t('Fixed: {0}. No process was restarted.', done.join(', ')) : '', failed.length ? t('Could not fix: {0}.', failed.join(', ')) : ''].filter(Boolean).join(' '));
  }

  /** An installed restore script from an older version does not know groups: offer to regenerate it (touches no process). */
  async function checkRestoreScript(c: sys.Cfg) {
    let text: string;
    try { text = fs.readFileSync(scriptPath(), 'utf8'); } catch { return; }
    if (boot.scriptFormat(text) >= boot.RESTORE_FORMAT || !c.claudeBin) return;
    const upd = t('Update');
    const pick = await vscode.window.showWarningMessage(t('The restore-on-boot script comes from an older version and does not know groups: after a reboot every window would go to the default group. Update it?'), upd);
    if (pick !== upd) return;
    try {
      const data = sys.readSessionsFile(c.sessionsFile);
      sys.writeSessionsFile(c.sessionsFile, { dir: data.dir ?? c.projectDir, sessions: data.sessions });
      fs.writeFileSync(scriptPath(), boot.renderRestoreScript({ claudeBin: c.claudeBin, tmuxSession: c.tmuxSession, listFile: sys.groupListPath(c.sessionsFile) }), { mode: 0o755 });
    } catch (e: any) { return fail(e.message); }
    vscode.window.showInformationMessage(t('Restore script updated. No process was restarted.'));
  }

  /** Shows what stopping/removing `unit` would end, and asks. For an unsafe unit it offers to fix it first. */
  async function confirmImpact(unit: string, ownSession: string | undefined, verb: string, intro: string): Promise<boolean> {
    const im = await sys.impactOf(unit, ownSession);
    const detail = im.high
      ? t('Warning: this service does not use KillMode=process. If it started the tmux server, this ends ALL tmux sessions ({0} sessions, {1} windows). Fix it first.', im.totalSessions, im.totalWindows)
      : im.ownSession
        ? t('This ends the tmux session "{0}" ({1} windows). Your other tmux sessions and their windows are not affected.', im.ownSession, im.ownWindows)
        : t('No tmux session is ended; the open windows stay as they are.');
    const buttons = im.high ? [t('Fix first'), t('Continue anyway')] : [verb];
    const pick = await vscode.window.showWarningMessage(intro, { modal: true, detail }, ...buttons);
    if (pick === t('Fix first')) {
      const r = sys.fixKillMode(unit);
      await sys.run('systemctl', ['--user', 'daemon-reload'], 30000);
      vscode.window.showInformationMessage(r === 'unfixable' ? t('Could not fix {0}.', unit) : t('Fixed {0}. Run the action again.', unit));
      return false;
    }
    return pick === verb || pick === t('Continue anyway');
  }

  reg('tmuxKeeper.closeWindow', async (n?: WindowNode) => {
    if (!n) return;
    const go = t('Close window');
    const ok = await vscode.window.showWarningMessage(
      t('Window "{0}" will be closed and its claude process ended. The conversation stays saved and can be resumed.', n.win.name),
      { modal: true }, go);
    if (ok !== go) return;
    const r = await sys.tmux(['kill-window', '-t', target(n)]);
    if (!r.ok) return fail(r.err.trim());
    provider.refresh();
  });

  reg('tmuxKeeper.installBoot', async () => {
    const c = cfg();
    if (!c.claudeBin) return noClaude();
    const tmuxBin = sys.findExe('tmux');
    if (!tmuxBin) return fail(t('tmux is not installed.'));
    const pre = await preflight(c);
    if (pre.blockers.length) return void vscode.window.showErrorMessage(`Session Keeper: ${pre.blockers.join(' ')}`, { modal: true });
    const go = t('Install');
    const ok = await vscode.window.showInformationMessage(
      t('Install the restore-on-boot service?'),
      { modal: true, detail: [t('Creates {0} and {1}, then enables the user service "{2}". It does not start or stop any session now. Sessions are read from {3}.', scriptPath(), unitPath(), boot.UNIT_NAME, c.sessionsFile), ...pre.notes].join('\n\n') },
      go);
    if (ok !== go) return;
    try {
      const data = sys.readSessionsFile(c.sessionsFile);
      sys.writeSessionsFile(c.sessionsFile, { dir: data.dir ?? c.projectDir, sessions: data.sessions });
      fs.mkdirSync(path.dirname(scriptPath()), { recursive: true });
      fs.writeFileSync(scriptPath(), boot.renderRestoreScript({ claudeBin: c.claudeBin, tmuxSession: c.tmuxSession, listFile: sys.groupListPath(c.sessionsFile) }), { mode: 0o755 });
      fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
      fs.writeFileSync(unitPath(), boot.renderUnit({
        scriptPath: scriptPath(),
        pathDirs: [path.dirname(c.claudeBin), path.dirname(tmuxBin), '/usr/local/bin', '/usr/bin', '/bin'],
      }));
    } catch (e: any) { return fail(e.message); }
    for (const args of [['daemon-reload'], ['enable', boot.UNIT_NAME]]) {
      const r = await sys.run('systemctl', ['--user', ...args], 30000);
      if (!r.ok) return fail(r.err.trim() || `systemctl --user ${args.join(' ')}`);
    }
    provider.refresh();
    const notes: string[] = [t('Service installed.')];
    if (await sys.serviceExists('claude-sessions')) notes.push(t('A "claude-sessions" service also exists; both are safe together because existing windows are never touched.'));
    await lingerHint(notes);
  });

  reg('tmuxKeeper.serverSetup', async () => {
    const c = cfg();
    if (!c.claudeBin) return noClaude();
    const tmuxBin = sys.findExe('tmux');
    if (!tmuxBin) return fail(t('tmux is not installed.'));
    let data: core.SessionsFile;
    try { data = sys.readSessionsFile(c.sessionsFile); } catch (e: any) { return fail(e.message); }
    const servers = data.servers ?? [];

    const dirIn = await vscode.window.showInputBox({
      title: t('Project directory for the Remote Control server'), value: c.projectDir,
      validateInput: v => {
        const r = path.resolve(v || '');
        if (r === os.homedir()) return t('Do not use your home directory; pick a project folder.');
        try { return fs.statSync(r).isDirectory() ? undefined : t('That is not a directory.'); } catch { return t('That directory does not exist.'); }
      },
    });
    if (!dirIn) return;
    const dir = path.resolve(dirIn);
    const pre = await preflight(c, dir, servers);
    if (pre.blockers.length) return void vscode.window.showErrorMessage(`Session Keeper: ${pre.blockers.join(' ')}`, { modal: true });
    const name = await vscode.window.showInputBox({ title: t('Name shown in Remote Control'), value: path.basename(dir), validateInput: v => v.trim() ? undefined : t('A name is required.') });
    if (!name) return;

    const taken = new Set(servers.map(s => s.slug));
    const base = core.slugify(name);
    let slug = core.uniqueSlug(base, taken);
    while (fs.existsSync(sys.unitFilePath(boot.serverUnitName(slug)))) { taken.add(slug); slug = core.uniqueSlug(base, taken); }
    const unit = boot.serverUnitName(slug);

    const open = t('Open terminal'), done = t('Already done');
    const first = await vscode.window.showInformationMessage(
      t('First time in this folder?'),
      { modal: true, detail: t('Claude Code asks two questions the first time: "Trust this directory?" and "Enable Remote Control?". Answer y to both, wait for the session URL, then press Ctrl+C. Your claude login must be a claude.ai account (claude auth login), not a setup-token. Skip this if you already did it for this folder.') },
      open, done);
    if (!first) return;
    if (first === open) {
      const term = vscode.window.createTerminal({ name: t('claude remote-control (first-time setup)'), cwd: dir });
      term.show();
      term.sendText(`${core.shQuote(c.claudeBin)} remote-control`);
      const go = t('Continue');
      const cont = await vscode.window.showInformationMessage(
        t('Answer the two questions, wait for the URL, press Ctrl+C in that terminal, then continue.'),
        { modal: true, detail: t('If the process is still running when the service starts, the two would compete for the same folder.') }, go);
      if (cont !== go) return;
    }

    const script = sys.serverScriptPath(slug), unitFile = sys.unitFilePath(unit);
    const install = t('Install and start');
    const ok = await vscode.window.showInformationMessage(
      t('Install the Remote Control server "{0}"?', name),
      { modal: true, detail: [t('Creates {0} and {1}, enables the user service "{2}" and starts it now in the tmux session "{2}". Logs go to {3}.', script, unitFile, unit, sys.stateDir()), ...pre.notes].join('\n\n') },
      install);
    if (ok !== install) return;
    try {
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, boot.renderServerScript({
        claudeBin: c.claudeBin, name, dir, logDir: sys.stateDir(), slug,
        autoUpdate: vscode.workspace.getConfiguration('tmuxKeeper').get<boolean>('serverAutoUpdate') ?? false,
      }), { mode: 0o755 });
      fs.mkdirSync(path.dirname(unitFile), { recursive: true });
      fs.writeFileSync(unitFile, boot.renderServerUnit({
        tmuxBin, session: unit, scriptPath: script, slug,
        pathDirs: [path.dirname(c.claudeBin), path.dirname(tmuxBin), '/usr/local/bin', '/usr/bin', '/bin'],
      }));
      sys.writeSessionsFile(c.sessionsFile, { ...data, servers: [...servers, { name, dir, slug }] });
    } catch (e: any) { return fail(e.message); }
    for (const args of [['daemon-reload'], ['enable', '--now', unit]]) {
      const r = await sys.run('systemctl', ['--user', ...args], 30000);
      if (!r.ok) return fail(r.err.trim() || `systemctl --user ${args.join(' ')}`);
    }
    provider.refresh();
    await lingerHint([t('Server "{0}" is running.', name), t('It restarts itself if it exits; use "View log" to see why.')]);
  });

  reg('tmuxKeeper.serverLog', async (n?: ServerNode) => {
    if (!n) return;
    const dir = sys.stateDir();
    const restarts = sys.tailLines(path.join(dir, `${n.def.slug}-restarts.log`), 40);
    // The debug log can contain conversation text, so only error-like lines are shown, shortened.
    const dbg = sys.tailLines(path.join(dir, `${n.def.slug}-debug.log`), 2000)?.split('\n')
      .filter(l => /\[ERROR\]|\bFATAL\b|EAI_AGAIN|not found|unauthor|expired/i.test(l)).slice(-15).map(l => l.slice(0, 220)).join('\n');
    const paneErrors = core.extractPaneErrors(await sys.capture(n.unit, '0', true));
    const body = [
      t('Server "{0}" ({1})', n.def.name, n.unit), '',
      t('Restarts (last 40):'), restarts ?? t('(none yet)'), '',
      t('Recent errors from the debug log (shortened):'), dbg || t('(none)'), '',
      t('Errors printed by the server in its tmux window:'), paneErrors.length ? paneErrors.join('\n') : t('(none)'), '',
      t('Full logs: {0}', dir), t('Service log: journalctl --user -u {0}', n.unit),
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ content: body, language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg('tmuxKeeper.serverRemove', async (n?: ServerNode) => {
    if (!n) return;
    if (!(await confirmImpact(n.unit, n.unit, t('Remove'), t('Stop and remove the phone receiver "{0}"? The sessions started from the phone end; the conversations stay saved. Logs are kept.', n.def.name)))) { provider.refresh(); return; }
    await sys.run('systemctl', ['--user', 'stop', n.unit], 30000);
    await sys.run('systemctl', ['--user', 'disable', n.unit], 30000);
    for (const f of [sys.unitFilePath(n.unit), sys.serverScriptPath(n.def.slug)]) { try { fs.rmSync(f, { force: true }); } catch { /* already gone */ } }
    await sys.run('systemctl', ['--user', 'daemon-reload'], 30000);
    try {
      const c = cfg();
      const data = sys.readSessionsFile(c.sessionsFile);
      sys.writeSessionsFile(c.sessionsFile, { ...data, servers: (data.servers ?? []).filter(s => s.slug !== n.def.slug) });
    } catch (e: any) { return fail(e.message); }
    provider.refresh();
  });

  reg('tmuxKeeper.uninstallBoot', async () => {
    const go = t('Uninstall');
    const ok = await vscode.window.showWarningMessage(
      t('Remove the restore-on-boot service? Running sessions and your saved list are not touched.'), { modal: true }, go);
    if (ok !== go) return;
    await sys.run('systemctl', ['--user', 'disable', boot.UNIT_NAME], 30000);
    for (const f of [unitPath(), scriptPath()]) { try { fs.rmSync(f, { force: true }); } catch { /* already gone */ } }
    await sys.run('systemctl', ['--user', 'daemon-reload'], 30000);
    vscode.window.showInformationMessage(t('Service removed.'));
    provider.refresh();
  });

  for (const [id, action] of [['serviceStart', 'start'], ['serviceRestart', 'restart'], ['serviceStop', 'stop']] as const) {
    reg(`tmuxKeeper.${id}`, async (n?: ServiceNode | ServerNode) => {
      if (!n) return;
      if (action !== 'start') {
        const intro = action === 'restart' ? t('Restart {0}?', n.unit) : t('Stop {0}?', n.unit);
        if (!(await confirmImpact(n.unit, n instanceof ServerNode ? n.unit : undefined, action === 'restart' ? t('Restart') : t('Stop'), intro))) { provider.refresh(); return; }
      }
      const r = await sys.serviceAction(action, n.unit);
      if (!r.ok) fail(r.err.trim() || `systemctl ${action} ${n.unit}`);
      provider.refresh();
    });
  }
}

/** Checks before installing something. Blockers stop the install; notes are shown in the confirmation. */
async function preflight(c: sys.Cfg, dir?: string, servers: core.ServerDef[] = []): Promise<{ blockers: string[]; notes: string[] }> {
  const blockers: string[] = [], notes: string[] = [];
  if (!c.claudeBin || !(await sys.run(c.claudeBin, ['--version'], 10000)).ok) blockers.push(t('"claude" does not run. Check the "tmuxKeeper.claudeBin" setting.'));
  if (dir) {
    const other = servers.find(s => path.resolve(s.dir) === dir);
    if (other) blockers.push(t('"{0}" already is the Remote Control server of {1}.', other.name, dir));
    const live = core.findServingProcess(await sys.psRows(), dir, sys.procCwd);
    if (live) blockers.push(t('Another claude remote-control (pid {0}) already serves {1}. Stop it first, or Claude Code will reject the new one.', live.pid, dir));
  }
  if ((await sys.lingerEnabled()) === false) notes.push(t('Lingering is off: it will start after you log in, not at boot. Afterwards you will be shown how to enable it.'));
  return { blockers, notes };
}

/** Shows the notes and, if lingering is off, how to enable it (the extension never runs sudo). */
async function lingerHint(notes: string[]): Promise<void> {
  if ((await sys.lingerEnabled()) === false) {
    const user = os.userInfo().username;
    const copy = t('Copy command');
    const pick = await vscode.window.showWarningMessage(
      [...notes, t('To start it at boot without logging in, run once: sudo loginctl enable-linger {0}', user)].join(' '), copy);
    if (pick === copy) await vscode.env.clipboard.writeText(`sudo loginctl enable-linger ${user}`);
  } else {
    vscode.window.showInformationMessage(notes.join(' '));
  }
}

export function deactivate() { /* the interval is released through subscriptions */ }

function slug(s: string): string {
  const v = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return v || 'session';
}

function savePersist(c: sys.Cfg, s: core.SavedSession) { // group is part of the key
  const data = sys.readSessionsFile(c.sessionsFile);
  data.sessions = data.sessions.filter(x => !(x.window === s.window && core.groupOf(x, c.tmuxSession) === core.groupOf(s, c.tmuxSession))).concat(s);
  sys.writeSessionsFile(c.sessionsFile, { dir: data.dir ?? c.projectDir, sessions: data.sessions });
  vscode.window.showInformationMessage(t('"{0}" will be restored after a reboot (if the restore service is installed).', s.window));
}

/** Asks for a group (tmux session): an existing one or a new one. `exclude` hides the current group when moving. */
async function pickGroup(c: sys.Cfg, exclude?: string): Promise<string | undefined> {
  let servers: core.ServerDef[] = [], saved: core.SavedSession[] = [];
  try { const d = sys.readSessionsFile(c.sessionsFile); servers = d.servers ?? []; saved = d.sessions; } catch { /* unreadable file */ }
  const hidden = new Set(servers.map(v => boot.serverUnitName(v.slug)));
  const live = await sys.listSessions();
  const groups = core.allGroups(c.tmuxSession, live, saved, hidden).filter(g => g !== exclude);
  type Item = vscode.QuickPickItem & { group?: string; isNew?: boolean };
  const items: Item[] = groups.map(g => ({ label: g, description: g === c.tmuxSession ? t('default group') : undefined, group: g }));
  items.push({ label: t('$(add) New group…'), isNew: true });
  const pick = await vscode.window.showQuickPick(items, { title: t('Group for this window') });
  if (!pick) return undefined;
  if (!pick.isNew) return pick.group;
  const name = await vscode.window.showInputBox({
    title: t('Name of the new group'),
    validateInput: v => !core.GROUP_RE.test(v) ? t('Letters, digits, dot, dash and underscore only (max. 40).')
      : hidden.has(v) ? t('That name belongs to a phone receiver.') : groups.includes(v) || v === exclude ? t('That group already exists.') : undefined,
  });
  return name || undefined;
}

/** undefined = cancelled; {} = new conversation; {id,title} = resume. */
async function pickConversation(c: sys.Cfg): Promise<{ id?: string; title: string } | undefined> {
  type Item = vscode.QuickPickItem & { conv?: { id?: string; title: string } };
  const items: Item[] = [{ label: t('$(add) New conversation'), conv: { title: 'new' } }];
  for (const v of sys.listConversations(c.projectDir)) {
    items.push({ label: v.title, description: v.mtime.toLocaleString(), detail: v.id, conv: { id: v.id, title: v.title } });
  }
  const pick = await vscode.window.showQuickPick(items, { title: t('Conversation to open'), matchOnDetail: true });
  return pick?.conv;
}
