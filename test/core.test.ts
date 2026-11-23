import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/core';

test('parseRemoteState: the most recent message wins', () => {
  assert.equal(parse('/remote-control is active · Continue here'), 'connected');
  assert.equal(parse('Remote Control disconnected — account changed'), 'disconnected');
  assert.equal(parse('another connection took over this session (code 4090)'), 'conflict');
  assert.equal(parse('Remote Control disconnected\n...\n/remote-control is active'), 'connected');
  assert.equal(parse('/remote-control is active\n...\nRemote Control disconnected'), 'disconnected');
  assert.equal(parse('nothing relevant'), 'unknown');
});
function parse(s: string) { return c.parseRemoteState(s); }

test('extractTitle: takes the last one and decodes escapes', () => {
  const t = '{"aiTitle":"Primero"}\n{"x":1}\n{"aiTitle":"Caf\\u00e9 \\"final\\""}';
  assert.equal(c.extractTitle(t), 'Café "final"');
  assert.equal(c.extractTitle('{"a":1}'), undefined);
});

test('encodeProjectDir', () => {
  assert.equal(c.encodeProjectDir('/home/user/my-project'), '-home-user-my-project');
});

test('shQuote and buildClaudeCommand survive quotes and spaces', () => {
  assert.equal(c.shQuote("a'b"), `'a'\\''b'`);
  assert.equal(
    c.buildClaudeCommand('/bin/claude', { resumeId: 'id1', remoteName: "my session; rm -rf /" }),
    `'/bin/claude' --resume 'id1' --remote-control 'my session; rm -rf /'`
  );
  assert.equal(c.buildClaudeCommand('/bin/claude', {}), `'/bin/claude'`);
});

test('extractResumeId only accepts a uuid', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(c.extractResumeId(`claude --resume ${id} --remote-control alpha`), id);
  assert.equal(c.extractResumeId('claude --resume --remote-control wipe'), undefined);
  assert.equal(c.extractResumeId('claude --resume algo'), undefined);
});

test('findClaudeUnder y duplicatedIds', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const rows = c.parsePs([
    '  10     1 tmux new-session -d -s claude',
    '  11    10 bash',
    `  12    11 /home/x/.local/bin/claude --resume ${id} --remote-control grid`,
    `  20     1 /vscode/native-binary/claude --output-format stream-json --resume ${id}`,
  ].join('\n'));
  assert.equal(c.findClaudeUnder(rows, 11)?.pid, 12);
  assert.equal(c.findClaudeUnder(rows, 99), undefined);
  assert.deepEqual([...c.duplicatedIds(rows)], [id]);
});

test('parseSessionsFile validates the format', () => {
  const ok = c.parseSessionsFile('{"dir":"/d","sessions":[{"window":"a","id":"1","name":"n"}]}');
  assert.equal(ok.sessions.length, 1);
  assert.throws(() => c.parseSessionsFile('{"sessions":[{"window":"a"}]}'));
});

test('extractRemoteName', () => {
  assert.equal(c.extractRemoteName("claude --resume x --remote-control alpha"), 'alpha');
  assert.equal(c.extractRemoteName("claude --remote-control 'my session' --x"), 'my session');
  assert.equal(c.extractRemoteName('claude --remote-control --verbose'), undefined);
  assert.equal(c.extractRemoteName('claude --resume x'), undefined);
});

test('findClaudeUnder: the pane own pid can be claude', () => {
  const rows = c.parsePs('  50     1 claude --resume 11111111-2222-4333-8444-555555555555 --remote-control alpha\n  60     1 bash');
  assert.equal(c.findClaudeUnder(rows, 50)?.pid, 50);
  assert.equal(c.findClaudeUnder(rows, 60), undefined);
});

test('isClaude ignores shells that only mention claude', () => {
  assert.ok(c.isClaude('claude --resume x'));
  assert.ok(c.isClaude('/home/u/.local/bin/claude --resume x'));
  assert.ok(c.isClaude('/home/u/.local/share/claude/versions/2.1.330 --print'));
  assert.ok(!c.isClaude('/bin/bash -c source /home/u/.claude/a.sh && claude --resume x'));
  const id = '11111111-2222-4333-8444-555555555555';
  const rows = c.parsePs(`1 0 claude --resume ${id}\n2 0 /bin/bash -c claude --resume ${id}`);
  assert.equal(c.duplicatedIds(rows).size, 0);
});

test('parseSessionsFile accepts a per-session dir and rejects an invalid one', () => {
  const ok = c.parseSessionsFile('{"sessions":[{"window":"a","id":"1","name":"n","dir":"/x"}]}');
  assert.equal(ok.sessions[0].dir, '/x');
  assert.throws(() => c.parseSessionsFile('{"sessions":[{"window":"a","id":"1","name":"n","dir":5}]}'));
});

test('slugify and uniqueSlug', () => {
  assert.equal(c.slugify('My Project!'), 'my-project');
  assert.equal(c.slugify('Servidor Ubuntu ñandú'), 'servidor-ubuntu-nandu');
  assert.equal(c.slugify('***'), 'server');
  assert.equal(c.uniqueSlug('a', ['a', 'a-2']), 'a-3');
  assert.equal(c.uniqueSlug('b', ['a']), 'b');
});

test('parseSessionsFile reads servers and validates the slug', () => {
  const ok = c.parseSessionsFile('{"sessions":[],"servers":[{"name":"N","dir":"/d","slug":"n-1"}]}');
  assert.equal(ok.servers?.[0].slug, 'n-1');
  assert.equal(c.parseSessionsFile('{"sessions":[]}').servers, undefined);
  assert.throws(() => c.parseSessionsFile('{"sessions":[],"servers":[{"name":"N","dir":"/d","slug":"../x"}]}'));
  assert.throws(() => c.parseSessionsFile('{"sessions":[],"servers":5}'));
});

