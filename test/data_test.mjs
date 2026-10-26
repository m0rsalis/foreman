// Self-test for the ops panel's data readers and pane (plugin/hooks).
// Run: node --experimental-strip-types --test test/data_test.mjs (Node 22.6 or newer).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BIN,
  branchesOf,
  collect,
  describeDir,
  fileUrl,
  formatAge,
  latestReviewNotes,
  newCache,
  newestMtimeMs,
  parseActionRun,
  parseBacklog,
  parseCheckHistory,
  parseChecks,
  parseConfig,
  parseLsofCwd,
  parseProposedDecisions,
  parsePrs,
  parseReviewNotes,
  parseSession,
  parseAgentNames,
  parseUsage,
  agentLane,
  laneViews,
  parseStatLines,
  parseStatus,
  parseTicketName,
  parseWhere,
  parseWorktrees,
  resolveLocksDir,
} from '../plugin/hooks/data.ts'
import { agentColor, agentStatus, backlogNote, freeLanes, readyTone, renderPanel, resetText, signoffTiles, slotBoxes, usageGauge } from '../plugin/hooks/view.ts'
import { findAll, textUi, toText } from './text_ui.mjs'

const NOW = Date.parse('2026-10-07T20:00:00Z')
const MIN = 60_000

const STATUS = {
  schema: 1,
  updated: '2026-10-07T19:44:53Z',
  agentLimit: 3,
  priority: 'Ship the importer first',
  agents: [
    { name: 'api', model: 'opus', task: 'Importer API', branch: 'api-x', step: 'docs', startedAt: '2026-10-07T18:00:00Z', next: null },
    { name: 'ui', model: 'sonnet', task: 'Settings page', branch: 'ui-a / ui-b', step: 'goldens', startedAt: '2026-10-07T13:00:00Z', next: 'dark mode' },
    { name: 'bglive', model: 'haiku', kind: 'bg', sessionName: 'bglive', task: 'Watches', branch: '', step: 'idle', startedAt: '2026-10-07T19:50:00Z', next: null },
    { name: 'bggone', model: 'opus', kind: 'bg', sessionName: 'bggone', task: 'Died', branch: '', step: 'building', startedAt: '2026-10-07T19:00:00Z', next: null },
  ],
  signoff: [
    { item: 'Try the importer', kind: 'test', where: 'staging, tmp/previews/run.png', since: 'pending merge' },
    { item: 'Iteration report', kind: 'review', where: 'docs/plan/r.md', since: '2026-10-07' },
    { item: 'Odd thing', kind: 'something-new', where: null, since: null },
  ],
  extra: 'ignored',
}

const PROJECT = {
  owner: 'Sam',
  agentCap: 5,
  locks: [{ name: 'check', timeoutMin: 120 }, { name: 'db', timeoutMin: 30 }],
  previews: ['tmp/previews', '/abs/shots', 'tmp/missing'],
  decisionLog: 'docs/decisions.md',
  reviewNotesDir: 'docs/plan',
  heartbeatName: 'demo-heartbeat',
  action: { label: 'Deploy staging', command: 'make deploy', confirm: 'Deploy main to staging?' },
}
const LOCAL = { gh: '/bin/gh' }

const PORCELAIN = [
  'worktree /r\nHEAD 1111\nbranch refs/heads/main\n',
  'worktree /r/.claude/worktrees/api\nHEAD 2222\nbranch refs/heads/api-x\n',
  'worktree /w/ui\nHEAD 3333\nbranch refs/heads/ui-b\n',
  'worktree /w/detached\nHEAD 4444\ndetached\n',
].join('\n')

const DECISIONS = [
  '# Decisions',
  '## Decision log',
  '',
  '| # | Date | Decision | Status |',
  '|---|---|---|---|',
  '| 1 | 2026-10 | Postgres | Accepted |',
  '| 12 | 2026-10 | Ops **panel** as a mod | Proposed |',
  '| 13 | 2026-10 | A row with a | pipe inside | Proposed (lead) |',
  '',
  '## Next',
  '| 999 | x | y | Proposed |',
].join('\n')

const NOTES = [
  '# Review notes, 2026-10-07',
  '## Blocked on Sam',
  '| Item | Blocks |',
  '|---|---|',
  '| Old question | M7 |',
  "## Sam's answers, midday",
  '| 1 | Old question | yes |',
  '## Open for Sam',
  '- **Logo:** approve the combined look',
  '- Pricing tiers: Confirmed by Sam.',
  '| Item | Where |',
  '|---|---|',
  '| Import limits | docs |',
  '## Pinned for the demo',
  '- Font size',
  'Every pinned item above is now answered.',
  '## In progress',
  '- Not an open item',
].join('\n')

