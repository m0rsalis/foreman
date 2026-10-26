// The ops panel's data readers. Pure parsing plus one `collect` that reaches
// files and processes only through the `Io` it is handed: the mod hands it
// `$.fs` and `$.process`, the Node self-test (test/) a fake or the real disk.
// No Node and no `$` here, so both can import this file.

import type {
  OpsActionRun,
  OpsActionSpec,
  OpsAgent,
  OpsBacklog,
  OpsBacklogItem,
  OpsBacklogStatus,
  OpsLaneDef,
  OpsLaneView,
  OpsAccount,
  OpsUsage,
  OpsUsageWindow,
  OpsCheck,
  OpsCheckStrip,
  OpsConfig,
  OpsDocItems,
  OpsLinkRef,
  OpsLock,
  OpsLockSpec,
  OpsPreviewFile,
  OpsPreviewGroup,
  OpsPr,
  OpsPrs,
  OpsSession,
  OpsSignoffGroup,
  OpsSnapshot,
  OpsTicket,
} from '../types'

// --- the outside world ------------------------------------------------------

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

export type Io = {
  read: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<DirEntry[]>
  mtimeMs: (path: string) => Promise<number>
  run: (argv: string[], cwd?: string, timeoutMs?: number) => Promise<RunResult>
  /** The OPS_AGENT_LOCKS environment variable (the mod's `$.env`), undefined when unset. */
  agentLocksEnv: () => Promise<string | undefined>
  /** The HOME environment variable (the Claude sessions folder is under it); optional. */
  homeEnv?: () => Promise<string | undefined>
}

// System tools by absolute path: an app started from the Dock has a short PATH.
export const BIN = {
  git: '/usr/bin/git',
  find: '/usr/bin/find',
  stat: '/usr/bin/stat',
  tail: '/usr/bin/tail',
  lsof: '/usr/sbin/lsof',
  kill: '/bin/kill',
  open: '/usr/bin/open',
  bash: '/bin/bash',
} as const

export const DEFAULTS = {
  refreshSeconds: 5,
  stallMinutes: 20,
  agentCap: 4,
  /** Slow readers (gh, worktree scans, docs, previews) run this often. */
  slowMs: 60_000,
} as const

/** The shared config, relative to the main checkout. */
export const PROJECT_CONFIG = '.claude/ops-kit.json'
/** This machine's overrides, relative to the main checkout. */
export const LOCAL_CONFIG = 'tmp/ops/config.json'

export const PREVIEW_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'wav', 'flac', 'm4a', 'mp3', 'aiff', 'mp4', 'mov', 'html', 'pdf', 'md',
]

// --- small helpers ----------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.split('\n')[0]?.slice(0, 160) ?? 'error'
}

/** Milliseconds since the epoch for an ISO time or date, else null. */
export function parseTimeMs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return null
  const ms = Date.parse(v.trim())
  return Number.isNaN(ms) ? null : ms
}

/** "45s", "12m", "2h 05m", "3d 4h": how long ago or how long for. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** A file:// URL for an absolute path, every segment encoded. */
export function fileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

/** An absolute path for a config path: relative ones are taken from the main checkout. */
export function inRepo(path: string, repo: string): string {
  const absolute = path.startsWith('/') ? path : `${repo}/${path}`
  return absolute.replace(/\/+$/, '')
}

// --- config -------------------------------------------------------------------

export const LOCK_NAME = /^[a-z0-9][a-z0-9_-]*$/i

export function defaultConfig(): OpsConfig {
  return {
    owner: 'the owner',
    agentCap: DEFAULTS.agentCap,
    toolsDir: 'tools/ops-kit',
    locksDir: 'tmp/agent-locks',
    locks: [{ name: 'check', timeoutMin: 120 }],
    previews: ['tmp/previews'],
    action: null,
    decisionLog: null,
    reviewNotesDir: null,
    signoffKinds: ['decision', 'review', 'test', 'concept', 'action'],
    heartbeatName: 'ops-heartbeat',
    gh: 'gh',
    refreshSeconds: DEFAULTS.refreshSeconds,
    stallMinutes: DEFAULTS.stallMinutes,
    autoOpen: true,
    agentsAccount: false,
    claude: 'claude',
    accounts: { main: null, agents: null },
    lanes: [],
  }
}

/** `locks` as a list of names, of {name, timeoutMin}, or a {name: minutes} map. */
export function parseLocks(v: unknown): OpsLockSpec[] | null {
  const out: OpsLockSpec[] = []
  const add = (name: unknown, minutes: unknown): void => {
    const n = str(name)
    if (n === null || !LOCK_NAME.test(n)) throw new Error(`lock name ${JSON.stringify(name)} is not a plain name`)
    out.push({ name: n, timeoutMin: typeof minutes === 'number' && minutes > 0 ? minutes : 60 })
  }
  if (Array.isArray(v)) {
    for (const l of v) {
      if (isRecord(l)) add(l.name, l.timeoutMin)
      else add(l, undefined)
    }
  } else if (isRecord(v)) {
    for (const [name, minutes] of Object.entries(v)) add(name, minutes)
  } else return null
  return out
}

function parseAction(v: unknown): OpsActionSpec | null {
  if (!isRecord(v)) return null
  const command = str(v.command)
  if (command === null) return null
  return { label: str(v.label) ?? 'Run action', command, confirm: str(v.confirm) }
}

