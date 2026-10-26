// The ops pane through the engine's own kit: `claude plugin test plugin`.
// The world beneath the plugin (files, processes, the clock) is stubbed here,
// so nothing on the machine is read or run.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T20:00:00Z')

const STATUS = {
  schema: 1,
  agentLimit: 3,
  agents: [{ name: 'api', task: 'Importer', branch: 'api-x', step: 'docs', startedAt: '2026-10-07T19:00:00Z' }],
  signoff: [{ item: 'Try the importer', kind: 'test', where: 'staging', since: '2026-10-07T19:44:53Z' }],
}

const PROJECT = {
  owner: 'Sam',
  locks: [{ name: 'check', timeoutMin: 120 }, { name: 'db', timeoutMin: 30 }],
  decisionLog: 'docs/decisions.md',
  action: { label: 'Deploy staging', command: 'make deploy', confirm: 'Deploy main to staging?' },
  gh: '/bin/gh',
  autoOpen: false,
}

const BASE_FILES: Record<string, string> = {
  '/r/.claude/foreman.json': JSON.stringify(PROJECT),
  '/r/tmp/ops/status.json': JSON.stringify(STATUS),
  '/r/tmp/ops/backlog.json': JSON.stringify({ schema: 1, items: [{ id: 'B-1', title: 'Export', status: 'ready', rank: 1 }] }),
  '/r/docs/decisions.md': '## Decision log\n\n| # | Date | Decision | Status |\n|---|---|---|---|\n| 12 | 2026-10 | Ops panel | Proposed |\n',
}

const DIRS: Record<string, string[]> = { '/h/.claude/sessions': ['1.json', '2.json'] }

const PANE = {
  title: 'Ops',
  isFocused: true,
  bodyColumns: 56,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

function answer(argv: readonly string[]): { exitCode: number; stdout: string } {
  const has = (word: string): boolean => argv.includes(word)
  if (has('--git-common-dir')) return { exitCode: 0, stdout: '/r/.git\n' }
  if (has('worktree')) return { exitCode: 0, stdout: 'worktree /r\nbranch refs/heads/main\n\nworktree /w/api\nbranch refs/heads/api-x\n' }
  if (argv[0] === '/bin/gh') return { exitCode: 0, stdout: '[{"number":81,"title":"Importer","state":"OPEN","headRefName":"api-x","mergedAt":null,"url":"https://github.com/x/y/pull/81"}]' }
  if (has('--detach')) return { exitCode: 0, stdout: 'run_action: running in the background (pid 7), log tmp/ops/action.log\n' }
  return { exitCode: 0, stdout: '' }
}

/** Answers every call the plugin makes; records the commands it runs. */
function world(on: On, files: Record<string, string>, cwd = '/r/.claude/worktrees/api', env: Record<string, string> = {}): string[][] {
  return worldWithClock(on, files, cwd, env).runs
}

function worldWithClock(on: On, files: Record<string, string>, cwd: string, env: Record<string, string> = {}): { runs: string[][]; clock: MockClock } {
  const runs: string[][] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, env)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  // A folder exists when a listed file is inside it (the lock folders hold only their owner file).
  on('fs.exists', (_$, e) => ({ value: e.path in files || e.path in DIRS || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', (_$, e) => {
    const names = DIRS[e.path]
    if (names === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: NOW - 60_000, isLink: false } }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return { value: { ...answer(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'foreman', title: 'Ops', isShown: true, isFocused: false, isPlaced: true }] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  return { runs, clock }
}

const SURFACES = ['desktop', 'terminal'] as const

/** `/ops` typed at the prompt. */
const OPS = {
  command: 'ops',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

test('/ops opens the pane and it draws every section on desktop and terminal', async ($, on) => {
  world(on, BASE_FILES)
  await $.command.run(OPS)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'foreman', surface, component: 'Pane', requestId: 'foreman', props: PANE })
    for (const heading of ['AGENTS', 'LOCKS', 'BACKLOG', 'WAITING FOR SAM', 'CHECKS AND PRS', 'DEPLOY STAGING', 'PREVIEWS']) {
      expect(await ui.find({ type: 'Text', text: heading })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /1 of 3 slots/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'next' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^db/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /#12 Ops panel/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /pull\/81/ })).toBeDefined()
    expect(await ui.find({ key: 'action' })).toBeDefined()
    await ui.unmount()
  }
})

test('the action asks first, then starts the runner detached with the configured command', async ($, on) => {
  const runs = world(on, BASE_FILES)
  await $.command.run(OPS)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE })
  await ui.press({ key: 'action' })
  expect(await ui.find({ key: 'action-confirm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Deploy main to staging\?/ })).toBeDefined()
  expect(runs.some(argv => argv.includes('--detach'))).toBe(false)
  await ui.press({ key: 'action-confirm' })
  expect(runs.filter(argv => argv.includes('--detach'))).toEqual([['/bin/bash', '/r/tools/foreman/run_action.sh', '--detach', 'make deploy']])
  expect(await ui.find({ type: 'Text', text: /Started/ })).toBeDefined()
  expect(await ui.find({ key: 'action-confirm' })).toBeUndefined()
})

test('Cancel runs nothing', async ($, on) => {
  const runs = world(on, BASE_FILES)
  await $.command.run(OPS)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: PANE })
  await ui.press({ key: 'action' })
  await ui.press({ key: 'action-cancel' })
  expect(await ui.find({ key: 'action' })).toBeDefined()
  expect(runs.some(argv => argv.includes('--detach'))).toBe(false)
})

test('an action without a confirm runs at the first press', async ($, on) => {
  const files = { ...BASE_FILES, '/r/.claude/foreman.json': JSON.stringify({ ...PROJECT, action: { label: 'Report', command: 'make report' } }) }
  const runs = world(on, files)
  await $.command.run(OPS)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE })
  await ui.press({ key: 'action' })
  expect(runs.filter(argv => argv.includes('--detach')).length).toBe(1)
})