function fakeIo({ files = {}, dirs = {}, runs = [], env }) {
  const calls = []
  return {
    calls,
    read: async p => {
      if (p in files) return files[p]
      throw new Error(`ENOENT: ${p}`)
    },
    exists: async p => p in files || p in dirs,
    list: async p => {
      if (!(p in dirs)) throw new Error(`ENOENT: ${p}`)
      return dirs[p].map(e => (typeof e === 'string' ? { name: e, kind: 'file', mtimeMs: 0 } : e))
    },
    mtimeMs: async p => {
      if (p in files || p in dirs) return NOW - 3 * MIN
      throw new Error(`ENOENT: ${p}`)
    },
    agentLocksEnv: async () => env,
    homeEnv: async () => '/home',
    run: async (argv, cwd) => {
      calls.push({ argv, cwd })
      for (const [match, result] of runs) {
        if (match(argv)) return typeof result === 'function' ? result(argv) : result
      }
      return { exitCode: 127, stdout: '', stderr: `no fake for ${argv.join(' ')}` }
    },
  }
}

const ok = stdout => ({ exitCode: 0, stdout, stderr: '' })
const has = (...parts) => argv => parts.every(p => argv.includes(p))
const sec = ms => String(Math.floor(ms / 1000))
const session = (pid, name, kind, status, cwd) => JSON.stringify({ pid, name, kind, status, cwd, startedAt: NOW - 600_000, updatedAt: NOW - 30_000 })

function world(overrides = {}) {
  return {
    files: {
      '/r/tmp/ops/status.json': JSON.stringify(STATUS),
      '/r/tmp/ops/backlog.json': JSON.stringify({
        schema: 1,
        items: [
          { id: 'B-1', title: 'Importer', status: 'in-progress', rank: 1, agent: 'api' },
          { id: 'B-2', title: 'Export', status: 'ready', rank: 2, dependsOn: ['B-1'] },
          { id: 'B-3', title: 'Dark mode', status: 'ready', rank: 3 },
          { id: 'B-4', title: 'Old', status: 'done', rank: 0 },
        ],
      }),
      '/r/tmp/agent-locks/locks/check.lock/owner': '111\n',
      '/r/docs/plan/r.md': '# r',
      '/r/tmp/previews/run.png': 'png',
      '/r/tmp/ops/checks.jsonl': '',
      '/r/docs/decisions.md': DECISIONS,
      '/r/docs/plan/review-notes-2026-10-07.md': NOTES,
      '/r/tmp/ops/action.json': JSON.stringify({ state: 'running', pid: 4242, startedAt: '2026-10-07T19:58:00Z' }),
      '/r/tmp/ops/action.log': '',
      '/home/.claude/sessions/9001.json': session(9001, 'bglive', 'bg', 'idle', '/r/.claude/worktrees/bglive'),
      '/home/.claude/sessions/9002.json': session(9002, 'demo-heartbeat', 'bg', 'busy', '/r'),
      '/home/.claude/sessions/9003.json': session(9003, 'bggone', 'bg', 'busy', '/r'),
      '/home/.claude/sessions/9004.json': session(9004, 'lead', 'interactive', 'busy', '/r'),
      '/home/.claude/sessions/9005.json': session(9005, 'stranger', 'bg', 'busy', '/elsewhere/repo'),
      '/home/.claude/sessions/9006.json': session(9006, 'demo-heartbeat', 'bg', 'idle', '/elsewhere/repo'),
      '/home/.claude/sessions/broken.json': '{nope',
      ...overrides.files,
    },
    dirs: {
      '/r/tmp/agent-locks/locks/check.lock': [],
      '/r/tmp/agent-locks/locks/check.queue': ['1759866000000000000-111', '1759866060000000000-222', 'junk'],
      '/r/tmp/agent-locks/locks/db.queue': [],
      '/r/docs/plan': ['iteration-4.md', 'review-notes.md', 'review-notes-2026-10-06.md', 'review-notes-2026-10-07.md'],
      '/r/tmp/previews': [],
      '/abs/shots': [],
      '/home/.claude/sessions': ['9001.json', '9002.json', '9003.json', '9004.json', '9005.json', '9006.json', 'broken.json', 'notes.txt'],
      ...overrides.dirs,
    },
    runs: [
      ...(overrides.runs ?? []),
      [has('worktree', 'list'), ok(PORCELAIN)],
      [has(BIN.lsof, '111'), ok('p111\nfcwd\nn/r/.claude/worktrees/api\n')],
      [has(BIN.lsof, '222'), ok('p222\nfcwd\nn/w/ui/src\n')],
      [has(BIN.find, '/r/.claude/worktrees/api'), ok(`${sec(NOW - 5 * MIN)}\n${sec(NOW - 50 * MIN)}\n`)],
      [has(BIN.find, '/w/ui'), ok(`${sec(NOW - 40 * MIN)}\n`)],
      [has(BIN.find, '/r/tmp/previews'), ok(`${sec(NOW - 2 * MIN)} /r/tmp/previews/a b.png\n${sec(NOW - 9 * MIN)} /r/tmp/previews/old.png\n`)],
      [has(BIN.find, '/abs/shots'), ok(`${sec(NOW - 1 * MIN)} /abs/shots/new.mp4\n`)],
      [has(BIN.tail, '/r/tmp/ops/checks.jsonl'), ok('{"time":"2026-10-07T19:30:00Z","branch":"api-x","result":"failed","part":"e2e"}\n{"time":"2026-10-07T19:50:00Z","branch":"api-x","result":"green","commit":"93e2d41"}\n')],
      [has(BIN.tail, '/r/tmp/ops/action.log'), ok('== start\nbuilding\n')],
      [has(BIN.kill, '4242'), ok('')],
      ...[9001, 9002, 9004, 9005, 9006].map(pid => [has(BIN.kill, '-0', String(pid)), ok('')]),
      [
        has('/bin/gh', 'pr', 'list'),
        ok(JSON.stringify([
          { number: 81, title: 'Importer', state: 'OPEN', headRefName: 'api-x', mergedAt: null, url: 'https://github.com/x/y/pull/81' },
          { number: 79, title: 'Lint', state: 'MERGED', headRefName: 'lint', mergedAt: '2026-10-07T19:40:00Z', url: 'https://github.com/x/y/pull/79' },
          { number: 70, title: 'Old', state: 'MERGED', headRefName: 'old', mergedAt: '2026-10-01T10:00:00Z', url: 'https://github.com/x/y/pull/70' },
          { number: 60, title: 'Closed', state: 'CLOSED', headRefName: 'nope', mergedAt: null, url: 'https://github.com/x/y/pull/60' },
        ])),
      ],
    ],
  }
}