function applyLayer(config: OpsConfig, raw: Record<string, unknown>): void {
  const s = (key: keyof OpsConfig): string | null => str(raw[key])
  const n = (key: keyof OpsConfig, min: number): number | null => {
    const v = raw[key]
    return typeof v === 'number' && v >= min ? v : null
  }
  config.owner = s('owner') ?? config.owner
  config.agentCap = n('agentCap', 1) ?? config.agentCap
  config.toolsDir = s('toolsDir')?.replace(/\/+$/, '') ?? config.toolsDir
  config.locksDir = s('locksDir')?.replace(/\/+$/, '') ?? config.locksDir
  config.locks = parseLocks(raw.locks) ?? config.locks
  if (Array.isArray(raw.previews)) config.previews = raw.previews.map(str).filter((p): p is string => p !== null)
  if ('action' in raw) config.action = parseAction(raw.action)
  if ('decisionLog' in raw) config.decisionLog = s('decisionLog')
  if ('reviewNotesDir' in raw) config.reviewNotesDir = s('reviewNotesDir')
  if (Array.isArray(raw.signoffKinds)) {
    const kinds = raw.signoffKinds.map(str).filter((k): k is string => k !== null)
    if (kinds.length > 0) config.signoffKinds = kinds
  }
  config.heartbeatName = s('heartbeatName') ?? config.heartbeatName
  config.gh = s('gh') ?? config.gh
  config.refreshSeconds = n('refreshSeconds', 1) ?? config.refreshSeconds
  config.stallMinutes = n('stallMinutes', 1) ?? config.stallMinutes
  if (typeof raw.autoOpen === 'boolean') config.autoOpen = raw.autoOpen
  if (typeof raw.agentsAccount === 'boolean') config.agentsAccount = raw.agentsAccount
  config.claude = s('claude') ?? config.claude
  const accounts = raw.accounts
  if (isRecord(accounts)) {
    const label = (k: string): string | null => {
      const a = accounts[k]
      return isRecord(a) ? str(a.label) : null
    }
    config.accounts = { main: label('main'), agents: label('agents') }
  }
  if ('lanes' in raw) config.lanes = parseLanes(raw.lanes)
}

/**
 * The project config with the local one on top; null text means the file is
 * missing. A file that is not a JSON object throws, naming the file.
 */
export function parseConfig(projectText: string | null, localText: string | null = null): OpsConfig {
  const config = defaultConfig()
  for (const [name, text] of [[PROJECT_CONFIG, projectText], [LOCAL_CONFIG, localText]] as const) {
    if (text === null) continue
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new Error(`${name}: ${errText(err)}`)
    }
    if (!isRecord(raw)) throw new Error(`${name} is not an object`)
    try {
      applyLayer(config, raw)
    } catch (err) {
      throw new Error(`${name}: ${errText(err)}`)
    }
  }
  return config
}

/**
 * The lock folder queue.sh writes: OPS_AGENT_LOCKS if set (as the script reads
 * it), else the config's `locksDir`. A relative path is taken from the main
 * checkout; an empty value counts as unset, like the script's `${VAR:-...}`.
 */
export function resolveLocksDir(envValue: string | undefined, config: OpsConfig, repo: string): string {
  return inRepo(str(envValue) ?? config.locksDir, repo)
}

// --- status.json --------------------------------------------------------------

export type RawAgent = {
  name: string
  task: string
  branch: string
  step: string
  next: string | null
  startedMs: number | null
  model: string | null
  /** 'bg' for a background Claude session, else an in-process agent. */
  kind: 'bg' | 'inproc'
  /** The background session's name (its name in the sessions folder). */
  sessionName: string | null
  /** 'main' or 'agents': the fallback when the live account lists do not name the session. */
  account: OpsAccount | null
  /** status.json `lane`; null when the agent has none (its backlog item then decides). */
  lane: string | null
}

export type RawSignoff = { item: string; kind: string; where: string | null; since: string | null }

export type StatusFile = {
  schema: number
  updatedMs: number | null
  agentLimit: number | null
  priority: string | null
  agents: RawAgent[]
  signoff: RawSignoff[]
}

/** tmp/ops/status.json, schema 1 or later (unknown fields are ignored). */
export function parseStatus(text: string): StatusFile {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('status.json is not an object')
  const schema = typeof raw.schema === 'number' ? raw.schema : 0
  if (schema < 1) throw new Error('status.json has no schema number')
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : [])
  const agents = list(raw.agents).map(a => ({
    name: str(a.name) ?? '?',
    task: str(a.task) ?? '',
    branch: str(a.branch) ?? '',
    step: str(a.step) ?? '',
    next: str(a.next),
    startedMs: parseTimeMs(a.startedAt),
    model: str(a.model),
    kind: a.kind === 'bg' ? ('bg' as const) : ('inproc' as const),
    sessionName: str(a.sessionName),
    account: a.account === 'main' || a.account === 'agents' ? (a.account as OpsAccount) : null,
    lane: str(a.lane),
  }))
  const signoff = list(raw.signoff).map(s => ({
    item: str(s.item) ?? '?',
    kind: str(s.kind) ?? 'other',
    where: str(s.where),
    since: str(s.since),
  }))
  return {
    schema,
    updatedMs: parseTimeMs(raw.updated),
    agentLimit: typeof raw.agentLimit === 'number' && raw.agentLimit >= 0 ? raw.agentLimit : null,
    priority: str(raw.priority),
    agents,
    signoff,
  }
}

/** "fix-a / fix-b" names two branches. */
export function branchesOf(field: string): string[] {
  return field
    .split(/\s+\/\s+|,\s*|\s+and\s+/)
    .map(b => b.trim())
    .filter(b => b !== '')
}

// --- backlog.json -----------------------------------------------------------

export const BACKLOG_STATUSES: OpsBacklogStatus[] = ['inbox', 'defined', 'ready', 'in_progress', 'review', 'blocked', 'done']

/** `in-progress` and `In Progress` read as `in_progress`. */
function backlogStatus(v: unknown): OpsBacklogStatus {
  const key = typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''
  return BACKLOG_STATUSES.find(s => s === key) ?? 'inbox'
}

/** A lane keeps this many ready briefs unless it says otherwise; the lane called flex keeps none. */
export const MIN_READY = 2

