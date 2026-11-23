import * as vscode from 'vscode';
import * as core from './core';
import * as sys from './system';
import * as boot from './boot';

const t = vscode.l10n.t;

export type Node = ServiceNode | ServerNode | SessionNode | WindowNode | SavedNode | InfoNode;

export class InfoNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class ServiceNode extends vscode.TreeItem {
  constructor(public readonly unit: string, state: string, unsafe: boolean) {
    super(unit, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'service';
    this.description = unsafe ? `${state} · ${t('unsafe to stop')}` : state;
    const ok = state === 'active' && !unsafe;
    this.iconPath = new vscode.ThemeIcon(unsafe ? 'warning' : ok ? 'pass' : 'error',
      new vscode.ThemeColor(unsafe ? 'list.warningForeground' : ok ? 'testing.iconPassed' : 'testing.iconFailed'));
    this.tooltip = unsafe
      ? t('systemd user service {0}: {1}. It does not use KillMode=process: stopping it can end every tmux session. Click the warning notification to fix it.', unit, state)
      : t('systemd user service {0}: {1}', unit, state);
  }
}

export class ServerNode extends vscode.TreeItem {
  readonly unit: string;
  constructor(public readonly def: core.ServerDef, state: string, hasTmux: boolean, unsafe: boolean) {
    super(def.name, vscode.TreeItemCollapsibleState.None);
    this.unit = boot.serverUnitName(def.slug);
    this.contextValue = 'server';
    this.description = [t('phone receiver'), state, hasTmux ? t('running in tmux') : t('no tmux session'), unsafe ? t('unsafe to stop') : ''].filter(Boolean).join(' · ');
    const ok = state === 'active' && hasTmux && !unsafe;
    this.iconPath = new vscode.ThemeIcon(unsafe ? 'warning' : 'radio-tower',
      new vscode.ThemeColor(unsafe ? 'list.warningForeground' : ok ? 'testing.iconPassed' : 'testing.iconFailed'));
    this.tooltip = t('Phone receiver "{0}" for {1} (service {2}). It lets you start NEW sessions from the Claude app or claude.ai/code; it does not hold the windows you open with +.', def.name, def.dir, this.unit);
  }
}

export class SessionNode extends vscode.TreeItem {
  constructor(public readonly session: string, count: number, public readonly isDefault: boolean) {
    super(session, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = isDefault ? 'sessionDefault' : 'session';
    const n = count === 1 ? t('1 window') : t('{0} windows', count);
    this.description = isDefault ? t('{0} · default group', n) : t('{0} · group', n);
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.tooltip = t('Group "{0}" is a tmux session. Windows inside it survive closing VS Code. Move a window to another group from its context menu.', session);
  }
}

export class WindowNode extends vscode.TreeItem {
  constructor(
    public readonly session: string,
    public readonly win: sys.WinInfo,
    public readonly convId: string | undefined,
    public readonly remote: core.RemoteState,
    public readonly duplicated: boolean,
    public readonly persisted: boolean,
    public readonly remoteName: string | undefined,
    public readonly cwd: string | undefined,
    title: string | undefined,
  ) {
    super(win.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'window';
    const parts: string[] = [];
    if (win.dead || win.cmd === 'bash' || win.cmd === 'zsh') parts.push(t('no claude'));
    else parts.push(remoteLabel(remote));
    if (duplicated) parts.push(t('open in 2 places'));
    if (persisted) parts.push(t('restored on reboot'));
    this.description = parts.join(' · ');
    this.iconPath = icon(win, remote, duplicated);
    this.tooltip = new vscode.MarkdownString(
      [`**${win.name}**`, title ? t('Conversation: {0}', title) : '',
       convId ? t('Id: {0}', `\`${convId}\``) : t('Id: unknown (opened without --resume or with the picker)'),
       t('Remote Control: {0}', remoteLabel(remote)),
       duplicated ? '\n' + t('Warning: this conversation is open in more than one process (risk of error 4090).') : ''].filter(Boolean).join('\n\n'));
    this.command = { command: 'tmuxKeeper.open', title: 'Open', arguments: [this] };
  }
}

export class SavedNode extends vscode.TreeItem {
  constructor(public readonly entry: core.SavedSession, public readonly problem: core.SavedProblem | undefined) {
    super(entry.window, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'saved';
    const why = problem === 'no-dir' ? t('its directory does not exist')
      : problem === 'no-conversation' ? t('its conversation is not in that directory') : '';
    this.description = [t('saved, not running'), why].filter(Boolean).join(' · ');
    this.iconPath = new vscode.ThemeIcon(problem ? 'warning' : 'debug-stop',
      new vscode.ThemeColor(problem ? 'list.warningForeground' : 'disabledForeground'));
    this.tooltip = new vscode.MarkdownString([`**${entry.window}**`, t('Id: {0}', `\`${entry.id}\``), entry.dir ? t('Directory: {0}', entry.dir) : '',
      problem ? t('It will not be restored until this is fixed.') : t('It is in the restore list but its window is not open. Use the play button to open it now.')].filter(Boolean).join('\n\n'));
  }
}

function remoteLabel(s: core.RemoteState): string {
  switch (s) {
    case 'connected': return t('remote active');
    case 'disconnected': return t('remote disconnected');
    case 'conflict': return t('remote taken by another connection (4090)');
    default: return t('remote unconfirmed');
  }
}

function icon(w: sys.WinInfo, s: core.RemoteState, dup: boolean): vscode.ThemeIcon {
  const c = (id: string) => new vscode.ThemeColor(id);
  if (w.dead || w.cmd === 'bash' || w.cmd === 'zsh') return new vscode.ThemeIcon('circle-slash', c('disabledForeground'));
  if (dup || s === 'conflict') return new vscode.ThemeIcon('warning', c('list.warningForeground'));
  if (s === 'connected') return new vscode.ThemeIcon('broadcast', c('testing.iconPassed'));
  if (s === 'disconnected') return new vscode.ThemeIcon('debug-disconnect', c('list.errorForeground'));
  return new vscode.ThemeIcon('question', c('descriptionForeground'));
}

export class Provider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private getCfg: () => sys.Cfg) {}