const config = parseConfig(JSON.stringify(PROJECT), JSON.stringify(LOCAL))

test('formatAge reads at a glance', () => {
  assert.equal(formatAge(42_000), '42s')
  assert.equal(formatAge(12 * MIN), '12m')
  assert.equal(formatAge(125 * MIN), '2h 05m')
  assert.equal(formatAge(26 * 60 * MIN), '1d 2h')
  assert.equal(formatAge(-5), '0s')
})

test('config: defaults with no files, the local layer wins, bad input names its file', () => {
  const none = parseConfig(null, null)
  assert.equal(none.owner, 'the owner')
  assert.equal(none.agentCap, 4)
  assert.deepEqual(none.locks, [{ name: 'check', timeoutMin: 120 }])
  assert.equal(none.action, null)
  assert.equal(none.decisionLog, null)
  assert.equal(config.owner, 'Sam')
  assert.equal(config.gh, '/bin/gh')
  assert.deepEqual(config.locks.map(l => l.name), ['check', 'db'])
  assert.equal(config.action.label, 'Deploy staging')
  assert.equal(parseConfig(JSON.stringify(PROJECT), '{"owner":"Kim","action":null}').owner, 'Kim')
  assert.equal(parseConfig(JSON.stringify(PROJECT), '{"action":null}').action, null, 'the local layer can switch the action off')
  assert.deepEqual(parseConfig('{"locks":{"check":90,"sim":45}}').locks, [{ name: 'check', timeoutMin: 90 }, { name: 'sim', timeoutMin: 45 }])
  assert.deepEqual(parseConfig('{"locks":["check"]}').locks, [{ name: 'check', timeoutMin: 60 }])
  assert.throws(() => parseConfig('{'), /\.claude\/ops-kit\.json/)
  assert.throws(() => parseConfig(null, '[]'), /tmp\/ops\/config\.json is not an object/)
  assert.throws(() => parseConfig('{"locks":["../x"]}'), /not a plain name/)
  assert.equal(parseConfig('{"action":{"label":"x"}}').action, null, 'an action needs a command')
})

test('locks folder: OPS_AGENT_LOCKS, then locksDir, relative from the main checkout', () => {
  const cfg = locksDir => parseConfig(JSON.stringify(locksDir === undefined ? {} : { locksDir }))
  assert.equal(resolveLocksDir(undefined, cfg(), '/r'), '/r/tmp/agent-locks')
  assert.equal(resolveLocksDir('/env/locks/', cfg(), '/r'), '/env/locks')
  assert.equal(resolveLocksDir(undefined, cfg('/cfg/locks'), '/r'), '/cfg/locks')
  assert.equal(resolveLocksDir('/env/locks', cfg('/cfg/locks'), '/r'), '/env/locks', 'the variable wins, as it does for queue.sh')
  assert.equal(resolveLocksDir('', cfg(), '/r'), '/r/tmp/agent-locks', 'empty counts as unset, like ${VAR:-default}')
  assert.equal(resolveLocksDir(undefined, cfg('tmp/other'), '/r'), '/r/tmp/other')
})

test('status.json: schema 1, unknown fields ignored, the cap optional', () => {
  const s = parseStatus(JSON.stringify(STATUS))
  assert.equal(s.agents.length, 4)
  assert.deepEqual([s.agents[0].model, s.agents[0].kind, s.agents[2].kind, s.agents[2].sessionName], ['opus', 'inproc', 'bg', 'bglive'])
  assert.equal(s.agents[1].startedMs, Date.parse('2026-10-07T13:00:00Z'))
  assert.equal(s.agentLimit, 3)
  assert.equal(parseStatus('{"schema":1}').agentLimit, null)
  assert.throws(() => parseStatus('{"agents":[]}'), /schema/)
  assert.throws(() => parseStatus('{'))
})