test('extractPaneErrors: only lines that start with Error/Warning, deduplicated, shortened and limited', () => {
  const pane = [
    "Error: This folder is already served by a terminal `claude remote-control` on this device. Stop it first.",
    'Spawn mode: same-dir',
    "Error: This folder is already served by a terminal `claude remote-control` on this device. Stop it first.",
    "  otherwise 'manifest invalid'). cosign v3 key-based signing ... Error: not at the start of the line",
    'The user wrote: Error: pasted conversation text',
    'warning: low disk',
    'Error: ' + 'x'.repeat(300),
  ].join('\n');
  const r = c.extractPaneErrors(pane, 5, 60);
  // kept: the first Error (its repeat is dropped), the warning, and the long Error (shortened to 60 + "…")
  assert.equal(r.length, 3);
  assert.match(r[0], /^Error: This folder is already served/);
  assert.equal(r[1], 'warning: low disk');
  assert.ok(r[2].endsWith('…') && r[2].length === 61);
  assert.ok(r.every(l => /^(Error|warning)/i.test(l)), 'nothing from the conversation text gets in');
  assert.deepEqual(c.extractPaneErrors(pane, 1, 60).length, 1);
  assert.deepEqual(c.extractPaneErrors('', 5), []);
});

test('describeImpact: high when the unit does not use KillMode=process', () => {
  const sessions = [{ name: 'claude', windows: 5 }, { name: 'claude-rc-x', windows: 1 }];
  const safe = c.describeImpact('process', 'claude-rc-x', sessions);
  assert.equal(safe.high, false);
  assert.equal(safe.ownSession, 'claude-rc-x'); assert.equal(safe.ownWindows, 1);
  assert.equal(safe.totalSessions, 2); assert.equal(safe.totalWindows, 6);
  assert.equal(c.describeImpact('control-group', 'claude-rc-x', sessions).high, true);
  assert.equal(c.describeImpact('', undefined, sessions).high, true, 'unknown counts as unsafe');
  assert.equal(c.describeImpact('process', 'gone', sessions).ownSession, undefined);
});

test('addKillMode: inserts, replaces, and is a no-op when already safe', () => {
  const u = '[Unit]\nDescription=x\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\n\n[Install]\nWantedBy=default.target\n';
  const fixed = c.addKillMode(u)!;
  assert.match(fixed, /\[Service\]\nKillMode=process\nType=oneshot/);
  assert.equal(c.addKillMode(fixed), undefined, 'idempotent');
  assert.match(c.addKillMode('[Service]\nKillMode=control-group\n')!, /^\[Service\]\nKillMode=process\n$/);
  assert.equal(c.addKillMode('[Unit]\nDescription=x\n'), undefined, 'no [Service] section: nothing to do');
  assert.equal((fixed.match(/KillMode/g) ?? []).length, 1);
});

test('findServingProcess finds only a remote-control server in that directory', () => {
  const rows = c.parsePs([
    '10 1 claude remote-control --name x',
    '11 1 claude --resume 11111111-2222-4333-8444-555555555555 --remote-control alpha',
    '12 1 /bin/bash -c claude remote-control',
    '13 1 claude remote-control --name y',
  ].join('\n'));
  const cwd = (pid: number) => ({ 10: '/a', 11: '/a', 12: '/a', 13: '/b' } as Record<number, string>)[pid];
  assert.equal(c.findServingProcess(rows, '/a', cwd)?.pid, 10);
  assert.equal(c.findServingProcess(rows, '/b', cwd)?.pid, 13);
  assert.equal(c.findServingProcess(rows, '/c', cwd), undefined);
});

test('checkSaved reports a missing directory or a conversation that is not in that project', () => {
  const dirs = new Set(['/ok']); const convs = new Set(['/ok|id1']);
  const d = (x: string) => dirs.has(x), cv = (x: string, id: string) => convs.has(`${x}|${id}`);
  assert.equal(c.checkSaved({ id: 'id1', dir: '/ok' }, '/fb', d, cv), undefined);
  assert.equal(c.checkSaved({ id: 'id1', dir: '/gone' }, '/fb', d, cv), 'no-dir');
  assert.equal(c.checkSaved({ id: 'id2', dir: '/ok' }, '/fb', d, cv), 'no-conversation');
  assert.equal(c.checkSaved({ id: 'id1' }, '/ok', d, cv), undefined, 'uses the fallback directory');
});

test('groups: effective group, known groups and validation', () => {
  assert.equal(c.groupOf({ group: 'ops' }, 'claude'), 'ops');
  assert.equal(c.groupOf({}, 'claude'), 'claude');
  assert.equal(c.groupOf({ group: '' }, 'claude'), 'claude');
  const g = c.allGroups('claude', ['claude', 'ops', 'claude-rc-x'], [{ group: 'docs' }, {}], new Set(['claude-rc-x']));
  assert.deepEqual(g, ['claude', 'ops', 'docs']);
  assert.deepEqual(c.allGroups('claude', [], [], new Set()), ['claude'], 'the default group is always offered');
  assert.equal(c.parseSessionsFile('{"sessions":[{"window":"a","id":"1","name":"n","group":"ops"}]}').sessions[0].group, 'ops');
  assert.throws(() => c.parseSessionsFile('{"sessions":[{"window":"a","id":"1","name":"n","group":"bad name!"}]}'));
});