  refresh() { this.emitter.fire(undefined); }

  async getChildren(el?: Node): Promise<Node[]> {
    const cfg = this.getCfg();
    if (!el) {
      const nodes: Node[] = [];
      for (const u of cfg.services) if (await sys.serviceExists(u)) nodes.push(new ServiceNode(u, await sys.serviceState(u), (await sys.killModeOf(u)) !== 'process'));
      let servers: core.ServerDef[] = [];
      try { servers = sys.readSessionsFile(cfg.sessionsFile).servers ?? []; } catch { /* unreadable file */ }
      const serverSessions = new Set(servers.map(v => boot.serverUnitName(v.slug)));
      for (const v of servers) {
        const unit = boot.serverUnitName(v.slug);
        nodes.push(new ServerNode(v, await sys.serviceState(unit), await sys.sessionExists(unit), (await sys.killModeOf(unit)) !== 'process'));
      }
      // The tmux session of a phone receiver only holds its restart loop, so it is not a group of windows.
      const live = (await sys.listSessions()).filter(s => !serverSessions.has(s));
      let saved: core.SavedSession[] = [];
      try { saved = sys.readSessionsFile(cfg.sessionsFile).sessions; } catch { /* unreadable file */ }
      const groups = core.allGroups(cfg.tmuxSession, live, saved, serverSessions);
      // The default group is only listed when it has something to show.
      for (const g of groups) {
        const n = live.includes(g) ? (await sys.listWindows(g)).length : 0;
        if (g === cfg.tmuxSession && n === 0 && !saved.some(s => core.groupOf(s, cfg.tmuxSession) === g)) continue;
        nodes.push(new SessionNode(g, n, g === cfg.tmuxSession));
      }
      if (!nodes.some(x => x instanceof SessionNode)) nodes.push(new InfoNode(t('No tmux sessions. Use + to create one.'), 'circle-outline'));
      return nodes;
    }
    if (el instanceof SessionNode) return this.windows(el.session, cfg);
    return [];
  }

  getTreeItem(el: Node) { return el; }

  private async windows(session: string, cfg: sys.Cfg): Promise<Node[]> {
    const [wins, ps] = await Promise.all([sys.listWindows(session), sys.psRows()]);
    const dups = core.duplicatedIds(ps);
    let saved: core.SavedSession[] = [];
    try { saved = sys.readSessionsFile(cfg.sessionsFile).sessions; } catch { /* unreadable file: reported when saving */ }
    const titles = new Map(sys.listConversations(cfg.projectDir, 200).map(c => [c.id, c.title]));
    const windows = await Promise.all(wins.map(async w => {
      const proc = core.findClaudeUnder(ps, w.pid);
      const id = proc ? core.extractResumeId(proc.args) : undefined;
      const remote = proc ? core.parseRemoteState(await sys.capture(session, String(w.index))) : 'unknown';
      const persisted = saved.some(s => s.window === w.name && core.groupOf(s, cfg.tmuxSession) === session);
      return new WindowNode(session, w, id, remote, !!id && dups.has(id), persisted, proc ? core.extractRemoteName(proc.args) : undefined, proc ? sys.procCwd(proc.pid) : undefined, id ? titles.get(id) : undefined);
    }));
    // Saved sessions whose window is not open: shown with the reason when they could not be restored.
    const extra: Node[] = saved
      .filter(s => core.groupOf(s, cfg.tmuxSession) === session && !wins.some(w => w.name === s.window))
      .map(s => new SavedNode(s, core.checkSaved(s, cfg.projectDir, sys.dirExists, sys.conversationExists)));
    return [...windows, ...extra];
  }
}