test('backlog: priority then rank, next is the first ready item with its dependencies done', () => {
  const b = parseBacklog(JSON.stringify({
    items: [
      { id: 'A', title: 'a', status: 'ready', rank: 1, dependsOn: ['Z'] },
      { id: 'B', title: 'b', status: 'ready', rank: 2 },
      { id: 'C', title: 'c', status: 'defined', rank: 3, priority: 1 },
      { id: 'D', title: 'd', status: 'In Progress', rank: 4 },
      { id: 'E', title: 'e', status: 'blocked', rank: 5, blockedBy: 'owner' },
      { id: 'F', title: 'f', status: 'done' },
      { id: 'G', title: 'g', status: 'weird', rank: 0 },
    ],
  }))
  assert.deepEqual(b.items.map(i => i.id), ['C', 'G', 'A', 'B', 'D', 'E'])
  assert.deepEqual(b.items.filter(i => i.isNext).map(i => i.id), ['B'])
  assert.equal(b.items.find(i => i.id === 'D').status, 'in_progress')
  assert.equal(b.items.find(i => i.id === 'G').status, 'inbox')
  assert.deepEqual(b.items.find(i => i.id === 'A').waitsFor, ['Z'], 'an unknown id is unmet')
  assert.equal(backlogNote(b.items.find(i => i.id === 'E')), 'blocked: owner')
  assert.equal(b.doneCount, 1)
  assert.throws(() => parseBacklog('{}'), /items/)
})

test('branches, where parts and paths', () => {
  assert.deepEqual(branchesOf('ui-a / ui-b'), ['ui-a', 'ui-b'])
  assert.deepEqual(branchesOf('feature/x'), ['feature/x'])
  assert.deepEqual(parseWhere('staging, tmp/previews/, docs/plan/r.md, /abs/x.png', '/r'), [
    { text: 'staging', path: null },
    { text: 'tmp/previews/', path: '/r/tmp/previews' },
    { text: 'docs/plan/r.md', path: '/r/docs/plan/r.md' },
    { text: '/abs/x.png', path: '/abs/x.png' },
  ])
  assert.equal(fileUrl('/a b/c#d.png'), 'file:///a%20b/c%23d.png')
})

test('worktrees, lsof, tickets and who holds what', () => {
  const trees = parseWorktrees(PORCELAIN)
  assert.deepEqual(trees.map(t => t.branch), ['main', 'api-x', 'ui-b', null])
  assert.equal(parseLsofCwd('p1\nfcwd\nn/w/a b\n'), '/w/a b')
  assert.equal(parseLsofCwd(''), null)
  assert.deepEqual(parseTicketName('1759866060123456789-222'), { sinceMs: 1759866060123, pid: 222 })
  assert.equal(parseTicketName('junk'), null)
  const agents = parseStatus(JSON.stringify(STATUS)).agents
  assert.equal(describeDir('/w/ui/src', trees, agents, '/r'), 'ui (ui-b)')
  assert.equal(describeDir('/r/server', trees, agents, '/r'), 'main checkout (main)')
  assert.equal(describeDir('/r/.claude/worktrees/api/x', trees, agents, '/r'), 'api (api-x)', 'the deepest worktree wins')
  assert.equal(describeDir('/w/detached', trees, agents, '/r'), 'detached')
  assert.equal(describeDir('/elsewhere/x', trees, agents, '/r'), 'x')
})

test('checks: newest per branch and strips, bad lines skipped', () => {
  const text = [
    '{"time":"2026-10-07T10:00:00Z","branch":"a","result":"green"}',
    'not json',
    '{"time":"2026-10-07T11:00:00Z","branch":"a","result":"failed","part":"check"}',
    '{"time":"2026-10-07T09:00:00Z","branch":"b","result":"green"}',
    '{"branch":"c","result":"green"}',
  ].join('\n')
  assert.deepEqual(parseChecks(text).map(c => `${c.branch}:${c.result}:${c.part}`), ['a:failed:check', 'b:green:null'])
  assert.deepEqual(parseCheckHistory(text).map(x => [x.branch, x.results]), [['a', ['green', 'failed']], ['b', ['green']]])
  assert.deepEqual(parseCheckHistory(text, 1, 1).map(x => [x.branch, x.results]), [['a', ['failed']]])
})

test('sessions, PRs, docs, action state, stat lines', () => {
  assert.deepEqual(parseSession('{"pid":5,"name":"x","kind":"bg","status":"busy","startedAt":10,"updatedAt":20,"cwd":"/r"}'), { name: 'x', pid: 5, kind: 'bg', status: 'busy', updatedMs: 20, startedMs: 10, statusSinceMs: null, cwd: '/r' })
  assert.equal(parseSession('{nope'), null)
  assert.equal(parseSession('{"name":"x"}'), null)
  const prs = parsePrs(world().runs.find(([m]) => m(['/bin/gh', 'pr', 'list']))[1].stdout, Date.parse('2026-10-07T00:00:00Z'))
  assert.deepEqual([prs.open.map(p => p.number), prs.mergedToday.map(p => p.number)], [[81], [79]])
  assert.deepEqual(parseProposedDecisions(DECISIONS), ['#12 Ops panel as a mod', '#13 A row with a | pipe inside'])
  assert.throws(() => parseProposedDecisions('# nothing'), /Decision log/)
  assert.deepEqual(parseReviewNotes(NOTES).items, ['Logo: approve the combined look', 'Import limits'])
  assert.equal(latestReviewNotes(['review-notes.md', 'review-notes-2026-10-06.md', 'review-notes-2026-10-07.md']), 'review-notes-2026-10-07.md')
  assert.equal(latestReviewNotes(['x.md']), null)
  const run = parseActionRun('{"state":"failed","exitCode":2,"finishedAt":"2026-10-07T19:00:00Z","pid":7}', ['boom'])
  assert.deepEqual([run.state, run.exitCode, run.pid, run.tail], ['failed', 2, 7, ['boom']])
  assert.equal(parseActionRun('{"state":"weird"}', []).state, 'idle')
  assert.deepEqual(parseStatLines('100 /a/old.png\n300 /a/new file.wav\nbad\n').map(f => f.name), ['new file.wav', 'old.png'])
  assert.equal(newestMtimeMs('5\n9\n7\n'), 9000)
})

