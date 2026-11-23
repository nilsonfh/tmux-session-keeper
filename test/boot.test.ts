import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as b from '../src/boot';

function sandbox(opts: { hasSession: boolean; windows?: string[] }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-'));
  const log = path.join(d, 'calls.log');
  fs.writeFileSync(path.join(d, 'tmux'), `#!/usr/bin/env bash
case "$1" in
  has-session) exit ${opts.hasSession ? 0 : 1};;
  list-windows) printf '%s\\n' ${(opts.windows ?? []).map(w => `'${w}'`).join(' ')}; exit 0;;
  *) printf 'TMUX' >> '${log}'; for a in "$@"; do printf ' [%s]' "$a" >> '${log}'; done; echo >> '${log}';;
esac
`, { mode: 0o755 });
  return { d, log };
}

function run(list: string, sb: { d: string; log: string }) {
  const listFile = path.join(sb.d, 's.list');
  fs.writeFileSync(listFile, list);
  const script = path.join(sb.d, 'restore.sh');
  fs.writeFileSync(script, b.renderRestoreScript({ claudeBin: "/opt/my bin/claude", tmuxSession: 'claude', listFile }), { mode: 0o755 });
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'syntax');
  const r = spawnSync('bash', [script], { env: { ...process.env, PATH: `${sb.d}:${process.env.PATH}` }, encoding: 'utf8' });
  return { r, calls: fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8') : '' };
}

test('toList cleans separators and uses the fallback directory', () => {
  const t = b.toList([{ window: 'a', id: '1', name: 'n\tx\x1fy', dir: '/p' }, { window: 'b', id: '2', name: 'm' }], '/fb');
  assert.equal(t, 'a\x1f1\x1fn x y\x1f/p\nb\x1f2\x1fm\x1f/fb\n');
  assert.equal(b.toList([], '/fb'), '');
});

test('script: with no tmux session it creates the windows and skips a missing directory', () => {
  const sb = sandbox({ hasSession: false });
  const dir = sb.d;
  const { r, calls } = run(`a\x1fid-a\x1fA\x1f${dir}\nb\x1fid-b\x1fB con 'comilla'\x1f${dir}\nc\x1fid-c\x1fC\x1f/no/existe\n`, sb);
  assert.equal(r.status, 0);
  assert.match(calls, /\[new-session\].*\[-s\] \[claude\] \[-n\] \[a\] \[-c\]/);
  assert.match(calls, /'\/opt\/my bin\/claude' --resume 'id-a' --remote-control 'A'/);
  assert.match(calls, /B con '\\''comilla'\\''/);
  assert.match(r.stderr, /skipping 'c'/);
  assert.doesNotMatch(calls, /id-c/);
});

test('script: is idempotent, leaves existing windows alone and uses exact matching', () => {
  const sb = sandbox({ hasSession: true, windows: ['a'] });
  const { calls } = run(`a\x1fid-a\x1fA\x1f${sb.d}\nb\x1fid-b\x1fB\x1f${sb.d}\n`, sb);
  assert.doesNotMatch(calls, /id-a/);
  assert.match(calls, /\[new-window\] \[-t\] \[=claude:\] \[-n\] \[b\]/);
});

test('script: without a remote name it does not pass --remote-control', () => {
  const sb = sandbox({ hasSession: false });
  const { calls } = run(`a\x1fid-a\x1f\x1f${sb.d}\n`, sb);
  assert.match(calls, /--resume 'id-a'/, 'the window must still be created with its own directory');
  assert.doesNotMatch(calls, /remote-control/);
});

test('renderUnit escapes % and spaces', () => {
  const u = b.renderUnit({ scriptPath: '/home/a b/%x/restore.sh', pathDirs: ['/a', '/a', '/b'] });
  assert.match(u, /ExecStart="\/home\/a b\/%%x\/restore.sh"/);
  assert.match(u, /Environment=PATH=\/a:\/b\n/);
  assert.match(u, /Type=oneshot/);
});