/** `lanes` as a list of {id, label, cap, owns, minReady}; empty when it is not a usable list. */
export function parseLanes(raw: unknown): OpsLaneDef[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).flatMap((l): OpsLaneDef[] => {
    const id = str(l.id)
    if (id === null) return []
    const owns = Array.isArray(l.owns) ? l.owns.map(str).filter((p): p is string => p !== null).join(', ') : str(l.owns)
    return [{
      id,
      label: str(l.label) ?? id,
      cap: typeof l.cap === 'number' ? l.cap : 1,
      owns: owns === '' ? null : owns,
      minReady: typeof l.minReady === 'number' ? l.minReady : id === 'flex' ? 0 : MIN_READY,
    }]
  })
}

/** The lane that takes what names no known lane: flex, else the last one. */
function fallbackLane(lanes: OpsLaneDef[]): string | null {
  const lane = lanes.find(l => l.id === 'flex') ?? lanes[lanes.length - 1]
  return lane === undefined ? null : lane.id
}

/** The lane an agent works in: its own `lane` when known, else its in-progress backlog item's lane, else flex. Null without lanes. */
export function agentLane(agent: { name: string; lane: string | null }, backlog: OpsBacklog | null, lanes: OpsLaneDef[]): string | null {
  const fallback = fallbackLane(lanes)
  if (fallback === null) return null
  if (agent.lane !== null) return lanes.some(l => l.id === agent.lane) ? agent.lane : fallback
  const item = backlog?.items.find(i => i.agent === agent.name && i.status === 'in_progress')
  return item?.lane ?? fallback
}

/** The panel's lanes in display order. An agent or item of a lane that is not listed counts under the fallback lane. */
export function laneViews(lanes: OpsLaneDef[], agents: OpsAgent[], backlog: OpsBacklog | null): OpsLaneView[] {
  const fallback = fallbackLane(lanes)
  const idOf = (id: string | null): string | null => (id !== null && lanes.some(l => l.id === id) ? id : fallback)
  return lanes.map(l => {
    const mine = agents.filter(a => idOf(a.lane) === l.id)
    const items = (backlog?.items ?? []).filter(i => idOf(i.lane) === l.id)
    const next = items.find(i => i.isNext)
    return {
      ...l,
      agents: mine,
      isOver: mine.length > l.cap,
      items,
      open: items.length,
      ready: items.filter(i => i.status === 'ready' && i.waitsFor.length === 0 && i.blockedBy === null).length,
      next: next === undefined ? null : { id: next.id, title: next.title },
    }
  })
}

/**
 * tmp/ops/backlog.json (schema 1): items ordered by the owner's priority (set
 * ones first, ascending) then the lead's rank; done items only counted. An item
 * waits for the dependencies that are not done (an unknown id counts as not
 * done); each lane's next item (with lanes; else the one overall) is its first
 * ready one that waits for nothing. Lanes are the file's `lanes`, else
 * `configLanes`; an item's lane is its `lane`, an unknown or missing one falls
 * under flex (the raw unknown value stays in `laneNote`).
 */
export function parseBacklog(text: string, configLanes: OpsLaneDef[] = []): OpsBacklog {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('backlog.json is not an object')
  if (!Array.isArray(raw.items)) throw new Error('backlog.json has no items list')
  const own = parseLanes(raw.lanes)
  const lanes = own.length > 0 ? own : configLanes
  const fallback = fallbackLane(lanes)
  const counts = Object.fromEntries(BACKLOG_STATUSES.map(s => [s, 0])) as Record<OpsBacklogStatus, number>
  type Row = Omit<OpsBacklogItem, 'waitsFor' | 'isNext'>
  const rows: Row[] = raw.items.filter(isRecord).map((r, i) => {
    const status = backlogStatus(r.status)
    counts[status] += 1
    const wanted = str(r.lane)
    const isKnown = wanted !== null && lanes.some(l => l.id === wanted)
    return {
      id: str(r.id) ?? '?',
      title: str(r.title) ?? '?',
      theme: str(r.theme),
      track: str(r.track),
      size: str(r.size),
      status,
      priority: typeof r.priority === 'number' ? r.priority : null,
      rank: typeof r.rank === 'number' ? r.rank : 1_000_000 + i,
      dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      blockedBy: str(r.blockedBy),
      agent: str(r.agent),
      pr: str(r.pr),
      lane: isKnown ? wanted : fallback,
      laneNote: wanted === null || isKnown || fallback === null ? null : wanted,
    }
  })
  const done = new Set(rows.filter(r => r.status === 'done').map(r => r.id))
  const open = rows
    .filter(r => r.status !== 'done')
    .sort((a, b) => {
      const pa = a.priority ?? Infinity
      const pb = b.priority ?? Infinity
      return pa === pb ? a.rank - b.rank : pa < pb ? -1 : 1
    })
    .map((r): OpsBacklogItem => ({ ...r, waitsFor: r.dependsOn.filter(d => !done.has(d)), isNext: false }))
  for (const lane of lanes.length === 0 ? [null] : lanes.map(l => l.id)) {
    const next = open.find(r => r.lane === lane && r.status === 'ready' && r.waitsFor.length === 0)
    if (next !== undefined) next.isNext = true
  }
  return { items: open, lanes, counts, doneCount: counts.done }
}

// --- sign-off ---------------------------------------------------------------

function kindLabel(kind: string): string {
  const words = kind.replace(/[-_]+/g, ' ')
  const plural = /s$/.test(words) ? words : `${words}s`
  return plural.charAt(0).toUpperCase() + plural.slice(1)
}

/**
 * Splits `where` into parts; a part that names a path gets its candidate:
 * absolute, or relative to the main checkout when it has a `/` or an extension.
 */
