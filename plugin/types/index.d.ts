// The ops panel's data contract: what the readers in hooks/data.ts collect
// and the pane in hooks/view.ts draws. Plain JSON, so a snapshot can live in
// `$.state` and survive a hot reload of the module.

/** One shared lock the queue serialises (tools/ops-kit/queue.sh <name> ...). */
export type OpsLockSpec = {
  name: string
  /** Minutes a job may hold the lock before the queue kills it. */
  timeoutMin: number
}

/** The optional button at the bottom of the pane (a deploy, a release, a report). */
export type OpsActionSpec = {
  label: string
  /** Shell command run with /bin/bash -c in the main checkout, detached. */
  command: string
  /** The question shown before it runs; no confirm step when absent. */
  confirm: string | null
}

/**
 * The merged config: `.claude/ops-kit.json` (shared, committed) with
 * `tmp/ops/config.json` (this machine, gitignored) on top; defaults fill the rest.
 */
export type OpsConfig = {
  /** Who the lead works for: "Waiting for <owner>". */
  owner: string
  /** The agent cap; status.json's agentLimit wins when the lead set one. */
  agentCap: number
  /** Where the queue scripts live, relative to the main checkout. */
  toolsDir: string
  /** The lock folder, relative to the main checkout or absolute. OPS_AGENT_LOCKS wins. */
  locksDir: string
  locks: OpsLockSpec[]
  /** Folders whose newest files the pane lists (relative or absolute). */
  previews: string[]
  action: OpsActionSpec | null
  /** A Markdown decision log whose table rows with status Proposed wait for the owner. */
  decisionLog: string | null
  /** A folder holding review-notes-YYYY-MM-DD.md files with open questions. */
  reviewNotesDir: string | null
  /** Sign-off kinds shown as tiles; any other kind counts under the last one. */
  signoffKinds: string[]
  /** The name of the check-in background session. */
  heartbeatName: string
  /** The gh executable; `gh` on the PATH when absent. */
  gh: string
  refreshSeconds: number
  stallMinutes: number
  autoOpen: boolean
}

/** A piece of text that may point at a file (absolute path, checked to exist). */
export type OpsLinkRef = { text: string; path: string | null }

export type OpsAgent = {
  name: string
  task: string
  branch: string
  step: string
  next: string | null
  startedMs: number | null
  /** Worktrees found for the agent's branches (absolute paths). */
  worktrees: string[]
  /** Minutes since the newest change in those worktrees; null when unknown. */
  quietMinutes: number | null
  isStalled: boolean
  /** The model badge from status.json (opus, sonnet, haiku); null when absent. */
  model: string | null
  /** 'bg' is a background Claude session, 'inproc' an in-process agent. */
  kind: 'bg' | 'inproc'
  /** The background session's live state from ~/.claude/sessions; null for in-process agents. */
  liveState: 'busy' | 'idle' | 'gone' | null
  /** The card's colour: running, stalled (quiet for the stall minutes) or stopped (its session is gone). */
  state: 'running' | 'stalled' | 'stopped'
  sessionName: string | null
}

/** A live Claude session read from ~/.claude/sessions/<pid>.json. */
export type OpsSession = {
  name: string
  pid: number
  kind: 'bg' | 'interactive' | 'other'
  status: 'busy' | 'idle' | null
  updatedMs: number | null
  startedMs: number | null
  /** The session's working directory; null when the file has none. */
  cwd: string | null
}

/** One branch's recent full checks, oldest first. */
export type OpsCheckStrip = { branch: string; results: ('green' | 'failed')[]; lastMs: number }

export type OpsLock = {
  queue: string
  isHeld: boolean
  pid: number | null
  /** Who holds it: agent and branch, branch, or folder; null when unknown. */
  who: string | null
  sinceMs: number | null
}

export type OpsTicket = {
  queue: string
  pid: number
  who: string | null
  sinceMs: number
}

export type OpsBacklogStatus = 'inbox' | 'defined' | 'ready' | 'in_progress' | 'review' | 'blocked' | 'done'

/** One row of tmp/ops/backlog.json, ordered and marked for the panel. */
export type OpsBacklogItem = {
  id: string
  title: string
  theme: string | null
  track: string | null
  size: string | null
  status: OpsBacklogStatus
  /** The owner's priority (1 = next), null when none is set. */
  priority: number | null
  rank: number
  dependsOn: string[]
  /** The dependencies that are not done yet. */
  waitsFor: string[]
  blockedBy: string | null
  agent: string | null
  pr: string | null
  /** The first ready item with every dependency done: what the lead would pick. */
  isNext: boolean
}

export type OpsBacklog = {
  /** Items that are not done, in pick order. */
  items: OpsBacklogItem[]
  /** Count per status (every status, zero included), done too. */
  counts: Record<OpsBacklogStatus, number>
  doneCount: number
}

export type OpsSignoffItem = {
  item: string
  where: OpsLinkRef[]
  since: string | null
  sinceMs: number | null
}

export type OpsSignoffGroup = { kind: string; label: string; items: OpsSignoffItem[] }

/** Open items read from a doc; `error` set (and items empty) when parsing failed. */
export type OpsDocItems = {
  file: string | null
  title: string
  items: string[]
  error: string | null
}

export type OpsCheck = {
  branch: string
  result: 'green' | 'failed'
  part: string | null
  timeMs: number
  commit: string | null
  worktree: string | null
}

export type OpsPr = {
  number: number
  title: string
  branch: string
  url: string
  mergedMs: number | null
}

export type OpsPrs = { open: OpsPr[]; mergedToday: OpsPr[]; error: string | null }

export type OpsActionState = 'idle' | 'running' | 'ok' | 'failed' | 'stopped'

/** The last run of the configured action (tmp/ops/action.json, written by run_action.sh). */
export type OpsActionRun = {
  state: OpsActionState
  startedMs: number | null
  finishedMs: number | null
  exitCode: number | null
  /** The last lines of tmp/ops/action.log. */
  tail: string[]
}

export type OpsPreviewFile = { name: string; path: string; mtimeMs: number }

export type OpsPreviewGroup = { label: string; files: OpsPreviewFile[] }

export type OpsSnapshot = {
  atMs: number
  repo: string | null
  owner: string
  priority: string | null
  statusUpdatedMs: number | null
  agentLimit: number
  agents: OpsAgent[]
  locks: OpsLock[]
  tickets: OpsTicket[]
  /** tmp/ops/backlog.json, null when the file is missing or unreadable. */
  backlog: OpsBacklog | null
  signoff: OpsSignoffGroup[]
  signoffKinds: string[]
  /** Null when no decision log is configured. */
  decisions: OpsDocItems | null
  /** Null when no review notes folder is configured. */
  reviewNotes: OpsDocItems | null
  checks: OpsCheck[]
  checkStrips: OpsCheckStrip[]
  /** Live background sessions and the heartbeat session. */
  sessions: OpsSession[]
  heartbeatName: string
  prs: OpsPrs
  /** The configured action's label and confirm text; null when none is configured. */
  action: OpsActionSpec | null
  actionRun: OpsActionRun
  previews: OpsPreviewGroup[]
  /** One line per reader that failed; the panel shows them dimmed. */
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'ops-kit': {
      snapshot: OpsSnapshot | null
      isConfirming: boolean
      notice: string | null
    }
  }
}