function serverSandbox(autoUpdate: boolean, dirExists = true) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-srv-'));
  const proj = path.join(d, 'proj'); if (dirExists) fs.mkdirSync(proj);
  const calls = path.join(d, 'calls.log');
  const fake = path.join(d, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env bash\necho "cwd=$(pwd) args=$*" >> '${calls}'\nexit 7\n`, { mode: 0o755 });
  const script = path.join(d, 'server.sh');
  fs.writeFileSync(script, b.renderServerScript({ claudeBin: fake, name: `Mi "srv" it's`, dir: proj, logDir: path.join(d, 'logs'), slug: 'x', autoUpdate }), { mode: 0o755 });
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'syntax');
  return { d, proj, calls, script };
}

test('server script: restarts remote-control when it exits, in the right directory, and logs it', () => {
  const s = serverSandbox(false);
  spawnSync('timeout', ['1.5', 'bash', s.script], { env: { ...process.env, CLAUDE_TMUX_RESTART_DELAY: '0.1' } });
  const lines = fs.readFileSync(s.calls, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3, `expected several restarts, got ${lines.length}`);
  assert.ok(lines.every(l => l.startsWith(`cwd=${s.proj} args=remote-control --name Mi "srv" it's --verbose --debug-file ${s.d}/logs/x-debug.log`)), lines[0]);
  assert.match(fs.readFileSync(path.join(s.d, 'logs', 'x-restarts.log'), 'utf8'), /remote-control exited \(code 7\)\. Restarting in 0\.1 s/);
});

test('server script: update only runs when autoUpdate is on', () => {
  const on = serverSandbox(true);
  spawnSync('timeout', ['0.6', 'bash', on.script], { env: { ...process.env, CLAUDE_TMUX_RESTART_DELAY: '0.1' } });
  assert.match(fs.readFileSync(on.calls, 'utf8').split('\n')[0], /args=update$/);
  const off = serverSandbox(false);
  spawnSync('timeout', ['0.6', 'bash', off.script], { env: { ...process.env, CLAUDE_TMUX_RESTART_DELAY: '0.1' } });
  assert.doesNotMatch(fs.readFileSync(off.calls, 'utf8'), /args=update/);
});