export function parseWhere(where: string | null, repo: string): OpsLinkRef[] {
  if (where === null) return []
  return where
    .split(/,\s*/)
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(text => {
      const token = text.replace(/[`'"]/g, '').split(/\s+/)[0] ?? ''
      let path: string | null = null
      if (token.startsWith('/')) path = token
      else if (token.includes('/') || /\.[a-z0-9]{1,5}$/i.test(token)) path = `${repo}/${token}`
      return { text, path: path?.replace(/\/+$/, '') ?? null }
    })
}

/** Groups in the configured kind order; unknown kinds after them, by name. */
export function groupSignoff(items: RawSignoff[], repo: string, kinds: string[]): OpsSignoffGroup[] {
  const present = [...new Set(items.map(i => i.kind))].sort((a, b) => {
    const ia = kinds.indexOf(a)
    const ib = kinds.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  return present.map(kind => ({
    kind,
    label: kindLabel(kind),
    items: items
      .filter(i => i.kind === kind)
      .map(i => ({
        item: i.item,
        where: parseWhere(i.where, repo),
        since: i.since,
        sinceMs: parseTimeMs(i.since),
      })),
  }))
}

// --- worktrees, locks and the queue -----------------------------------------

export type Worktree = { path: string; branch: string | null }

/** `git worktree list --porcelain`. */
export function parseWorktrees(text: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path === undefined) continue
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    out.push({ path: path.trim(), branch: ref?.trim() ?? null })
  }
  return out
}

/** `lsof -a -p <pid> -d cwd -Fn`: the `n` line is the directory. */
export function parseLsofCwd(text: string): string | null {
  const line = text.split('\n').find(l => l.startsWith('n'))
  return line === undefined ? null : line.slice(1)
}

/** Queue ticket file names are `<nanoseconds>-<pid>`. */
export function parseTicketName(name: string): { sinceMs: number; pid: number } | null {
  const m = /^(\d{7,})-(\d+)$/.exec(name)
  if (m === null || m[1] === undefined || m[2] === undefined) return null
  return { sinceMs: Number(m[1].slice(0, -6)), pid: Number(m[2]) }
}

/** Names the worktree a directory is in: "agent (branch)", the branch, or the folder. */
export function describeDir(cwd: string | null, worktrees: Worktree[], agents: RawAgent[], repo: string): string | null {
  if (cwd === null) return null
  const tree = worktrees
    .filter(w => cwd === w.path || cwd.startsWith(`${w.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (tree === undefined) return basename(cwd)
  const branch = tree.branch
  const agent = branch === null ? undefined : agents.find(a => branchesOf(a.branch).includes(branch))
  if (agent !== undefined) return `${agent.name} (${branch})`
  if (tree.path === repo) return `main checkout${branch === null ? '' : ` (${branch})`}`
  return branch ?? basename(tree.path)
}

// --- checks, sessions, PRs ------------------------------------------------------

type CheckLine = { branch: string; result: 'green' | 'failed'; part: string | null; timeMs: number; commit: string | null; worktree: string | null }

function checkLines(text: string): CheckLine[] {
  const out: CheckLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(raw)) continue
    const timeMs = parseTimeMs(raw.time)
    const branch = str(raw.branch) ?? str(raw.worktree)
    if (timeMs === null || branch === null) continue
    out.push({ branch, result: raw.result === 'green' ? 'green' : 'failed', part: str(raw.part), timeMs, commit: str(raw.commit), worktree: str(raw.worktree) })
  }
  return out
}

/** checks.jsonl: one JSON line per full check; the newest per branch, newest first. */
export function parseChecks(text: string, max = 8): OpsCheck[] {
  const byBranch = new Map<string, OpsCheck>()
  for (const check of checkLines(text)) {
    const seen = byBranch.get(check.branch)
    if (seen === undefined || seen.timeMs <= check.timeMs) byBranch.set(check.branch, check)
  }
  return [...byBranch.values()].sort((a, b) => b.timeMs - a.timeMs).slice(0, max)
}

/**
 * checks.jsonl as a strip per branch: the last `perBranch` results, oldest
 * first, branches ordered by their newest check, at most `max` branches.
 */
export function parseCheckHistory(text: string, perBranch = 8, max = 6): OpsCheckStrip[] {
  const byBranch = new Map<string, { timeMs: number; result: 'green' | 'failed' }[]>()
  for (const c of checkLines(text)) {
    const list = byBranch.get(c.branch) ?? []
    list.push({ timeMs: c.timeMs, result: c.result })
    byBranch.set(c.branch, list)
  }
  return [...byBranch.entries()]
    .map(([branch, list]) => {
      const sorted = list.sort((a, b) => a.timeMs - b.timeMs).slice(-perBranch)
      return { branch, results: sorted.map(c => c.result), lastMs: sorted[sorted.length - 1]?.timeMs ?? 0 }
    })
    .sort((a, b) => b.lastMs - a.lastMs)
    .slice(0, max)
}

/**
 * A Claude session file (~/.claude/sessions/<pid>.json): background sessions
 * as agents' live state, and the heartbeat session. Junk reads as null.
 */
export function parseSession(text: string): OpsSession | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const name = str(raw.name)
  const pid = typeof raw.pid === 'number' ? raw.pid : null
  if (name === null || pid === null) return null
  const kind = raw.kind === 'bg' || raw.kind === 'background' ? 'bg' : raw.kind === 'interactive' ? 'interactive' : 'other'
  const status = raw.status === 'busy' || raw.status === 'idle' ? raw.status : null
  const updated = typeof raw.updatedAt === 'number' ? raw.updatedAt : typeof raw.startedAt === 'number' ? raw.startedAt : null
  const since = typeof raw.statusUpdatedAt === 'number' ? raw.statusUpdatedAt : null
  return {
    name,
    pid,
    kind,
    status,
    updatedMs: updated,
    startedMs: typeof raw.startedAt === 'number' ? raw.startedAt : null,
    statusSinceMs: since,
    cwd: str(raw.cwd),
  }
}

/** A reading older than this is dimmed in the panel. */
export const USAGE_STALE_MS = 15 * 60_000

export const ACCOUNT_LABELS: Record<OpsAccount, string> = { main: 'Main', agents: 'Agents' }

/** tmp/ops/usage/<account>.json (schema 1; see tools/ops-kit/usage_write.py). Throws on text that is not a reading. */
export function parseUsage(text: string, account: OpsAccount, label: string, nowMs: number): OpsUsage {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('not an object')
  const windows: OpsUsageWindow[] = []
  for (const w of Array.isArray(raw.windows) ? raw.windows : []) {
    if (!isRecord(w) || typeof w.percentUsed !== 'number') continue
    windows.push({
      id: str(w.id) ?? str(w.label) ?? '?',
      label: str(w.label) ?? str(w.id) ?? '?',
      percentUsed: Math.max(0, Math.min(100, w.percentUsed)),
      resetsAtMs: typeof w.resetsAt === 'number' ? w.resetsAt : parseTimeMs(w.resetsAt),
    })
  }
  if (windows.length === 0) throw new Error('no window with a percentUsed')
  const readAtMs = typeof raw.readAt === 'number' ? raw.readAt : parseTimeMs(raw.updatedAt)
  return { account, label, plan: str(raw.plan), windows, readAtMs, isStale: readAtMs === null || nowMs - readAtMs >= USAGE_STALE_MS, error: null }
}

/** `claude agents --json --all`: names of background sessions (those with a state; interactive ones show in both accounts' lists). */
export function parseAgentNames(text: string): string[] {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const a of raw) {
    if (!isRecord(a) || typeof a.state !== 'string') continue
    const n = str(a.name) ?? str(a.id)
    if (n !== null) names.push(n)
  }
  return names
}

/** `gh pr list --json number,title,state,headRefName,mergedAt,url`. */
export function parsePrs(text: string, todayStartMs: number): OpsPrs {
  const raw: unknown = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('gh pr list did not print a list')
  const prs = raw.filter(isRecord).map(p => ({
    pr: {
      number: typeof p.number === 'number' ? p.number : 0,
      title: str(p.title) ?? '',
      branch: str(p.headRefName) ?? '',
      url: str(p.url) ?? '',
      mergedMs: parseTimeMs(p.mergedAt),
    } satisfies OpsPr,
    state: str(p.state) ?? '',
  }))
  return {
    open: prs.filter(p => p.state === 'OPEN').map(p => p.pr).sort((a, b) => b.number - a.number),
    mergedToday: prs
      .filter(p => p.state === 'MERGED' && p.pr.mergedMs !== null && p.pr.mergedMs >= todayStartMs)
      .map(p => p.pr)
      .sort((a, b) => (b.mergedMs ?? 0) - (a.mergedMs ?? 0)),
    error: null,
  }
}

/** Local midnight of the day `nowMs` falls on. */
export function dayStartMs(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// --- docs: decision log and review notes -------------------------------------

/** Rows of the table under a "Decision log" heading whose last cell starts with Proposed. */
export function parseProposedDecisions(md: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex(l => /^#{1,3}\s+(\d+\.\s*)?Decision log/i.test(l))
  if (start < 0) throw new Error('no "Decision log" heading')
  const out: string[] = []
  let sawTable = false
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break
    if (!line.startsWith('|')) {
      if (sawTable && line.trim() !== '') break
      continue
    }
    sawTable = true
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
    const num = cells[0] ?? ''
    if (!/^\d+$/.test(num)) continue
    const status = cells[cells.length - 1] ?? ''
    if (cells.length < 3 || !/^proposed\b/i.test(status)) continue
    const text = cells.length >= 4 ? cells.slice(2, -1).join(' | ') : (cells[1] ?? '')
    out.push(`#${num} ${stripMarkdown(text)}`)
  }
  if (!sawTable) throw new Error('no decision table under the heading')
  return out
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

const OPEN_HEADING = /\b(open|blocked|waiting|pending|to confirm|pinned|needs?|to decide)\b/i
const ANSWER_HEADING = /\b(answers?|answered|direction)\b/i
const CLOSED_ITEM = /\b(confirmed|answered|decided|done)\b/i

/**
 * Open items of a review notes file: items under headings that say open,
 * blocked, pinned, to confirm, waiting or needs, written after the last
 * heading with the owner's answers or direction; items that say confirmed,
 * answered, decided or done are left out.
 */
export function parseReviewNotes(md: string): { title: string; items: string[] } {
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? 'Review notes'
  const sections = md.split(/^##\s+/m).slice(1).map(chunk => {
    const nl = chunk.indexOf('\n')
    return { heading: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(), body: nl < 0 ? '' : chunk.slice(nl + 1) }
  })
  let lastAnswer = -1
  sections.forEach((s, i) => {
    if (ANSWER_HEADING.test(s.heading)) lastAnswer = i
  })
  const items: string[] = []
  sections.forEach((s, i) => {
    if (i <= lastAnswer || !OPEN_HEADING.test(s.heading)) return
    if (/\b(now|all) answered\b/i.test(s.body)) return
    let tableRow = 0
    for (const line of s.body.split('\n')) {
      let item: string | null = null
      if (/^[-*]\s+/.test(line)) item = line.replace(/^[-*]\s+/, '')
      else if (line.startsWith('|')) {
        tableRow += 1
        if (tableRow === 1 || /^\|[\s:|-]+\|?\s*$/.test(line)) continue
        item = line.replace(/^\|/, '').split('|')[0] ?? null
      } else tableRow = 0
      if (item === null || item.trim() === '' || CLOSED_ITEM.test(item)) continue
      items.push(truncate(stripMarkdown(item), 110))
    }
  })
  return { title, items }
}

/** The newest review-notes-YYYY-MM-DD*.md, else review-notes.md, else null. */
export function latestReviewNotes(names: string[]): string | null {
  const dated = names.filter(n => /^review-notes-\d{4}-\d{2}-\d{2}.*\.md$/.test(n)).sort()
  return dated[dated.length - 1] ?? (names.includes('review-notes.md') ? 'review-notes.md' : null)
}

// --- the action and previews -----------------------------------------------------

export const IDLE_ACTION: OpsActionRun = { state: 'idle', startedMs: null, finishedMs: null, exitCode: null, tail: [] }

/** tmp/ops/action.json, written by run_action.sh. */
export function parseActionRun(text: string, tail: string[]): OpsActionRun & { pid: number | null } {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('action.json is not an object')
  const state = raw.state
  return {
    state: state === 'running' || state === 'ok' || state === 'failed' ? state : 'idle',
    startedMs: parseTimeMs(raw.startedAt),
    finishedMs: parseTimeMs(raw.finishedAt),
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    tail,
  }
}

/** `stat -f '%m %N'` lines: newest first. */
export function parseStatLines(text: string): OpsPreviewFile[] {
  const out: OpsPreviewFile[] = []
  for (const line of text.split('\n')) {
    const m = /^(\d+) (.+)$/.exec(line)
    if (m === null || m[1] === undefined || m[2] === undefined) continue
    out.push({ name: basename(m[2]), path: m[2], mtimeMs: Number(m[1]) * 1000 })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The newest mtime in `stat -f %m` output (seconds), in milliseconds. */
export function newestMtimeMs(text: string): number | null {
  let newest: number | null = null
  for (const line of text.split('\n')) {
    if (!/^\d+$/.test(line.trim())) continue
    const ms = Number(line.trim()) * 1000
    if (newest === null || ms > newest) newest = ms
  }
  return newest
}

export function previewFindArgs(roots: string[]): string[] {
  const names = PREVIEW_EXTENSIONS.flatMap((ext, i) => (i === 0 ? [] : ['-o']).concat(['-iname', `*.${ext}`]))
  return [BIN.find, ...roots, '-type', 'f', '(', ...names, ')', '-exec', BIN.stat, '-f', '%m %N', '{}', '+']
}

const PRUNE = ['.git', 'node_modules', 'build', 'dist', '.dart_tool', 'Pods', 'target', '.venv', '__pycache__']

export function quietFindArgs(worktree: string): string[] {
  const names = PRUNE.flatMap((n, i) => (i === 0 ? [] : ['-o']).concat(['-name', n]))
  return [BIN.find, worktree, '(', ...names, ')', '-prune', '-o', '-type', 'f', '-exec', BIN.stat, '-f', '%m', '{}', '+']
}

// --- collect -----------------------------------------------------------------

export type Cache = {
  slowAtMs: number
  worktrees: Worktree[]
  quiet: Record<string, number | null>
  prs: OpsPrs
  decisions: OpsDocItems | null
  reviewNotes: OpsDocItems | null
  previews: OpsPreviewGroup[]
  paths: Record<string, boolean>
  cwdByPid: Record<string, string | null>
  /** Which account lists each background session (slow reader). */
  accountByName: Record<string, OpsAccount>
}

export function newCache(): Cache {
  return {
    slowAtMs: 0,
    worktrees: [],
    quiet: {},
    prs: { open: [], mergedToday: [], error: null },
    decisions: null,
    reviewNotes: null,
    previews: [],
    paths: {},
    cwdByPid: {},
    accountByName: {},
  }
}

export type CollectContext = {
  repo: string
  config: OpsConfig
  nowMs: number
  /** Run the slow readers now instead of waiting for their minute. */
  isForced?: boolean
}

export function emptySnapshot(nowMs: number, repo: string | null, config: OpsConfig, error: string | null): OpsSnapshot {
  return {
    atMs: nowMs,
    repo,
    owner: config.owner,
    priority: null,
    statusUpdatedMs: null,
    agentLimit: config.agentCap,
    agents: [],
    locks: [],
    tickets: [],
    backlog: null,
    signoff: [],
    signoffKinds: config.signoffKinds,
    decisions: null,
    reviewNotes: null,
    checks: [],
    checkStrips: [],
    sessions: [],
    heartbeatName: config.heartbeatName,
    heartbeatAccount: null,
    lanes: config.lanes,
    usage: [],
    accountLabels: { main: config.accounts.main ?? ACCOUNT_LABELS.main, agents: config.accounts.agents ?? ACCOUNT_LABELS.agents },
    prs: { open: [], mergedToday: [], error: null },
    action: config.action,
    actionRun: IDLE_ACTION,
    previews: [],
    errors: error === null ? [] : [error],
  }
}

async function runOk(io: Io, argv: string[], cwd?: string, timeoutMs?: number): Promise<string> {
  const r = await io.run(argv, cwd, timeoutMs)
  if (r.exitCode !== 0) throw new Error(`${basename(argv[0] ?? '?')} exited ${r.exitCode}: ${truncate(r.stderr, 120)}`)
  return r.stdout
}

/** Reads everything the panel shows. Never throws: a failed reader adds a line to `errors`. */
export async function collect(io: Io, ctx: CollectContext, cache: Cache): Promise<OpsSnapshot> {
  const { repo, config, nowMs } = ctx
  const snap = emptySnapshot(nowMs, repo, config, null)
  const errors = snap.errors
  const guard = async (label: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work()
    } catch (err) {
      errors.push(`${label}: ${errText(err)}`)
    }
  }
  const locksDir = resolveLocksDir(await io.agentLocksEnv().catch(() => undefined), config, repo)
  const isSlow = ctx.isForced === true || nowMs - cache.slowAtMs >= DEFAULTS.slowMs
  if (isSlow) cache.slowAtMs = nowMs

  let st: StatusFile | null = null
  try {
    st = parseStatus(await io.read(`${repo}/tmp/ops/status.json`))
  } catch (err) {
    errors.push(`status.json: ${errText(err)}`)
  }

  await guard('backlog.json', async () => {
    const path = `${repo}/tmp/ops/backlog.json`
    if (!(await io.exists(path))) return
    snap.backlog = parseBacklog(await io.read(path), config.lanes)
    if (snap.backlog.lanes.length > 0) snap.lanes = snap.backlog.lanes
  })

  if (isSlow) {
    await guard('worktrees', async () => {
      cache.worktrees = parseWorktrees(await runOk(io, [BIN.git, '-C', repo, 'worktree', 'list', '--porcelain'], repo))
    })
  }

  // Plan usage per account (written by statusline.py and usage_write.py): the agents' account only when agents run on it.
  for (const acc of config.agentsAccount ? (['main', 'agents'] as const) : (['main'] as const)) {
    const label = snap.accountLabels[acc]
    const path = `${repo}/tmp/ops/usage/${acc}.json`
    try {
      snap.usage.push(parseUsage(await io.read(path), acc, label, nowMs))
    } catch (err) {
      const missing = !(await io.exists(path).catch(() => false))
      snap.usage.push({ account: acc, label, plan: null, windows: [], readAtMs: null, isStale: true, error: missing ? 'no reading yet' : `unreadable: ${errText(err)}` })
    }
  }

  // Which account runs each background session: each account's service lists only its own.
  if (isSlow && config.agentsAccount) {
    await guard('accounts', async () => {
      const lists: [OpsAccount, string[]][] = [
        ['main', [config.claude, 'agents', '--json', '--all']],
        ['agents', [`${repo}/${config.toolsDir}/claude-agents.sh`, 'agents', '--json', '--all']],
      ]
      const found: Record<string, OpsAccount> = {}
      for (const [acc, argv] of lists) {
        const r = await io.run(argv, repo, 20_000).catch(() => null)
        if (r === null || r.exitCode !== 0) continue
        try {
          for (const n of parseAgentNames(r.stdout)) found[n] = acc
        } catch {
          // not JSON: this account's list stays empty
        }
      }
      cache.accountByName = found
    })
  }

  // Live Claude sessions (background agents, the heartbeat): only those whose pid answers.
  const sessions: OpsSession[] = []
  await guard('sessions', async () => {
    const home = io.homeEnv === undefined ? undefined : await io.homeEnv().catch(() => undefined)
    if (home === undefined || home.trim() === '') return
    const dir = `${home.replace(/\/+$/, '')}/.claude/sessions`
    if (!(await io.exists(dir))) return
    for (const entry of await io.list(dir)) {
      if (!entry.name.endsWith('.json')) continue
      const session = parseSession(await io.read(`${dir}/${entry.name}`).catch(() => ''))
      if (session === null) continue
      const alive = await io.run([BIN.kill, '-0', String(session.pid)], undefined, 3_000).catch(() => null)
      if (alive !== null && alive.exitCode === 0) sessions.push(session)
    }
  })
  // Sessions of this repo (the main checkout or a worktree inside it), plus
  // any background session status.json names: other repos' sessions stay out.
  const named = new Set(st?.agents.map(a => a.sessionName ?? a.name) ?? [])
  const isHere = (x: OpsSession): boolean => x.cwd === null || x.cwd === repo || x.cwd.startsWith(`${repo}/`)
  snap.sessions = sessions.filter(x => (x.kind === 'bg' && (isHere(x) || named.has(x.name))) || (x.name === config.heartbeatName && isHere(x)))
  snap.heartbeatAccount = cache.accountByName[config.heartbeatName] ?? null

  if (st !== null) {
    snap.priority = st.priority
    snap.statusUpdatedMs = st.updatedMs
    snap.agentLimit = st.agentLimit ?? config.agentCap
    snap.agents = []
    for (const a of st.agents) {
      const trees = branchesOf(a.branch)
        .map(b => cache.worktrees.find(w => w.branch === b)?.path)
        .filter((p): p is string => p !== undefined)
      if (isSlow) {
        for (const tree of trees) {
          await guard(`quiet ${basename(tree)}`, async () => {
            const out = await io.run(quietFindArgs(tree), tree, 20_000)
            cache.quiet[tree] = newestMtimeMs(out.stdout)
          })
        }
      }
      const newest = trees.map(t => cache.quiet[t] ?? null).filter((m): m is number => m !== null)
      const quietMinutes = newest.length === 0 ? null : Math.floor((nowMs - Math.max(...newest)) / 60_000)
      const isStalled = quietMinutes !== null && quietMinutes >= config.stallMinutes
      const live = a.kind === 'bg' ? sessions.find(x => x.kind === 'bg' && x.name === (a.sessionName ?? a.name)) : undefined
      const agent: OpsAgent = {
        ...a,
        lane: agentLane(a, snap.backlog, snap.lanes),
        account: cache.accountByName[a.sessionName ?? a.name] ?? a.account,
        idleMinutes: live !== undefined && live.status === 'idle' && live.statusSinceMs !== null ? Math.max(0, Math.floor((nowMs - live.statusSinceMs) / 60_000)) : null,
        worktrees: trees,
        quietMinutes,
        isStalled,
        liveState: a.kind === 'bg' ? (live === undefined ? 'gone' : (live.status ?? 'busy')) : null,
        state: a.kind === 'bg' && live === undefined ? 'stopped' : isStalled ? 'stalled' : 'running',
      }
      snap.agents.push(agent)
    }
    const groups = groupSignoff(st.signoff, repo, config.signoffKinds)
    for (const group of groups) {
      for (const item of group.items) {
        for (const ref of item.where) {
          if (ref.path === null) continue
          const known = cache.paths[ref.path]
          const isThere = known === undefined || isSlow ? await io.exists(ref.path).catch(() => false) : known
          cache.paths[ref.path] = isThere
          if (!isThere) ref.path = null
        }
      }
    }
    snap.signoff = groups
  }
  const agents: RawAgent[] = st === null ? [] : st.agents

  // Locks and tickets: <locks>/locks/<name>.lock and <locks>/locks/<name>.queue (queue.sh).
  const who = async (pid: number): Promise<string | null> => {
    const key = String(pid)
    if (!(key in cache.cwdByPid)) {
      const r = await io.run([BIN.lsof, '-a', '-p', key, '-d', 'cwd', '-Fn'], undefined, 5_000).catch(() => null)
      cache.cwdByPid[key] = r === null || r.exitCode !== 0 ? null : parseLsofCwd(r.stdout)
    }
    const cwd = cache.cwdByPid[key] ?? null
    return cwd === null ? null : describeDir(cwd, cache.worktrees, agents, repo)
  }
  for (const { name } of config.locks) {
    await guard(`${name} lock`, async () => {
      const dir = `${locksDir}/locks/${name}.lock`
      const lock: OpsLock = { queue: name, isHeld: false, pid: null, who: null, sinceMs: null }
      if (await io.exists(dir)) {
        lock.isHeld = true
        const owner = await io.read(`${dir}/owner`).catch(() => null)
        const pid = owner === null ? NaN : Number(owner.trim())
        if (Number.isInteger(pid) && pid > 0) {
          lock.pid = pid
          lock.who = await who(pid)
          lock.sinceMs = await io.mtimeMs(`${dir}/owner`).catch(() => null)
        } else {
          lock.sinceMs = await io.mtimeMs(dir).catch(() => null)
        }
      }
      snap.locks.push(lock)
      const qdir = `${locksDir}/locks/${name}.queue`
      const names = (await io.exists(qdir)) ? (await io.list(qdir)).map(e => e.name) : []
      const tickets: OpsTicket[] = []
      for (const ticketName of names) {
        const t = parseTicketName(ticketName)
        if (t === null || t.pid === lock.pid) continue
        tickets.push({ queue: name, pid: t.pid, who: await who(t.pid), sinceMs: t.sinceMs })
      }
      snap.tickets.push(...tickets.sort((a, b) => a.sinceMs - b.sinceMs))
    })
  }
  // A pid's folder never changes; forget pids no longer in a lock or ticket.
  const livePids = new Set([...snap.locks.map(l => String(l.pid)), ...snap.tickets.map(t => String(t.pid))])
  for (const key of Object.keys(cache.cwdByPid)) if (!livePids.has(key)) delete cache.cwdByPid[key]

  await guard('checks.jsonl', async () => {
    const path = `${repo}/tmp/ops/checks.jsonl`
    if (!(await io.exists(path))) return
    const text = await runOk(io, [BIN.tail, '-n', '400', path])
    snap.checks = parseChecks(text)
    snap.checkStrips = parseCheckHistory(text)
  })

  if (config.action !== null) {
    await guard('action', async () => {
      const path = `${repo}/tmp/ops/action.json`
      if (!(await io.exists(path))) return
      const log = `${repo}/tmp/ops/action.log`
      const tail = (await io.exists(log))
        ? (await runOk(io, [BIN.tail, '-n', '8', log])).split('\n').filter(l => l.trim() !== '')
        : []
      const { pid, ...run } = parseActionRun(await io.read(path), tail)
      if (run.state === 'running') {
        // A run killed outside the runner leaves "running" behind.
        const r = pid === null ? null : await io.run([BIN.kill, '-0', String(pid)]).catch(() => null)
        if (r === null || r.exitCode !== 0) run.state = 'stopped'
      }
      snap.actionRun = run
    })
  }

  if (isSlow) {
    const prs = await io
      .run([config.gh, 'pr', 'list', '--state', 'all', '--limit', '30', '--json', 'number,title,state,headRefName,mergedAt,url'], repo, 30_000)
      .then(r => {
        if (r.exitCode !== 0) throw new Error(truncate(r.stderr, 120))
        return parsePrs(r.stdout, dayStartMs(nowMs))
      })
      .catch((err: unknown): OpsPrs => ({ ...cache.prs, error: `gh: ${errText(err)}` }))
    cache.prs = prs

    if (config.decisionLog === null) cache.decisions = null
    else {
      const file = inRepo(config.decisionLog, repo)
      cache.decisions = await io
        .read(file)
        .then(md => ({ file, title: 'Decision log', items: parseProposedDecisions(md), error: null }))
        .catch((err: unknown) => ({ file, title: 'Decision log', items: [], error: errText(err) }))
    }

    if (config.reviewNotesDir === null) cache.reviewNotes = null
    else {
      const dir = inRepo(config.reviewNotesDir, repo)
      let notesFile: string | null = null
      cache.reviewNotes = await io
        .list(dir)
        .then(async entries => {
          const name = latestReviewNotes(entries.map(e => e.name))
          if (name === null) return { file: null, title: 'Review notes', items: [], error: null }
          notesFile = `${dir}/${name}`
          const parsed = parseReviewNotes(await io.read(notesFile))
          return { file: notesFile, title: parsed.title, items: parsed.items, error: null }
        })
        .catch((err: unknown) => ({ file: notesFile, title: 'Review notes', items: [], error: errText(err) }))
    }

    // Each configured preview folder that exists: its three newest files.
    await guard('previews', async () => {
      const previews: OpsPreviewGroup[] = []
      for (const folder of config.previews) {
        const root = inRepo(folder, repo)
        if (!(await io.exists(root))) continue
        const r = await io.run(previewFindArgs([root]), undefined, 20_000)
        const files = parseStatLines(r.stdout).slice(0, 3)
        if (files.length > 0) previews.push({ label: basename(root), files })
      }
      cache.previews = previews.sort((a, b) => (b.files[0]?.mtimeMs ?? 0) - (a.files[0]?.mtimeMs ?? 0))
    })
  }
  snap.prs = cache.prs
  snap.decisions = cache.decisions
  snap.reviewNotes = cache.reviewNotes
  snap.previews = cache.previews
  return snap
}