test('collect: one snapshot from every source', async () => {
  const io = fakeIo(world())
  const snap = await collect(io, { repo: '/r', config, nowMs: NOW }, newCache())
  assert.deepEqual(snap.errors, [])
  assert.equal(snap.owner, 'Sam')
  assert.equal(snap.agentLimit, 3, 'status.json agentLimit wins over the config cap')
  const [api, ui, bglive, bggone] = snap.agents
  assert.deepEqual([api.quietMinutes, api.isStalled, api.state], [5, false, 'running'])
  assert.deepEqual([ui.worktrees, ui.quietMinutes, ui.state], [['/w/ui'], 40, 'stalled'])
  assert.deepEqual([bglive.state, bglive.liveState], ['running', 'idle'])
  assert.deepEqual([bggone.state, bggone.liveState], ['stopped', 'gone'])
  // Locks: every configured lock gets a lane; the holder is not its own waiter.
  assert.deepEqual(snap.locks.map(l => [l.queue, l.isHeld, l.pid, l.who]), [['check', true, 111, 'api (api-x)'], ['db', false, null, null]])
  assert.deepEqual(snap.tickets.map(t => [t.queue, t.pid, t.who]), [['check', 222, 'ui (ui-b)']])
  // Sessions: this repo's background sessions and heartbeat, not another repo's.
  assert.deepEqual(snap.sessions.map(s => s.pid).sort(), [9001, 9002])
  // Sign-off grouped in the configured kind order, links only to paths that exist.
  assert.deepEqual(snap.signoff.map(g => g.kind), ['review', 'test', 'something-new'])
  assert.equal(snap.signoff[1].items[0].where[1].path, '/r/tmp/previews/run.png')
  assert.equal(snap.signoff[1].items[0].where[0].path, null)
  assert.deepEqual(snap.decisions.items.map(i => i.slice(0, 3)), ['#12', '#13'])
  assert.equal(snap.reviewNotes.file, '/r/docs/plan/review-notes-2026-10-07.md')
  assert.deepEqual(snap.backlog.items.filter(i => i.isNext).map(i => i.id), ['B-3'])
  assert.deepEqual(snap.checks.map(c => [c.branch, c.result]), [['api-x', 'green']])
  assert.deepEqual(snap.prs.open.map(p => p.number), [81])
  assert.deepEqual([snap.actionRun.state, snap.actionRun.tail], ['running', ['== start', 'building']])
  assert.deepEqual(snap.previews.map(g => [g.label, g.files.map(f => f.name)]), [['shots', ['new.mp4']], ['previews', ['a b.png', 'old.png']]])
  assert.equal(io.calls.find(c => c.argv[0] === '/bin/gh').cwd, '/r')
})

test('collect: a dead action run reads as stopped; no action configured reads nothing', async () => {
  const dead = world({ runs: [[has(BIN.kill, '4242'), { exitCode: 1, stdout: '', stderr: 'no such process' }]] })
  const snap = await collect(fakeIo(dead), { repo: '/r', config, nowMs: NOW }, newCache())
  assert.equal(snap.actionRun.state, 'stopped')
  const plain = parseConfig(JSON.stringify({ ...PROJECT, action: null }), JSON.stringify(LOCAL))
  const io = fakeIo(world())
  const none = await collect(io, { repo: '/r', config: plain, nowMs: NOW }, newCache())
  assert.equal(none.action, null)
  assert.equal(none.actionRun.state, 'idle')
  assert.equal(io.calls.some(c => c.argv.includes('/r/tmp/ops/action.log')), false)
})

test('collect: locks come from OPS_AGENT_LOCKS when it is set', async () => {
  const alt = {
    files: { '/alt/locks/check.lock/owner': '222\n', '/alt/locks/db.lock/owner': '111\n' },
    dirs: { '/alt/locks/check.lock': [], '/alt/locks/db.lock': [], '/alt/locks/check.queue': ['1759866120000000000-111'] },
  }
  const snap = await collect(fakeIo({ ...world(alt), env: '/alt/' }), { repo: '/r', config, nowMs: NOW }, newCache())
  assert.deepEqual(snap.locks.map(l => [l.queue, l.pid, l.who]), [['check', 222, 'ui (ui-b)'], ['db', 111, 'api (api-x)']])
  assert.deepEqual(snap.tickets.map(t => [t.queue, t.pid]), [['check', 111]])
})

