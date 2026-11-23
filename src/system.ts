import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from './core';
import { toList, toGroupList } from './boot';

export interface Cfg {
  tmuxSession: string;
  projectDir: string;
  claudeBin: string | undefined;
  sessionsFile: string;
  services: string[];
}

/** Runs without a shell: arguments are never interpreted. */
export function run(cmd: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: String(stdout), err: String(stderr) }));
  });
}

export const tmux = (args: string[]) => run('tmux', args);

export interface WinInfo { index: number; name: string; pid: number; cmd: string; dead: boolean }

/** "=name" forces an exact match (without it, "claude" also matches "claude-rc"). */
export const exact = (s: string) => `=${s}`;

export async function sessionExists(s: string): Promise<boolean> {
  return (await tmux(['has-session', '-t', exact(s)])).ok;
}

export async function listSessions(): Promise<string[]> {
  const r = await tmux(['list-sessions', '-F', '#{session_name}']);
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

export async function listWindows(session: string): Promise<WinInfo[]> {
  const r = await tmux(['list-windows', '-t', exact(session), '-F',
    '#{window_index}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map(l => {
    const [i, n, p, c, d] = l.split('\t');
    return { index: +i, name: n, pid: +p, cmd: c, dead: d === '1' };
  });
}

/** joined = true une las líneas partidas por el ancho del panel (capture-pane -J). */
/** Moves a window (target "=session:index") to the end of another session, creating it when it does not exist.
 *  The window's process is not touched: tmux only changes where it is listed. */
export async function moveWindowTo(srcTarget: string, dest: string): Promise<{ ok: boolean; err: string }> {
  let placeholder = false;
  if (!(await sessionExists(dest))) {
    // A new session needs a first window; a temporary one is created and removed after the move.
    const r0 = await tmux(['new-session', '-d', '-s', dest, '-n', '.tmp', 'sleep 86400']);
    if (!r0.ok) return { ok: false, err: r0.err.trim() };
    placeholder = true;
  }
  const r = await tmux(['move-window', '-a', '-s', srcTarget, '-t', `${exact(dest)}:{end}`]);
  if (placeholder) {
    const idx = (await listWindows(dest)).find(w => w.name === '.tmp')?.index;
    if (idx !== undefined) await tmux(['kill-window', '-t', `${exact(dest)}:${idx}`]);
  }
  return { ok: r.ok, err: r.err.trim() };
}

export async function capture(session: string, window: string, joined = false): Promise<string> {
  const r = await tmux(['capture-pane', '-p', ...(joined ? ['-J'] : []), '-S', '-300', '-t', `${exact(session)}:${window}`]);
  return r.ok ? r.out : '';
}

export async function psRows(): Promise<core.PsRow[]> {
  const r = await run('ps', ['-eo', 'pid=,ppid=,args=']);
  return r.ok ? core.parsePs(r.out) : [];
}

export async function serviceState(unit: string): Promise<string> {
  const r = await run('systemctl', ['--user', 'is-active', unit]);
  return r.out.trim() || 'unknown';
}

export const serviceAction = (action: 'start' | 'restart' | 'stop', unit: string) =>
  run('systemctl', ['--user', action, unit], 30000);

export interface Conversation { id: string; title: string; mtime: Date }

const TAIL = 256 * 1024;

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Lists the project's conversations: only id, date and title (the full content is not read). */
export function listConversations(projectDir: string, limit = 30): Conversation[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', core.encodeProjectDir(projectDir));
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  return files
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit)
    .map(({ f, mtime }) => {
      const id = f.replace(/\.jsonl$/, '');
      let title: string | undefined;
      try { title = core.extractTitle(readTail(path.join(dir, f), TAIL)); } catch { /* no title */ }
      return { id, title: title ?? '(untitled)', mtime };
    });
}

export function readSessionsFile(file: string): core.SessionsFile {
  try { return core.parseSessionsFile(fs.readFileSync(file, 'utf8')); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { sessions: [] };
    throw e;
  }
}