test('server script: a missing directory stops with an error instead of looping', () => {
  const s = serverSandbox(false, false);
  const r = spawnSync('timeout', ['2', 'bash', s.script], { encoding: 'utf8', env: { ...process.env, CLAUDE_TMUX_RESTART_DELAY: '0.1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
  assert.equal(fs.existsSync(s.calls), false);
});

test('renderServerUnit: oneshot with tmux start and exact-match stop', () => {
  const u = b.renderServerUnit({ tmuxBin: '/usr/bin/tmux', session: 'claude-rc-x', scriptPath: '/h/a b/server-x.sh', pathDirs: ['/a', '/a'], slug: 'x' });
  assert.match(u, /Type=oneshot\nRemainAfterExit=yes/);
  assert.match(u, /ExecStart=\/usr\/bin\/tmux new-session -d -s claude-rc-x "\/h\/a b\/server-x.sh"\n/);
  assert.match(u, /ExecStop=\/usr\/bin\/tmux kill-session -t =claude-rc-x\n/);
  assert.equal(b.serverUnitName('x'), 'claude-rc-x');
});

test('both generated units use KillMode=process so stopping one never kills the shared tmux server', () => {
  const restore = b.renderUnit({ scriptPath: '/s.sh', pathDirs: ['/usr/bin'] });
  const server = b.renderServerUnit({ tmuxBin: '/usr/bin/tmux', session: 'claude-rc-x', scriptPath: '/s.sh', pathDirs: ['/usr/bin'], slug: 'x' });
  for (const u of [restore, server]) assert.match(u, /\[Service\]\nType=oneshot\nRemainAfterExit=yes\nKillMode=process\n/);
});

test('restore script v2: a session goes to its own group, empty group = default, windows are checked per group', () => {
  const sb = sandbox({ hasSession: true, windows: ['a'] });
  // sandbox tmux: has-session always succeeds and list-windows always returns "a"
  const { calls } = run(`a\x1fid-a\x1fA\x1f${sb.d}\x1fops\nb\x1fid-b\x1fB\x1f${sb.d}\x1fops\nc\x1fid-c\x1fC\x1f${sb.d}\x1f\n`, sb);
  assert.doesNotMatch(calls, /id-a/, 'window "a" already exists in the group');
  assert.match(calls, /\[new-window\] \[-t\] \[=ops:\] \[-n\] \[b\]/, 'b goes to the ops group');
  assert.match(calls, /\[new-window\] \[-t\] \[=claude:\] \[-n\] \[c\]/, 'empty group falls back to the default session');
});

test('restore script v2: creates a missing group with new-session', () => {
  const sb = sandbox({ hasSession: false });
  const { calls } = run(`x\x1fid-x\x1fX\x1f${sb.d}\x1fgrp\n`, sb);
  assert.match(calls, /\[new-session\] \[-d\] \[-s\] \[grp\] \[-n\] \[x\]/);
});

test('toGroupList writes the group as the 5th field; the v1 list is unchanged for old scripts', () => {
  const s = [{ window: 'a', id: '1', name: 'n', dir: '/p', group: 'ops' }, { window: 'b', id: '2', name: 'm' }];
  assert.equal(b.toGroupList(s, '/fb'), 'a\x1f1\x1fn\x1f/p\x1fops\nb\x1f2\x1fm\x1f/fb\x1f\n');
  assert.equal(b.toList(s, '/fb'), 'a\x1f1\x1fn\x1f/p\nb\x1f2\x1fm\x1f/fb\n');
});

test('scriptFormat reads the version marker; scripts without one count as format 1', () => {
  const fresh = b.renderRestoreScript({ claudeBin: '/c', tmuxSession: 'claude', listFile: '/l' });
  assert.equal(b.scriptFormat(fresh), b.RESTORE_FORMAT);
  assert.equal(b.scriptFormat('#!/usr/bin/env bash\n# Generated by the extension\n'), 1);
});

test('restore script v2 with real tmux: two groups, per-session directory, idempotent', { skip: spawnSync('tmux', ['-V']).status !== 0 }, () => {
  const sock = fs.mkdtempSync('/tmp/ctm.');            // short path for the unix socket
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-real-'));
  const projA = path.join(d, 'a'), projB = path.join(d, 'b'); fs.mkdirSync(projA); fs.mkdirSync(projB);
  const fake = path.join(d, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env bash\necho "$(pwd) $*" > "${d}/out-$(basename "$(pwd)")-$2.txt"\nsleep 60\n`, { mode: 0o755 });
  const env = { ...process.env, TMUX_TMPDIR: sock };
  const list = path.join(d, 's.groups.list');
  fs.writeFileSync(list, b.toGroupList([
    { window: 'w1', id: 'id-1', name: 'One', dir: projA, group: 'ops' },
    { window: 'w2', id: 'id-2', name: '', dir: projB, group: 'ops' },
    { window: 'w3', id: 'id-3', name: 'Three', dir: projA },            // no group: default session
  ], projA));
  const script = path.join(d, 'restore.sh');
  fs.writeFileSync(script, b.renderRestoreScript({ claudeBin: fake, tmuxSession: 'main', listFile: list }), { mode: 0o755 });
  try {
    const run1 = () => spawnSync('bash', [script], { env, encoding: 'utf8' });
    assert.equal(run1().status, 0);
    spawnSync('sleep', ['1']);
    const wins = (s: string) => spawnSync('tmux', ['list-windows', '-t', `=${s}`, '-F', '#{window_name}:#{pane_pid}'], { env, encoding: 'utf8' }).stdout.trim().split('\n').sort();
    assert.deepEqual(wins('ops').map(x => x.split(':')[0]), ['w1', 'w2']);
    assert.deepEqual(wins('main').map(x => x.split(':')[0]), ['w3']);
    const rec = (f: string) => fs.readFileSync(path.join(d, f), 'utf8').trim();
    assert.equal(rec('out-a-id-1.txt'), `${projA} --resume id-1 --remote-control One`);
    assert.equal(rec('out-b-id-2.txt'), `${projB} --resume id-2`, 'no remote name: no --remote-control, and its own directory');
    assert.equal(rec('out-a-id-3.txt'), `${projA} --resume id-3 --remote-control Three`);
    const before = [wins('ops'), wins('main')];
    run1();                                              // second run must change nothing
    assert.deepEqual([wins('ops'), wins('main')], before, 'idempotent: same windows, same processes');
  } finally {
    spawnSync('tmux', ['kill-server'], { env });
    fs.rmSync(sock, { recursive: true, force: true });
  }
});