test('collect: missing status and docs are reported, never thrown', async () => {
  const io = fakeIo({ files: {}, dirs: {}, runs: [] })
  const snap = await collect(io, { repo: '/r', config, nowMs: NOW }, newCache())
  assert.ok(snap.errors.some(e => e.startsWith('status.json')))
  assert.equal(snap.decisions.error !== null, true)
  assert.equal(snap.backlog, null)
  assert.equal(snap.agentLimit, 5, 'without status.json the cap comes from the config')
})

test('view helpers: slots, colours, status lines, tiles', () => {
  const agent = { name: 'a', state: 'running', startedMs: NOW - 65 * MIN, quietMinutes: 0, liveState: 'idle' }
  assert.equal(agentStatus(agent, NOW), 'running 1h 05m (idle)')
  assert.equal(agentStatus({ ...agent, idleMinutes: 12 }, NOW), 'running 1h 05m (idle 12m)')
  assert.equal(agentStatus({ ...agent, state: 'stalled', quietMinutes: 40 }, NOW), 'stalled, quiet 40m · up 1h 05m')
  assert.equal(agentStatus({ ...agent, state: 'stopped', startedMs: null }, NOW), 'stopped')
  assert.notEqual(agentColor('running'), agentColor('stopped'))
  assert.deepEqual(slotBoxes([agent], 3).map(s => s.name), ['a', null, null])
  assert.equal(slotBoxes([agent, agent], 1).length, 2, 'agents over the cap still show')
})

test('the pane draws every section from the snapshot', async () => {
  const snap = await collect(fakeIo(world()), { repo: '/r', config, nowMs: NOW }, newCache())
  const tiles = signoffTiles(snap)
  assert.deepEqual(tiles.map(t => [t.key, t.count]), [['decision', 2], ['review', 3], ['test', 1], ['concept', 0], ['action', 1]])
  const noop = () => {}
  const actions = { refresh: noop, askAction: noop, confirmAction: noop, cancelAction: noop, openPreviews: noop }
  const tree = renderPanel(textUi, { snapshot: snap, isConfirming: false, notice: null, problem: null }, actions)
  const text = toText(tree).join('\n')
  for (const want of ['AGENTS', '4 of 3 slots', 'LOCKS', 'BACKLOG', 'WAITING FOR SAM', 'CHECKS AND PRS', 'DEPLOY STAGING', 'PREVIEWS', '♥ heartbeat busy', '[next]', 'Ship the importer first']) {
    assert.ok(text.includes(want), `missing ${want}\n${text}`)
  }
  assert.deepEqual(findAll(tree, 'Button').map(b => b.props.key), ['refresh', 'open-previews'], 'a running action shows no button')
  const idle = { ...snap, actionRun: { ...snap.actionRun, state: 'ok' } }
  const ready = renderPanel(textUi, { snapshot: idle, isConfirming: false, notice: null, problem: null }, actions)
  assert.deepEqual(findAll(ready, 'Button').map(b => b.props.key), ['refresh', 'action', 'open-previews'])
  const asking = renderPanel(textUi, { snapshot: idle, isConfirming: true, notice: null, problem: null }, actions)
  assert.deepEqual(findAll(asking, 'Button').map(b => b.props.key), ['refresh', 'action-confirm', 'action-cancel', 'open-previews'])
  assert.ok(toText(asking).join('\n').includes('Deploy main to staging?'))
  const plain = renderPanel(textUi, { snapshot: { ...snap, action: null, decisions: null, reviewNotes: null }, isConfirming: false, notice: null, problem: null }, actions)
  assert.equal(toText(plain).join('\n').includes('DEPLOY STAGING'), false, 'no action configured: no section')
  const empty = renderPanel(textUi, { snapshot: null, isConfirming: false, notice: null, problem: 'Not set up' }, actions)
  assert.ok(toText(empty).join('\n').includes('Not set up'))
})

const USAGE_MAIN = {
  schema: 1,
  account: 'main',
  plan: 'Team',
  readAt: NOW - 2 * MIN,
  windows: [
    { id: 'five_hour', label: '5 hours', percentUsed: 41, resetsAt: NOW + 130 * MIN },
    { id: 'seven_day', label: 'Week', percentUsed: 95.5, resetsAt: NOW + 3 * 86_400_000 },
  ],
}

test('usage: parse a reading, clamp, stale after 15 minutes', () => {
  const u = parseUsage(JSON.stringify(USAGE_MAIN), 'main', 'Main', NOW)
  assert.deepEqual([u.plan, u.isStale, u.windows.map(w => [w.id, w.percentUsed, w.resetsAtMs])], ['Team', false, [['five_hour', 41, NOW + 130 * MIN], ['seven_day', 95.5, NOW + 3 * 86_400_000]]])
  assert.equal(parseUsage(JSON.stringify(USAGE_MAIN), 'main', 'Main', NOW + 12 * MIN).isStale, false)
  assert.equal(parseUsage(JSON.stringify(USAGE_MAIN), 'main', 'Main', NOW + 14 * MIN).isStale, true)
  const odd = parseUsage(JSON.stringify({ windows: [{ label: 'x', percentUsed: 250 }, { label: 'no percent' }] }), 'agents', 'A', NOW)
  assert.deepEqual([odd.windows.length, odd.windows[0].percentUsed, odd.isStale], [1, 100, true])
  assert.throws(() => parseUsage('{"windows":[]}', 'main', 'Main', NOW))
  assert.throws(() => parseUsage('{nope', 'main', 'Main', NOW))
})