export function writeSessionsFile(file: string, data: core.SessionsFile): void {
  // Quien guarda sesiones no debe borrar los servidores definidos en el mismo archivo.
  if (data.servers === undefined) {
    try { const prev = readSessionsFile(file).servers; if (prev) data = { ...data, servers: prev }; } catch { /* archivo ilegible: no se conserva nada */ }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  // Plain list copy so the boot script does not depend on jq or python.
  const list = listPath(file);
  fs.writeFileSync(`${list}.tmp`, toList(data.sessions, data.dir ?? ''));
  fs.renameSync(`${list}.tmp`, list);
  const g = groupListPath(file);
  fs.writeFileSync(`${g}.tmp`, toGroupList(data.sessions, data.dir ?? ''));
  fs.renameSync(`${g}.tmp`, g);
}

export const listPath = (jsonFile: string) => jsonFile.replace(/\.json$/, '') + '.list'
export const groupListPath = (jsonFile: string) => jsonFile.replace(/\.json$/, '') + '.groups.list'

/** Working directory of a process (Linux). undefined if it is gone. */
export function procCwd(pid: number): string | undefined {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
}

export function findExe(name: string): string | undefined {
  const isExe = (f: string) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  for (const d of dirs) if (d) { const f = path.join(d, name); if (isExe(f)) return f; }
  return undefined;
}

/** Finds claude: user setting → PATH → usual locations. undefined if not found. */
export function resolveClaudeBin(configured?: string): string | undefined {
  if (configured) { try { fs.accessSync(configured, fs.constants.X_OK); return configured; } catch { return undefined; } }
  return findExe('claude');
}

export function serviceExists(unit: string): Promise<boolean> {
  return run('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', unit]).then(r => r.ok && r.out.trim() === 'loaded');
}

export async function lingerEnabled(): Promise<boolean | undefined> {
  const r = await run('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']);
  return r.ok ? r.out.trim() === 'yes' : undefined;
}

export function defaults(): { sessionsFile: string } {
  return { sessionsFile: path.join(os.homedir(), '.config', 'claude-tmux', 'sessions.json') };
}

export const stateDir = () => path.join(os.homedir(), '.local', 'state', 'claude-tmux');
export const serverScriptPath = (slug: string) => path.join(os.homedir(), '.local', 'share', 'claude-tmux', `server-${slug}.sh`);
export const unitFilePath = (unit: string) => path.join(os.homedir(), '.config', 'systemd', 'user', `${unit}.service`);

/** Últimas `n` líneas de un archivo de texto, o undefined si no existe. */
export function tailLines(file: string, n: number): string | undefined {
  try { return readTail(file, 64 * 1024).split('\n').filter(Boolean).slice(-n).join('\n'); } catch { return undefined; }
}

export async function killModeOf(unit: string): Promise<string> {
  const r = await run('systemctl', ['--user', 'show', '-p', 'KillMode', '--value', unit]);
  return r.ok ? r.out.trim() : '';
}

/** Qué se perdería al parar o quitar `unit`. ownSession = la sesión tmux que esa unidad crea, si crea una. */
export async function impactOf(unit: string, ownSession?: string): Promise<core.Impact> {
  const names = await listSessions();
  const infos: core.TmuxSessionInfo[] = [];
  for (const n of names) infos.push({ name: n, windows: (await listWindows(n)).length });
  return core.describeImpact(await killModeOf(unit), ownSession, infos);
}

/** Añade KillMode=process al archivo de la unidad (solo en ~/.config/systemd/user). */
export function fixKillMode(unit: string): 'fixed' | 'ok' | 'unfixable' {
  const f = unitFilePath(unit);
  let text: string;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return 'unfixable'; }
  if (/^KillMode=process\s*$/m.test(text)) return 'ok';
  const fixed = core.addKillMode(text);
  if (!fixed) return 'unfixable';
  fs.writeFileSync(f, fixed);
  return 'fixed';
}

export function conversationExists(dir: string, id: string): boolean {
  return fs.existsSync(path.join(os.homedir(), '.claude', 'projects', core.encodeProjectDir(dir), `${id}.jsonl`));
}

export function dirExists(d: string): boolean {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}
