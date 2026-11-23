import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sys from '../src/system';

test('writeSessionsFile keeps the servers when only sessions are saved, and writes the .list copy', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-sf-'));
  const f = path.join(d, 'sessions.json');
  sys.writeSessionsFile(f, { dir: '/p', sessions: [], servers: [{ name: 'N', dir: '/p', slug: 'n' }] });
  // a caller that knows nothing about servers (the "persist a window" commands)
  const cur = sys.readSessionsFile(f);
  sys.writeSessionsFile(f, { dir: cur.dir, sessions: [{ window: 'w', id: 'i', name: 'n', dir: '/p' }] });
  const after = sys.readSessionsFile(f);
  assert.equal(after.servers?.[0].slug, 'n');
  assert.equal(after.sessions.length, 1);
  assert.equal(fs.readFileSync(sys.listPath(f), 'utf8'), 'w\x1fi\x1fn\x1f/p\n');
  // explicitly passing servers replaces them
  sys.writeSessionsFile(f, { ...after, servers: [] });
  assert.deepEqual(sys.readSessionsFile(f).servers, []);
});

test('readSessionsFile returns an empty list when the file does not exist', () => {
  assert.deepEqual(sys.readSessionsFile('/no/such/dir/sessions.json'), { sessions: [] });
});

import { spawnSync } from 'node:child_process';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('moveWindowTo moves a window to an existing or a new session without killing its process', { skip: !hasTmux }, async () => {
  // a short path: unix socket paths are limited to ~100 characters
  const sock = fs.mkdtempSync('/tmp/ctm.');
  const prev = process.env.TMUX_TMPDIR; process.env.TMUX_TMPDIR = sock;
  try {
    const t = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8', env: process.env });
    t('new-session', '-d', '-s', 'src', '-n', 'one', 'sleep 300');
    t('new-window', '-t', '=src:', '-n', 'two', 'sleep 300');
    const pidOf = (target: string) => t('display-message', '-p', '-t', target, '#{pane_pid}').stdout.trim();
    const pid = pidOf('=src:two');
    assert.ok(+pid > 0);

    // 1) to a session that does not exist: it is created, and the temporary window is removed
    let r = await sys.moveWindowTo('=src:two', 'newgrp');
    assert.equal(r.ok, true, r.err);
    assert.deepEqual((await sys.listWindows('newgrp')).map(w => w.name), ['two']);
    assert.equal(pidOf('=newgrp:two'), pid, 'same process, it was not restarted');
    assert.deepEqual((await sys.listWindows('src')).map(w => w.name), ['one']);

    // 2) to an existing session: appended after its windows
    t('new-session', '-d', '-s', 'other', '-n', 'x', 'sleep 300');
    r = await sys.moveWindowTo('=src:one', 'other');
    assert.equal(r.ok, true, r.err);
    assert.deepEqual((await sys.listWindows('other')).map(w => w.name), ['x', 'one']);
    assert.ok(!(await sys.listSessions()).includes('src'), 'an emptied session disappears by itself');
    assert.equal(pidOf('=newgrp:two'), pid, 'the first moved window is still the same process');
  } finally {
    spawnSync('tmux', ['kill-server'], { env: process.env });
    if (prev === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prev;
    fs.rmSync(sock, { recursive: true, force: true });
  }
});