test('usage: gauge colours and reset text', () => {
  assert.equal(usageGauge(0).filled, 0)
  assert.equal(usageGauge(50).filled, 5)
  assert.notEqual(usageGauge(50).color, usageGauge(75).color)
  assert.notEqual(usageGauge(75).color, usageGauge(95).color)
  assert.match(resetText(NOW + 130 * MIN, NOW), /\(in 2h 10m\)$/)
  assert.match(resetText(NOW + 3 * 86_400_000, NOW), /^resets [A-Z][a-z]{2} \d\d:\d\d \(in 3d/)
  assert.equal(resetText(null, NOW), 'reset unknown')
  assert.match(resetText(NOW - MIN, NOW), /\(due\)$/)
})

test('collect: both accounts, a missing file, a bad file, labels, live account per agent', async () => {
  const w = world()
  w.files['/r/tmp/ops/usage/main.json'] = JSON.stringify(USAGE_MAIN)
  w.files['/r/tmp/ops/usage/agents.json'] = '{nope'
  w.runs.push([has('/r/tools/ops-kit/claude-agents.sh'), ok(JSON.stringify([{ name: 'bglive', state: 'working' }, { name: 'demo-heartbeat', state: 'working' }, { name: 'lead' }]))])
  w.runs.push([has('claude', 'agents'), ok(JSON.stringify([{ name: 'bggone', state: 'done' }, { name: 'lead' }]))])
  const cfg = { ...config, agentsAccount: true, accounts: { agents: 'Max' } }
  const snap = await collect(fakeIo(w), { repo: '/r', config: cfg, nowMs: NOW }, newCache())
  assert.deepEqual(snap.usage.map(u => [u.account, u.label, u.windows.length]), [['main', 'Main', 2], ['agents', 'Max', 0]])
  assert.match(snap.usage[1].error, /^unreadable/)
  const by = Object.fromEntries(snap.agents.map(a => [a.name, a]))
  assert.deepEqual([by.bglive.account, by.bggone.account, by.api.account], ['agents', 'main', null], 'live lists; interactive names do not count')
  assert.equal(snap.heartbeatAccount, 'agents')
  // Without the second account only the main reading is looked up.
  const one = await collect(fakeIo(world()), { repo: '/r', config, nowMs: NOW }, newCache())
  assert.deepEqual(one.usage.map(u => [u.account, u.error]), [['main', 'no reading yet']])
  assert.deepEqual(one.errors, [])
  assert.equal(one.agents.find(a => a.name === 'bglive').account, null)
  assert.deepEqual(parseAgentNames('[{"name":"a","state":"working"},{"name":"b"},{"id":"c","state":"done"}]'), ['a', 'c'])
})

test('pane: usage rows, stale reading, heartbeat account', async () => {
  const w = world()
  w.files['/r/tmp/ops/usage/main.json'] = JSON.stringify(USAGE_MAIN)
  w.files['/r/tmp/ops/usage/agents.json'] = JSON.stringify({ ...USAGE_MAIN, account: 'agents', readAt: NOW - 40 * MIN })
  w.runs.push([has('/r/tools/ops-kit/claude-agents.sh'), ok(JSON.stringify([{ name: 'bglive', state: 'working' }]))])
  const snap = await collect(fakeIo(w), { repo: '/r', config: { ...config, agentsAccount: true }, nowMs: NOW }, newCache())
  const noop = () => {}
  const actions = { refresh: noop, askAction: noop, confirmAction: noop, cancelAction: noop, openPreviews: noop }
  const text = toText(renderPanel(textUi, { snapshot: snap, isConfirming: false, notice: null, problem: null }, actions)).join('\n')
  assert.match(text, /USAGE/)
  assert.match(text, /Main\s+Team/)
  assert.match(text, /5 hours\s+━+╌+\s+41%/)
  assert.match(text, /Week\s+━+╌*\s+96%/)
  assert.match(text, /resets .*\(in 2h 10m\)/)
  assert.match(text, /reading 40m old \(stale\)/)
  assert.match(text, /♥ heartbeat/)
})

// --- lanes -------------------------------------------------------------------

const LANES = [
  { id: 'core', label: 'Core', cap: 1, owns: [], minReady: 2 },
  { id: 'ui', label: 'UI', cap: 2, owns: [], minReady: 2 },
  { id: 'flex', label: 'Flex', cap: 1, owns: [], minReady: 0 },
]
const bitem = (id, status, extra = {}) => ({ id, title: `Title ${id}`, track: 'x', size: 'M', status, priority: null, rank: 1, dependsOn: [], blockedBy: null, agent: null, ...extra })
const backlogOf = (items, lanes = LANES) => parseBacklog(JSON.stringify({ schema: 1, items }), lanes)

test('without lanes there is no lane logic; an unknown lane falls under flex with a note', () => {
  const none = parseBacklog(JSON.stringify({ schema: 1, items: [bitem('B-1', 'ready')] }))
  assert.deepEqual([none.lanes, none.items[0].lane], [[], null])
  assert.deepEqual(laneViews([], [], none), [])
  const b = backlogOf([bitem('B-1', 'ready', { lane: 'core' }), bitem('B-2', 'ready', { lane: 'moon' }), bitem('B-3', 'ready')])
  assert.deepEqual(b.items.map(i => [i.id, i.lane, i.laneNote]), [['B-1', 'core', null], ['B-2', 'flex', 'moon'], ['B-3', 'flex', null]])
  assert.match(backlogNote(b.items[1]), /unknown lane "moon"/)
  const own = parseBacklog(JSON.stringify({ schema: 1, lanes: [{ id: 'a', label: 'Alpha', cap: 2 }, { id: 'b' }], items: [] }), LANES)
  assert.deepEqual(own.lanes.map(l => [l.id, l.label, l.cap, l.minReady]), [['a', 'Alpha', 2, 2], ['b', 'b', 1, 2]], "the file's lanes win; minReady defaults to 2")
})

test('an agent takes its lane from status.json, else from its in-progress item, else the fallback', () => {
  const b = backlogOf([bitem('B-1', 'in_progress', { lane: 'ui', agent: 'painter' }), bitem('B-2', 'ready', { lane: 'core', agent: 'x' })])
  assert.equal(agentLane({ name: 'painter', lane: null }, b, LANES), 'ui')
  assert.equal(agentLane({ name: 'painter', lane: 'core' }, b, LANES), 'core', 'status.json wins')
  assert.equal(agentLane({ name: 'x', lane: null }, b, LANES), 'flex', 'only an in-progress item counts')
  assert.equal(agentLane({ name: 'y', lane: 'moon' }, b, LANES), 'flex')
  assert.equal(agentLane({ name: 'y', lane: null }, null, []), null)
})

test('lanes: over cap, free lanes, each lane its own next and ready count', () => {
  const b = backlogOf([
    bitem('B-1', 'ready', { lane: 'core', rank: 1 }),
    bitem('B-2', 'ready', { lane: 'core', rank: 2 }),
    bitem('B-3', 'ready', { lane: 'ui', rank: 3, dependsOn: ['B-9'] }),
    bitem('B-4', 'defined', { lane: 'ui', rank: 4 }),
  ])
  const ag = (name, lane) => ({ name, lane, state: 'running' })
  const views = laneViews(LANES, [ag('a', 'core'), ag('b', 'core'), ag('c', 'ui'), ag('d', 'ui')], b)
  const by = id => views.find(v => v.id === id)
  assert.deepEqual([by('core').isOver, by('ui').isOver, by('flex').isOver], [true, false, false])
  assert.deepEqual(freeLanes(views).map(l => l.id), ['flex'], 'a lane at its cap is not free')
  assert.deepEqual([by('core').next.id, by('core').ready], ['B-1', 2])
  assert.deepEqual([by('ui').next, by('ui').ready, by('ui').open], [null, 0, 2], 'a ready item that waits is not pickable')
  assert.deepEqual(b.items.filter(i => i.isNext).map(i => i.id), ['B-1'])
})

test('ready tone: minReady or more green, fewer amber, none red; a lane that keeps none stays plain', () => {
  assert.equal(readyTone(2, 2).color, readyTone(5, 2).color)
  assert.notEqual(readyTone(1, 2).color, readyTone(2, 2).color)
  assert.deepEqual([readyTone(0, 2).text, readyTone(1, 2).text], ['no ready brief', '1 ready'])
  assert.equal(readyTone(0, 0).text, '0 ready')
})

test('the pane shows a row per lane, the free lanes in the backlog header and the backlog grouped', async () => {
  const w = world({
    files: {
      '/r/tmp/ops/backlog.json': JSON.stringify({
        schema: 1,
        lanes: LANES,
        items: [bitem('B-1', 'ready', { lane: 'core', title: 'Hash pins' }), bitem('B-2', 'ready', { lane: 'core', rank: 2 }), bitem('B-3', 'ready', { lane: 'ui', rank: 3, dependsOn: ['B-7'] })],
      }),
      '/r/tmp/ops/status.json': JSON.stringify({ ...STATUS, agents: [{ name: 'u1', lane: 'ui' }, { name: 'u2', lane: 'ui' }, { name: 'u3', lane: 'ui' }] }),
    },
  })
  const snap = await collect(fakeIo(w), { repo: '/r', config, nowMs: NOW }, newCache())
  const noop = () => {}
  const actions = { refresh: noop, askAction: noop, confirmAction: noop, cancelAction: noop, openPreviews: noop }
  const text = toText(renderPanel(textUi, { snapshot: snap, isConfirming: false, notice: null, problem: null }, actions)).join('\n')
  assert.match(text, /Core 0\/1/)
  assert.match(text, /UI 3\/2/)
  assert.match(text, /over cap/)
  assert.match(text, /next B-1/)
  assert.match(text, /Hash pins/)
  assert.match(text, /next: none/)
  assert.match(text, /BACKLOG.*free: core, flex/)
  assert.match(text, /CORE\s+2 open/)
})
