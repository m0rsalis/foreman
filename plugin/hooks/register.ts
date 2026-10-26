// Ops panel: a pane that shows the agents and their slots, the shared locks,
// the backlog, what waits for the owner, checks and PRs, an optional action
// button and the newest previews. Data readers: data.ts; drawing: view.ts.
//
// `$` is only handed to functions declared at the top of this file, so
// `claude plugin validate` can list every call the mod makes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { OpsConfig } from '../types'
import { BIN, DEFAULTS, LOCAL_CONFIG, PROJECT_CONFIG, collect, inRepo, newCache, parseConfig } from './data.ts'
import type { Io } from './data.ts'
import { renderPanel } from './view.ts'
import type { PanelActions } from './view.ts'

const PANE = 'foreman'
const snapshot = atom({ plugin: 'foreman', key: 'snapshot' } as const, null)
const isConfirming = atom({ plugin: 'foreman', key: 'isConfirming' } as const, false)
const notice = atom({ plugin: 'foreman', key: 'notice' } as const, null)

type Context = { repo: string; config: OpsConfig }

// Module state: rebuilt on a reload, which only costs one slow refresh.
const cache = newCache()
let ctx: Context | null = null
let isBusy = false
/** A forced refresh asked for while another ran: run it when that one ends. */
let isForcePending = false

function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.slice(0, 200) ?? ''
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ioOf($: EngineInterface): Io {
  return {
    read: path => $.fs.read(path),
    exists: path => $.fs.exists(path),
    list: async path => (await $.fs.list(path)).map(e => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs })),
    mtimeMs: async path => (await $.fs.stat(path)).mtimeMs,
    run: async (argv, cwd, timeoutMs) => {
      const init = cwd === undefined ? { timeoutMs: timeoutMs ?? 15_000 } : { cwd, timeoutMs: timeoutMs ?? 15_000 }
      const r = await $.process.run(argv, init)
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    // `$.env.get` takes a string literal, so the name is spelled here.
    agentLocksEnv: () => $.env.get('OPS_AGENT_LOCKS'),
    homeEnv: () => $.env.get('HOME'),
  }
}

async function readIfThere($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : null
}

/**
 * The main checkout (from any of its worktrees) and its merged config. A repo
 * counts as set up when it has the project config or tmp/ops/status.json.
 */
async function locate($: EngineInterface): Promise<Context | string> {
  const cwd = await $.session.cwd()
  const r = await $.process
    .run([BIN.git, '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 10_000 })
    .catch(() => null)
  if (r === null || r.exitCode !== 0) return `Not in a git checkout (${cwd}).`
  const common = r.stdout.trim()
  const repo = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : cwd
  try {
    const project = await readIfThere($, `${repo}/${PROJECT_CONFIG}`)
    const local = await readIfThere($, `${repo}/${LOCAL_CONFIG}`)
    if (project === null && local === null && !(await $.fs.exists(`${repo}/tmp/ops/status.json`))) {
      return `Foreman is not set up in ${repo}: run /foreman:init there.`
    }
    return { repo, config: parseConfig(project, local) }
  } catch (err) {
    return errorText(err)
  }
}

async function refresh($: EngineInterface, isForced: boolean): Promise<void> {
  if (isBusy) {
    isForcePending = isForcePending || isForced
    return
  }
  isBusy = true
  try {
    if (ctx === null || isForced) {
      const found = await locate($)
      if (typeof found === 'string') {
        ctx = null
        await update($, snapshot, () => null)
        await update($, notice, () => found)
        return
      }
      ctx = found
    }
    const nowMs = await $.clock.now()
    const snap = await collect(ioOf($), { repo: ctx.repo, config: ctx.config, nowMs, isForced }, cache)
    await update($, snapshot, () => snap)
  } finally {
    isBusy = false
  }
  if (isForcePending) {
    isForcePending = false
    await refresh($, true)
  }
}

async function refreshNow($: EngineInterface): Promise<void> {
  await update($, notice, () => null)
  await refresh($, true)
}

/** Refreshes on the timer only while the pane is open. */
async function tick($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE)) await refresh($, false)
}

/** Starts the configured action through the repo's run_action.sh, detached. */
async function startAction($: EngineInterface): Promise<void> {
  await update($, isConfirming, () => false)
  if (ctx === null || ctx.config.action === null) return
  const runner = `${inRepo(ctx.config.toolsDir, ctx.repo)}/run_action.sh`
  const text = await $.process
    .run([BIN.bash, runner, '--detach', ctx.config.action.command], { cwd: ctx.repo, timeoutMs: 20_000 })
    .then(r => (r.exitCode === 0 ? `Started. ${lastLine(r.stdout)}` : `Did not start: ${lastLine(r.stderr + r.stdout)}`))
    .catch((err: unknown) => `Did not start: ${errorText(err)}`)
  await update($, notice, () => text)
  await refresh($, false)
}

async function askAction($: EngineInterface): Promise<void> {
  if (ctx?.config.action?.confirm === null) {
    await startAction($)
    return
  }
  await update($, isConfirming, () => true)
}

async function openPreviews($: EngineInterface): Promise<void> {
  const shown = await read($, snapshot)
  const paths = (shown?.previews ?? []).map(g => g.files[0]?.path).filter((p): p is string => p !== undefined)
  if (paths.length === 0) return
  const r = await $.process.run([BIN.open, ...paths], { timeoutMs: 15_000 }).catch(() => null)
  const text = r !== null && r.exitCode === 0 ? `Opened ${paths.length} newest previews.` : 'Could not open the previews.'
  await update($, notice, () => text)
}

function actionsFor($: EngineInterface): PanelActions {
  return {
    refresh: () => void refreshNow($),
    askAction: () => void askAction($),
    cancelAction: () => void update($, isConfirming, () => false),
    confirmAction: () => void startAction($),
    openPreviews: () => void openPreviews($),
  }
}

async function start($: EngineInterface): Promise<void> {
  const found = await locate($)
  // The timer runs either way, so a config written later is picked up.
  const seconds = typeof found === 'string' ? DEFAULTS.refreshSeconds : found.config.refreshSeconds
  $.clock.every(seconds * 1000, () => void tick($))
  if (typeof found === 'string') {
    await update($, notice, () => found)
    return
  }
  ctx = found
  if (found.config.autoOpen) void $.ui.open({ id: PANE, title: 'Ops' })
  void refresh($, true)
}

async function addCommand($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: 'ops', description: 'Open the ops panel (agents, locks, backlog, sign-off, checks)', immediate: true })
  } catch (err) {
    $.ui.log(`foreman: /ops not registered: ${errorText(err)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($)
    await addCommand($)
    return started
  })

  on('command.run', { command: 'ops' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Ops' })
    await refresh($, true)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const shown = await read($, snapshot)
    const message = await read($, notice)
    return renderPanel(
      $.ui.resolve(e),
      {
        snapshot: shown,
        isConfirming: await read($, isConfirming),
        notice: shown === null ? null : message,
        problem: shown === null ? message : null,
      },
      actionsFor($),
    )
  })
}