test('a repo that is not set up says how to set it up', async ($, on) => {
  world(on, {}, '/r')
  await $.command.run(OPS)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE })
  expect(await ui.find({ type: 'Text', text: /run \/foreman:init/ })).toBeDefined()
})

test('the timer picks up a setup done after the session started', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = worldWithClock(on, files, '/r')
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE })
  expect(await ui.find({ type: 'Text', text: /run \/foreman:init/ })).toBeDefined()
  Object.assign(files, BASE_FILES)
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Text', text: 'AGENTS' })).toBeDefined()
})

test('the locks are read from OPS_AGENT_LOCKS when it is set', async ($, on) => {
  const files = { ...BASE_FILES, '/l/locks/check.lock/owner': '4711\n', '/r/tmp/agent-locks/locks/check.lock/owner': '4712\n' }
  world(on, files, '/r', { OPS_AGENT_LOCKS: '/l' })
  await $.command.run(OPS)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE })
  expect(await ui.find({ type: 'Text', text: / pid 4711 / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / pid 4712 / })).toBeUndefined()
})

test('agent cards show the model badge and the heartbeat sits in the header', async ($, on) => {
  const files = {
    ...BASE_FILES,
    '/r/.claude/foreman.json': JSON.stringify({ ...PROJECT, heartbeatName: 'demo-heartbeat' }),
    '/r/tmp/ops/status.json': JSON.stringify({
      ...STATUS,
      agents: [{ ...STATUS.agents[0], model: 'sonnet' }, { name: 'bg1', model: 'opus', kind: 'bg', sessionName: 'bg1', task: 't', branch: '', step: 's', startedAt: '2026-10-07T19:00:00Z' }],
    }),
    '/h/.claude/sessions/1.json': JSON.stringify({ pid: 11, name: 'bg1', kind: 'bg', status: 'busy', startedAt: NOW, cwd: '/r/.claude/worktrees/bg1' }),
    '/h/.claude/sessions/2.json': JSON.stringify({ pid: 12, name: 'demo-heartbeat', kind: 'bg', status: 'idle', startedAt: NOW, cwd: '/r' }),
  }
  world(on, files, '/r', { HOME: '/h' })
  await $.command.run(OPS)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'foreman', surface, component: 'Pane', requestId: 'foreman', props: PANE })
    expect(await ui.find({ type: 'Text', text: / sonnet / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / opus / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /heartbeat idle/ })).toBeDefined()
    await ui.unmount()
  }
})
