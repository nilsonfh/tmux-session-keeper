// Pure logic (no vscode, no processes) so it can be tested with node --test.

export type RemoteState = 'connected' | 'disconnected' | 'conflict' | 'unknown';

/** Infers the Remote Control state from the recent text of a tmux pane.
 *  It is a heuristic: the message that appears LOWEST (the most recent) wins. */
export function parseRemoteState(paneText: string): RemoteState {
  const lines = paneText.split('\n');
  let state: RemoteState = 'unknown';
  for (const raw of lines) {
    const l = raw.toLowerCase();
    if (l.includes('another connection took over') || l.includes('code 4090')) state = 'conflict';
    else if (l.includes('remote control disconnected')) state = 'disconnected';
    else if (l.includes('/remote-control is active') || l.includes('remote control active') || l.includes('· connected ·')) state = 'connected';
  }
  return state;
}

/** Last title (customTitle or aiTitle) inside a chunk of a .jsonl transcript. */
export function extractTitle(chunk: string): string | undefined {
  const re = /"(?:customTitle|aiTitle)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(chunk)) !== null) last = m[1];
  if (last === undefined) return undefined;
  try { return JSON.parse(`"${last}"`); } catch { return last; }
}

/** Claude stores conversations in ~/.claude/projects/<path with every non-alphanumeric char → "-">. */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Quotes an argument for a POSIX shell (tmux runs the command with sh -c). */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeCommand(bin: string, opts: { resumeId?: string; remoteName?: string }): string {
  const parts = [shQuote(bin)];
  if (opts.resumeId) parts.push('--resume', shQuote(opts.resumeId));
  if (opts.remoteName) parts.push('--remote-control', shQuote(opts.remoteName));
  return parts.join(' ');
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Conversation id from the command line of a claude process. */
export function extractResumeId(args: string): string | undefined {
  const m = /--(?:resume|session-id)[ =]+(\S+)/.exec(args);
  if (!m) return undefined;
  return UUID.test(m[1]) ? m[1].toLowerCase() : undefined;
}

/** Name given to --remote-control (quoted or not) in a claude command line. */
export function extractRemoteName(args: string): string | undefined {
  const m = /--remote-control[ =]+(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(args);
  const v = m && (m[1] ?? m[2] ?? m[3]);
  return v && !v.startsWith('--') ? v : undefined;
}

export interface PsRow { pid: number; ppid: number; args: string }

export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], args: m[3] });
  }
  return rows;
}

/** Only the executable (first token) counts: a `bash -c "...claude..."` is not a claude process. */
export const isClaude = (args: string): boolean => {
  const exe = args.split(' ')[0];
  return /(^|\/)claude$/.test(exe) || /\/claude\/versions\/[\d.]+$/.test(exe);
};

/** The `claude` process that is the pane's own pid (window created with a command) or one of its descendants. */
export function findClaudeUnder(rows: PsRow[], rootPid: number): PsRow | undefined {
  const self = rows.find(r => r.pid === rootPid);
  if (self && isClaude(self.args)) return self;
  const kids = new Map<number, PsRow[]>();
  for (const r of rows) (kids.get(r.ppid) ?? kids.set(r.ppid, []).get(r.ppid)!).push(r);
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of kids.get(p) ?? []) {
      if (isClaude(c.args)) return c;
      stack.push(c.pid);
    }
  }
  return undefined;
}

/** Conversation ids open in more than one claude process (risk of error 4090). */
export function duplicatedIds(rows: PsRow[]): Set<string> {
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!isClaude(r.args)) continue;
    const id = extractResumeId(r.args);
    if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
}

/** Líneas de error que imprime el servidor en su ventana tmux (por ejemplo "Error: This folder is already served...").
 *  El panel también muestra texto de conversaciones, así que solo se aceptan líneas que EMPIEZAN por Error/Warning,
 *  sin repetidos consecutivos, abreviadas, y se devuelven las últimas `max`. Usar con la salida de `capture-pane -J`. */
export function extractPaneErrors(pane: string, max = 5, width = 200): string[] {
  const out: string[] = [];
  for (const raw of pane.split('\n')) {
    const l = raw.trim();
    if (!/^(Error|Warning)\b/i.test(l)) continue;
    const short = l.length > width ? l.slice(0, width) + '…' : l;
    if (out[out.length - 1] !== short) out.push(short);
  }
  return out.slice(-max);
}

export interface TmuxSessionInfo { name: string; windows: number }
export interface Impact {
  /** true = parar la unidad puede matar el servidor tmux entero (la unidad no usa KillMode=process) */
  high: boolean;
  ownSession?: string; ownWindows: number;
  totalSessions: number; totalWindows: number;
}

