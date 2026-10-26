// The ops panel's data contract: what the readers in hooks/data.ts collect
// and the pane in hooks/view.ts draws. Plain JSON, so a snapshot can live in
// `$.state` and survive a hot reload of the module.

/** One shared lock the queue serialises (tools/foreman/queue.sh <name> ...). */
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
 * The merged config: `.claude/foreman.json` (shared, committed) with
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
  /** Agents run on a second Claude account (tools/foreman/claude-agents.sh); false when absent. */
  agentsAccount: boolean
  /** The claude executable that lists the main account's sessions; `claude` when absent. */
  claude: string
  /** Labels shown for the two accounts ("Main", "Agents" when absent; no emails here). */
  accounts: { main: string | null; agents: string | null }
  /** Lanes (`lanes` in the config, used when backlog.json has none); empty means one queue and no lane rows. */
  lanes: OpsLaneDef[]
}

export type OpsAccount = 'main' | 'agents'

/** One plan window of an account (tmp/ops/usage/<account>.json, written by statusline.py or usage_write.py). */
export type OpsUsageWindow = {
  id: string
  label: string
  /** 0 to 100. */
  percentUsed: number
  resetsAtMs: number | null
}

/** An account's usage reading, stale from 15 minutes after `readAtMs`. */
export type OpsUsage = {
  account: OpsAccount
  label: string
  plan: string | null
  windows: OpsUsageWindow[]
  readAtMs: number | null
  isStale: boolean
  /** Set (and windows empty) when there is no file or it did not parse. */
  error: string | null
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
  /** The account it runs on: live from the account's agent list, else status.json's `account`; null when unknown. */
  account: OpsAccount | null
  /** Minutes the live session has been idle (registry `statusUpdatedAt`); null when busy or not live. */
  idleMinutes: number | null
  /** The lane id the agent works in (status.json `lane`, else its backlog item's lane, else flex); null without lanes. */
  lane: string | null
}

/** A live Claude session read from ~/.claude/sessions/<pid>.json. */
export type OpsSession = {
  name: string
  pid: number
  kind: 'bg' | 'interactive' | 'other'
  status: 'busy' | 'idle' | null
  updatedMs: number | null
  startedMs: number | null
  /** When `status` last changed (registry `statusUpdatedAt`). */
  statusSinceMs: number | null
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
  /** The lane id the item belongs to (its `lane`; unknown or missing ones fall under flex); null without lanes. */
  lane: string | null
  /** The raw `lane` value when it names no known lane (the item then shows under flex); else null. */
  laneNote: string | null
  /** The first ready item (of its lane, with lanes) with every dependency done: what the lead would pick. */
  isNext: boolean
}

/** One lane: backlog.json `lanes` or the config's. `minReady` is how many ready briefs the lead keeps in it. */
export type OpsLaneDef = { id: string; label: string; cap: number; owns: string | null; minReady: number }

/** One lane as the panel shows it. */
export type OpsLaneView = OpsLaneDef & {
  agents: OpsAgent[]
  /** More agents than `cap`. */
  isOver: boolean
  /** Open (not done) items of the lane, in pick order. */
  items: OpsBacklogItem[]
  open: number
  /** Ready items with every dependency done: what the lane can pick from. */
  ready: number
  /** The lane's next item; null when none is ready and unblocked. */
  next: { id: string; title: string } | null
}

export type OpsBacklog = {
  /** Items that are not done, in pick order. */
  items: OpsBacklogItem[]
  /** The lanes in display order; empty when there are none. */
  lanes: OpsLaneDef[]
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
  /** The account the heartbeat session runs on; null when unknown. */
  heartbeatAccount: OpsAccount | null
  /** The lanes in display order (backlog.json's, else the config's); empty when there are none. */
  lanes: OpsLaneDef[]
  /** Both accounts' plan usage, main first (the agents' account only when agents run on it). */
  usage: OpsUsage[]
  /** The two accounts' chip labels. */
  accountLabels: Record<OpsAccount, string>
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
    'foreman': {
      snapshot: OpsSnapshot | null
      isConfirming: boolean
      notice: string | null
    }
  }
}