/** Qué se perdería al parar o quitar una unidad. `ownSession` es la sesión tmux que ella misma creó (si crea una). */
export function describeImpact(killMode: string, ownSession: string | undefined, sessions: TmuxSessionInfo[]): Impact {
  const own = ownSession ? sessions.find(s => s.name === ownSession) : undefined;
  return {
    high: killMode !== 'process',
    ownSession: own?.name, ownWindows: own?.windows ?? 0,
    totalSessions: sessions.length, totalWindows: sessions.reduce((n, s) => n + s.windows, 0),
  };
}

/** Devuelve el texto de la unidad con KillMode=process, o undefined si ya lo tenía o no se puede arreglar. */
export function addKillMode(unit: string): string | undefined {
  if (/^KillMode=process\s*$/m.test(unit)) return undefined;
  if (/^KillMode=/m.test(unit)) return unit.replace(/^KillMode=.*$/m, 'KillMode=process');
  const m = /^\[Service\]\s*$/m.exec(unit);
  if (!m) return undefined;
  const at = m.index + m[0].length;
  return unit.slice(0, at) + '\nKillMode=process' + unit.slice(at);
}

/** Proceso `claude remote-control` (servidor) que ya sirve ese directorio. cwdOf devuelve el cwd de un pid. */
export function findServingProcess(rows: PsRow[], dir: string, cwdOf: (pid: number) => string | undefined): PsRow | undefined {
  return rows.find(r => isClaude(r.args) && /(^|\s)remote-control(\s|$)/.test(r.args) && !/--resume/.test(r.args) && cwdOf(r.pid) === dir);
}

export type SavedProblem = 'no-dir' | 'no-conversation';

/** ¿Por qué una sesión guardada no podría abrirse? undefined = nada que objetar. */
export function checkSaved(s: { id: string; dir?: string }, fallbackDir: string,
  dirExists: (d: string) => boolean, convExists: (dir: string, id: string) => boolean): SavedProblem | undefined {
  const dir = s.dir || fallbackDir;
  if (!dirExists(dir)) return 'no-dir';
  if (!convExists(dir, s.id)) return 'no-conversation';
  return undefined;
}

/** group = nombre de la sesión tmux donde vive la ventana. Vacío = el grupo por defecto del ajuste tmuxSession. */
export interface SavedSession { window: string; id: string; name: string; dir?: string; group?: string }

export const GROUP_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** Grupo efectivo de una sesión guardada. */
export const groupOf = (s: { group?: string }, def: string): string => s.group || def;

/** Grupos conocidos: sesiones tmux (sin las de receptores) + los de la lista guardada, el grupo por defecto primero. */
export function allGroups(def: string, tmuxSessions: string[], saved: { group?: string }[], hidden: Set<string>): string[] {
  const out = new Set<string>([def]);
  for (const s of tmuxSessions) if (!hidden.has(s)) out.add(s);
  for (const s of saved) out.add(groupOf(s, def));
  return [...out];
}
export interface ServerDef { name: string; dir: string; slug: string }
export interface SessionsFile { dir?: string; sessions: SavedSession[]; servers?: ServerDef[] }

/** Identificador seguro para nombres de unidad systemd y de sesión tmux. */
export function slugify(s: string): string {
  const v = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return v || 'server';
}

/** Primer slug libre: base, base-2, base-3... */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function parseSessionsFile(text: string): SessionsFile {
  const j = JSON.parse(text);
  const sessions: SavedSession[] = Array.isArray(j.sessions) ? j.sessions : [];
  for (const s of sessions) {
    if (typeof s.window !== 'string' || typeof s.id !== 'string' || typeof s.name !== 'string') {
      throw new Error('sessions.json: every session needs window, id and name (strings)');
    }
    if (s.dir !== undefined && typeof s.dir !== 'string') throw new Error('sessions.json: dir must be a string');
    if (s.group !== undefined && (typeof s.group !== 'string' || (s.group !== '' && !GROUP_RE.test(s.group)))) throw new Error('sessions.json: group must be letters, digits, dot, dash or underscore');
  }
  let servers: ServerDef[] | undefined;
  if (j.servers !== undefined) {
    if (!Array.isArray(j.servers)) throw new Error('sessions.json: servers must be a list');
    servers = j.servers;
    for (const v of servers!) {
      if (typeof v.name !== 'string' || typeof v.dir !== 'string' || typeof v.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(v.slug)) {
        throw new Error('sessions.json: every server needs name, dir and a slug of lowercase letters, digits and dashes');
      }
    }
  }
  return { dir: typeof j.dir === 'string' ? j.dir : undefined, sessions, ...(servers ? { servers } : {}) };
}
