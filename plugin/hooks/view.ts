// The ops pane: a tree of the surface's own elements, built from a snapshot.
// Plain calls instead of JSX, so the Node self-test can draw it with stand-in
// elements and print it (test/preview.mjs).

import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  MarkdownProps,
  RenderElement,
  TextProps,
} from 'claude-code'
import type { OpsActionRun, OpsAgent, OpsBacklogItem, OpsBacklogStatus, OpsDocItems, OpsLaneView, OpsLinkRef, OpsPr, OpsSnapshot } from '../types'
import { basename, fileUrl, formatAge, laneViews, truncate } from './data.ts'

export type PanelUi = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
}

export type PanelActions = {
  refresh: () => void
  askAction: () => void
  confirmAction: () => void
  cancelAction: () => void
  openPreviews: () => void
}

export type PanelState = {
  snapshot: OpsSnapshot | null
  isConfirming: boolean
  notice: string | null
  /** Why there is no snapshot (no repo, not set up), when there is none. */
  problem: string | null
}

/** Functional colours, readable on dark and light panes; body text keeps the surface's own colour. */
export const TONE = {
  ok: '#7FC08A',
  bad: '#E07A5F',
  warn: '#C9A24A',
  info: '#5B9BD5',
} as const

const MERGED_SHOWN = 6

type Child = RenderElement | string | null | false | undefined

function kids(list: Child[]): (RenderElement | string)[] {
  return list.filter((c): c is RenderElement | string => c !== null && c !== false && c !== undefined)
}

/** Escapes the characters Markdown would read as markup in plain text. */
export function mdEscape(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, '\\$1')
}

function mdLink(text: string, path: string | null): string {
  return path === null ? mdEscape(text) : `[${mdEscape(text)}](${fileUrl(path)})`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// --- data shaping for the visual layout (pure, tested) ----------------------

const BADGE = { opus: '#B58BD9', sonnet: '#5B9BD5', haiku: '#6FC2B4' } as const
const CHIP_TEXT = '#1B1B1B'
const GREY = '#8A8A8A'
const GREY_BG = '#3A3A3A'

export function modelColor(model: string | null): string {
  const key = (model ?? '').toLowerCase()
  return key in BADGE ? BADGE[key as keyof typeof BADGE] : GREY
}

export function agentColor(state: OpsAgent['state']): string {
  return state === 'running' ? TONE.ok : state === 'stalled' ? TONE.warn : TONE.bad
}

/** One status line: "running 2h 05m", "stalled, quiet 40m", "stopped". */
export function agentStatus(a: OpsAgent, nowMs: number): string {
  const since = a.startedMs === null ? '' : formatAge(nowMs - a.startedMs)
  if (a.state === 'stopped') return since ? `stopped after ${since}` : 'stopped'
  if (a.state === 'stalled') return `stalled, quiet ${formatAge((a.quietMinutes ?? 0) * 60_000)}${since ? ` · up ${since}` : ''}`
  const idle = a.liveState === 'idle' ? (typeof a.idleMinutes !== 'number' ? ' (idle)' : ` (idle ${formatAge(a.idleMinutes * 60_000)})`) : ''
  return `running${since ? ` ${since}` : ''}${idle}`
}

/** The lanes that have room for another agent (fewer agents than the cap), in display order. */
export function freeLanes(lanes: OpsLaneView[]): OpsLaneView[] {
  return lanes.filter(l => l.agents.length < l.cap)
}

/** How a lane's ready count reads: under its minReady is amber, none is red; a lane that keeps none is plain. */
export function readyTone(ready: number, minReady: number): { text: string; color: string } {
  if (minReady <= 0) return { text: `${ready} ready`, color: ready > 0 ? TONE.ok : GREY }
  if (ready <= 0) return { text: 'no ready brief', color: TONE.bad }
  return { text: `${ready} ready`, color: ready < minReady ? TONE.warn : TONE.ok }
}

const GAUGE_CELLS = 10

/** A usage window as a gauge: cells filled with the share used, green under 70%, amber under 90%, red above. */
export function usageGauge(percent: number): { filled: number; total: number; color: string } {
  const p = Math.max(0, Math.min(100, percent))
  return { filled: Math.round((p / 100) * GAUGE_CELLS), total: GAUGE_CELLS, color: p < 70 ? TONE.ok : p < 90 ? TONE.warn : TONE.bad }
}

/** "resets 18:00 (in 2h 10m)", with the weekday when it is not today. */
export function resetText(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null) return 'reset unknown'
  const d = new Date(resetsAtMs)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = d.toDateString() === new Date(nowMs).toDateString() ? '' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} `
  return resetsAtMs <= nowMs ? `reset ${day}${hm} (due)` : `resets ${day}${hm} (in ${formatAge(resetsAtMs - nowMs)})`
}

/** The slot boxes: one per slot, filled with an agent's state or free; agents over the cap still show. */
export function slotBoxes(agents: OpsAgent[], limit: number): { name: string | null; state: OpsAgent['state'] | null }[] {
  const out: { name: string | null; state: OpsAgent['state'] | null }[] = []
  for (let i = 0; i < Math.max(limit, agents.length); i++) {
    const a = agents[i]
    out.push(a === undefined ? { name: null, state: null } : { name: a.name, state: a.state })
  }
  return out
}

/** Chip colour per backlog status: in progress and review stand out, blocked is muted. */
export function backlogColor(status: OpsBacklogStatus): string {
  switch (status) {
    case 'in_progress':
      return TONE.ok
    case 'review':
      return BADGE.opus
    case 'ready':
      return TONE.info
    case 'defined':
      return TONE.warn
    case 'blocked':
      return GREY_BG
    default:
      return GREY
  }
}

/** The text of a backlog row's marks: what it waits for or why it is blocked. */
export function backlogNote(item: OpsBacklogItem): string | null {
  if (item.status === 'blocked') return `blocked: ${item.blockedBy ?? 'no reason given'}`
  if (item.waitsFor.length > 0) return `waits ${item.waitsFor.join(' ')}`
  if (item.laneNote !== null) return `unknown lane "${item.laneNote}", shown under flex`
  return null
}

export type Tile = { key: string; label: string; count: number }

/**
 * The "waiting for the owner" tiles, one per configured kind: a kind not in
 * the list counts under the last tile; proposed decisions count as `decision`
 * and open review-notes items as `review` when those tiles exist.
 */
export function signoffTiles(snap: OpsSnapshot): Tile[] {
  const kinds = snap.signoffKinds.length > 0 ? snap.signoffKinds : ['action']
  const fallback = kinds[kinds.length - 1] ?? 'action'
  const n: Record<string, number> = Object.fromEntries(kinds.map(k => [k, 0]))
  const add = (kind: string, count: number): void => {
    const key = kind in n ? kind : fallback
    n[key] = (n[key] ?? 0) + count
  }
  for (const g of snap.signoff) add(g.kind, g.items.length)
  if (snap.decisions !== null) add('decision', snap.decisions.items.length)
  if (snap.reviewNotes !== null) add('review', snap.reviewNotes.items.length)
  return kinds.map(key => ({ key, label: key, count: n[key] ?? 0 }))
}

export function heartbeatOf(snap: OpsSnapshot): { color: string; text: string } {
  const hb = snap.sessions.find(x => x.name === snap.heartbeatName)
  if (hb === undefined) return { color: TONE.bad, text: 'heartbeat off' }
  const acc = snap.heartbeatAccount === null || !snap.usage.some(u => u.account === 'agents') ? '' : ` · ${snap.accountLabels[snap.heartbeatAccount]}`
  return { color: hb.status === 'busy' ? TONE.ok : TONE.info, text: `heartbeat ${hb.status ?? 'on'}${acc}` }
}

export function renderPanel(ui: PanelUi, state: PanelState, actions: PanelActions): RenderElement {
  const { Box, Text, Button, Markdown } = ui
  const snap = state.snapshot

  const heading = (title: string, extra?: string): RenderElement =>
    Box({
      flexDirection: 'row',
      marginTop: 1,
      children: kids([Text({ bold: true, children: [title.toUpperCase()] }), extra ? Text({ dimColor: true, children: [`  ${extra}`] }) : null]),
    })
  const dim = (text: string): RenderElement => Text({ dimColor: true, wrap: 'wrap', children: [text] })
  const line = (text: string): RenderElement => Text({ wrap: 'wrap', children: [text] })
  const marked = (color: string, mark: string, text: string): RenderElement =>
    Box({
      flexDirection: 'row',
      children: [Text({ color, children: [`${mark} `] }), Text({ wrap: 'wrap', children: [text] })],
    })
  /** A small filled label. */
  const chip = (text: string, color: string, fg: string = CHIP_TEXT): RenderElement =>
    Text({ backgroundColor: color, color: fg, children: [` ${text} `] })
  const chips = (list: Child[]): RenderElement => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: kids(list) })

  const beat = snap === null ? null : heartbeatOf(snap)
  const title = snap === null || snap.repo === null ? 'Ops' : `Ops · ${basename(snap.repo)} · ${clock(snap.atMs)}`
  const header = Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    children: kids([
      Text({ children: [title] }),
      beat === null ? null : Text({ color: beat.color, children: [`♥ ${beat.text}`] }),
      Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: actions.refresh }),
    ]),
  })

  if (snap === null) {
    return Box({
      flexDirection: 'column',
      children: kids([header, dim(state.problem ?? 'Reading the status files…')]),
    })
  }
  const ago = (ms: number | null): string => (ms === null ? '?' : formatAge(snap.atMs - ms))

  // 1. Agents: one row per lane (or slot boxes without lanes), then one card per agent
  const lanes = laneViews(snap.lanes, snap.agents, snap.backlog)
  const agents: Child[] = [heading('Agents', `${snap.agents.length} of ${snap.agentLimit} slots`)]
  if (lanes.length === 0) {
    agents.push(
      chips(
        slotBoxes(snap.agents, snap.agentLimit).map(slot =>
          slot.state === null ? chip('free', GREY_BG, GREY) : chip(truncate(slot.name ?? '?', 10), agentColor(slot.state)),
        ),
      ),
    )
  }
  for (const lane of lanes) {
    const ready = readyTone(lane.ready, lane.minReady)
    agents.push(
      Box({
        flexDirection: 'column',
        children: [
          chips([
            Text({ bold: true, ...(lane.isOver ? { color: TONE.warn } : {}), children: [`${lane.label} ${lane.agents.length}/${lane.cap}`] }),
            lane.isOver ? chip('over cap', TONE.warn) : null,
            ...(lane.agents.length === 0 ? [chip('free', GREY_BG, GREY)] : lane.agents.map(a => chip(truncate(a.name, 10), agentColor(a.state)))),
          ]),
          chips([
            lane.next === null ? Text({ dimColor: true, children: ['next: none'] }) : chip(`next ${lane.next.id}`, TONE.ok),
            lane.next === null ? null : Text({ wrap: 'truncate-end', children: [truncate(lane.next.title, 30)] }),
            chip(ready.text, ready.color),
          ]),
        ],
      }),
    )
  }
  if (snap.agents.length === 0) agents.push(dim('No agent is working.'))
  for (const a of snap.agents) {
    const color = agentColor(a.state)
    agents.push(
      Box({
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: color,
        paddingX: 1,
        children: kids([
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [
              Text({ bold: true, color, children: [`● ${truncate(a.name, 28)}${a.kind === 'bg' ? '  bg' : ''}`] }),
              chips([
                a.account === null ? null : chip(snap.accountLabels[a.account], GREY_BG, a.account === 'main' ? TONE.info : TONE.ok),
                chip(a.model ?? 'model ?', modelColor(a.model)),
              ]),
            ],
          }),
          a.task ? Text({ wrap: 'truncate-end', children: [a.task] }) : null,
          a.step ? Text({ dimColor: true, wrap: 'truncate-end', children: [a.step] }) : null,
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [
              Text({ color, children: [agentStatus(a, snap.atMs)] }),
              Text({ dimColor: true, wrap: 'truncate-end', children: [truncate(a.branch || 'no branch', 26)] }),
            ],
          }),
          a.worktrees.length === 0 && a.branch && a.kind !== 'bg' ? dim('no worktree found for its branch') : null,
        ]),
      }),
    )
  }

  // 1b. Usage: one row per account, a gauge per plan window
  const usage: Child[] = [heading('Usage')]
  for (const u of snap.usage) {
    const head = chips([Text({ bold: true, children: [u.label] }), u.plan === null ? null : Text({ dimColor: true, children: [u.plan] })])
    if (u.windows.length === 0) {
      usage.push(Box({ flexDirection: 'column', children: [head, dim(u.error ?? 'no reading yet')] }))
      continue
    }
    usage.push(
      Box({
        flexDirection: 'column',
        children: kids([
          head,
          ...u.windows.map(w => {
            const g = usageGauge(w.percentUsed)
            return Box({
              flexDirection: 'column',
              children: [
                Box({
                  flexDirection: 'row',
                  columnGap: 1,
                  children: [
                    Text({ dimColor: u.isStale, children: [w.label.padEnd(8)] }),
                    Text({ color: g.color, dimColor: u.isStale, children: ['━'.repeat(g.filled) + '╌'.repeat(g.total - g.filled)] }),
                    Text({ bold: true, dimColor: u.isStale, children: [`${Math.round(w.percentUsed)}%`] }),
                  ],
                }),
                Text({ dimColor: true, children: [`  ${resetText(w.resetsAtMs, snap.atMs)}`] }),
              ],
            })
          }),
          u.isStale ? dim(`reading ${u.readAtMs === null ? 'age unknown' : `${formatAge(snap.atMs - u.readAtMs)} old`} (stale)`) : dim(`read ${ago(u.readAtMs)} ago`),
        ]),
      }),
    )
  }

  // 2. Locks: a lane per shared lock, with the tickets waiting for it
  const locks: Child[] = [heading('Locks')]
  const width = Math.max(6, ...snap.locks.map(l => l.queue.length + 1))
  for (const lock of snap.locks) {
    const waiters = snap.tickets.filter(t => t.queue === lock.queue)
    locks.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: kids([
          Text({ bold: true, children: [lock.queue.padEnd(width)] }),
          lock.isHeld
            ? chip(`${lock.who ?? (lock.pid === null ? 'held' : `pid ${lock.pid}`)} ${ago(lock.sinceMs)}`, TONE.warn)
            : chip('free', GREY_BG, TONE.ok),
          ...waiters.map(t => chip(`${t.who ?? `pid ${t.pid}`} ${ago(t.sinceMs)}`, TONE.info)),
        ]),
      }),
    )
  }

  // 3. Backlog
  const backlog: Child[] = []
  const free = Math.max(0, snap.agentLimit - snap.agents.length)
  const bl = snap.backlog
  if (bl === null) {
    backlog.push(heading('Backlog'), dim('No tmp/ops/backlog.json yet.'))
  } else {
    const open = freeLanes(lanes).map(l => l.id)
    backlog.push(
      heading('Backlog', lanes.length === 0 ? `${bl.items.length} open · ${free} slot${free === 1 ? '' : 's'} free` : `${bl.items.length} open · free: ${open.length === 0 ? 'none' : open.join(', ')}`),
    )
    backlog.push(
      chips(
        (['in_progress', 'review', 'ready', 'defined', 'inbox', 'blocked'] as const)
          .filter(st => bl.counts[st] > 0)
          .map(st => chip(`${bl.counts[st]} ${st.replace('_', ' ')}`, backlogColor(st), st === 'blocked' ? GREY : CHIP_TEXT)),
      ),
    )
    if (bl.items.length === 0) backlog.push(dim('The backlog is empty.'))
    // With lanes the items group under their lane; without, one list.
    const groups: { label: string | null; items: OpsBacklogItem[] }[] =
      lanes.length === 0 ? [{ label: null, items: bl.items }] : lanes.filter(l => l.open > 0).map(l => ({ label: l.label, items: l.items }))
    for (const group of groups) {
      if (group.label !== null) {
        backlog.push(
          Box({
            flexDirection: 'row',
            marginTop: 1,
            children: [Text({ bold: true, children: [group.label.toUpperCase()] }), Text({ dimColor: true, children: [`  ${group.items.length} open`] })],
          }),
        )
      }
      for (const item of group.items) {
        const note = backlogNote(item)
        const isMuted = item.status === 'blocked'
        backlog.push(
          Box({
            flexDirection: 'column',
            children: kids([
              chips([
                Text({ bold: true, dimColor: isMuted, children: [item.id] }),
                chip(item.status.replace('_', ' '), backlogColor(item.status), isMuted ? GREY : CHIP_TEXT),
                item.priority === null ? null : chip(`P${item.priority}`, TONE.warn),
                item.isNext ? chip('next', TONE.ok) : null,
                item.agent !== null && item.status === 'in_progress' ? Text({ color: TONE.ok, children: [truncate(item.agent, 14)] }) : null,
                Text({ dimColor: true, children: [[item.track, item.size].filter(x => x !== null).join(' ')] }),
              ]),
              Text({ dimColor: isMuted, wrap: 'truncate-end', children: [truncate(item.title, 52)] }),
              note === null ? null : Text({ color: item.status === 'blocked' ? GREY : TONE.warn, wrap: 'truncate-end', children: [truncate(note, 52)] }),
            ]),
          }),
        )
      }
    }
    if (bl.doneCount > 0) backlog.push(dim(`${bl.doneCount} done`))
  }

  // 4. Waiting for the owner: tiles by kind, then the items with their links
  const tiles = signoffTiles(snap)
  const total = tiles.reduce((n, t) => n + t.count, 0)
  const signoff: Child[] = [heading(`Waiting for ${snap.owner}`, String(total))]
  signoff.push(
    Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      children: tiles.map(t =>
        Box({
          flexDirection: 'column',
          alignItems: 'center',
          borderStyle: 'round',
          borderColor: t.count > 0 ? TONE.info : GREY_BG,
          width: 10,
          children: [Text({ bold: true, color: t.count > 0 ? TONE.info : GREY, children: [String(t.count)] }), Text({ dimColor: true, children: [truncate(t.label, 8)] })],
        }),
      ),
    }),
  )
  for (const group of snap.signoff) {
    const rows = group.items.map(item => {
      const where = item.where.map((w: OpsLinkRef) => mdLink(w.text, w.path)).join(', ')
      // A bare date reads better as the date than as hours since UTC midnight.
      const isDate = item.since !== null && /^\d{4}-\d{2}-\d{2}$/.test(item.since)
      const since = item.sinceMs !== null && !isDate ? ago(item.sinceMs) : (item.since ?? '')
      return `- ${mdEscape(item.item)}${where ? ` · ${where}` : ''}${since ? ` · *${mdEscape(since)}*` : ''}`
    })
    signoff.push(Text({ color: TONE.info, children: [`${group.label} (${group.items.length})`] }))
    signoff.push(Markdown({ text: rows.join('\n') }))
  }
  const doc = (label: string, d: OpsDocItems | null, none: string): Child[] => {
    if (d === null) return []
    const link = d.file === null ? '' : ` ${mdLink(basename(d.file), d.file)}`
    if (d.error !== null) return [Markdown({ text: `${mdEscape(label)}: could not read (${mdEscape(d.error)}).${link}`, dimColor: true })]
    if (d.items.length === 0) return [Markdown({ text: `${mdEscape(none)}${link}`, dimColor: true })]
    return [
      Text({ color: TONE.info, children: [`${label} (${d.items.length})`] }),
      Markdown({ text: `${d.items.map(i => `- ${mdEscape(i)}`).join('\n')}\n\n${link.trim()}` }),
    ]
  }
  signoff.push(...doc('Proposed decisions', snap.decisions, 'No proposed decisions:'))
  signoff.push(...doc(truncate(snap.reviewNotes?.title ?? 'Review notes', 48), snap.reviewNotes, 'Review notes: nothing open after the latest answers:'))
  if (total === 0 && snap.signoff.length === 0) signoff.push(dim('Nothing waits for a sign-off.'))

  // 5. Checks and PRs: a strip of squares per branch, then PR chips
  const prLink = (p: OpsPr): string => `[#${p.number}](${p.url})`
  const checks: Child[] = [heading('Checks and PRs')]
  if (snap.checkStrips.length === 0) checks.push(dim('No full check recorded yet (tmp/ops/checks.jsonl).'))
  for (const strip of snap.checkStrips) {
    const newest = snap.checks.find(c => c.branch === strip.branch)
    checks.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: kids([
          Text({ children: strip.results.map(r => Text({ color: r === 'green' ? TONE.ok : TONE.bad, children: ['■'] })) }),
          Text({ wrap: 'truncate-end', children: [truncate(strip.branch, 26)] }),
          Text({ dimColor: true, children: [newest === undefined ? '' : `${ago(newest.timeMs)}${newest.result === 'failed' ? ` FAILED${newest.part ? ` (${newest.part})` : ''}` : ''}`] }),
        ]),
      }),
    )
  }
  const merged = snap.prs.mergedToday
  checks.push(
    Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      marginTop: 1,
      children: kids([
        Text({ color: TONE.info, children: [`Open ${snap.prs.open.length}`] }),
        ...snap.prs.open.map(p => chip(`#${p.number}`, TONE.info)),
        Text({ color: TONE.ok, children: [`  Merged today ${merged.length}`] }),
        ...merged.slice(0, MERGED_SHOWN).map(p => chip(`#${p.number}`, TONE.ok)),
        merged.length > MERGED_SHOWN ? dim(`+${merged.length - MERGED_SHOWN}`) : null,
      ]),
    }),
  )
  if (snap.prs.open.length > 0) {
    checks.push(Markdown({ text: snap.prs.open.map(p => `- ${prLink(p)} ${mdEscape(truncate(p.title, 50))}`).join('\n') }))
  }
  if (merged.length > 0) checks.push(Markdown({ text: merged.slice(0, MERGED_SHOWN).map(prLink).join(' · '), dimColor: true }))
  if (snap.prs.error !== null) checks.push(dim(snap.prs.error))

  // 6. The configured action (none: no section)
  const action: Child[] = []
  if (snap.action !== null) {
    const spec = snap.action
    action.push(heading(spec.label))
    action.push(...actionRows(ui, snap.actionRun, ago))
    const isRunning = snap.actionRun.state === 'running'
    if (state.isConfirming && !isRunning) {
      action.push(
        Box({
          flexDirection: 'column',
          marginTop: 1,
          children: [
            line(spec.confirm ?? `Run "${spec.label}"?`),
            Box({
              flexDirection: 'row',
              columnGap: 2,
              children: [
                Button({ key: 'action-confirm', label: 'Run now', variant: 'primary', hotkey: 'y', onPress: actions.confirmAction }),
                Button({ key: 'action-cancel', label: 'Cancel', hotkey: 'n', onPress: actions.cancelAction }),
              ],
            }),
          ],
        }),
      )
    } else if (!isRunning) {
      action.push(
        Box({
          flexDirection: 'row',
          marginTop: 1,
          children: [Button({ key: 'action', label: spec.label, hotkey: 'a', onPress: actions.askAction })],
        }),
      )
    }
  }

  // 7. Previews
  const previews: Child[] = [heading('Previews')]
  if (snap.previews.length === 0) previews.push(dim('No previews found.'))
  for (const g of snap.previews) {
    const files = g.files.map(f => `${mdLink(f.name, f.path)} *${ago(f.mtimeMs)}*`).join(' · ')
    previews.push(Markdown({ text: `**${mdEscape(g.label)}**: ${files}` }))
  }
  if (snap.previews.length > 0) {
    previews.push(
      Box({
        flexDirection: 'row',
        marginTop: 1,
        children: [Button({ key: 'open-previews', label: 'Open newest previews', hotkey: 'o', onPress: actions.openPreviews })],
      }),
    )
  }

  const notice: Child = state.notice === null ? null : Box({ marginTop: 1, children: [marked(TONE.info, '›', state.notice)] })
  const errors: Child = snap.errors.length === 0 ? null : Box({ flexDirection: 'column', marginTop: 1, children: snap.errors.map(e => dim(`! ${e}`)) })

  return Box({
    flexDirection: 'column',
    children: kids([
      header,
      snap.priority ? Text({ color: TONE.warn, wrap: 'wrap', children: [snap.priority] }) : null,
      notice,
      Box({ flexDirection: 'column', children: kids(agents) }),
      Box({ flexDirection: 'column', children: kids(usage) }),
      Box({ flexDirection: 'column', children: kids(locks) }),
      Box({ flexDirection: 'column', children: kids(backlog) }),
      Box({ flexDirection: 'column', children: kids(signoff) }),
      Box({ flexDirection: 'column', children: kids(checks) }),
      action.length === 0 ? null : Box({ flexDirection: 'column', children: kids(action) }),
      Box({ flexDirection: 'column', children: kids(previews) }),
      errors,
    ]),
  })
}

function actionRows(ui: PanelUi, run: OpsActionRun, ago: (ms: number | null) => string): RenderElement[] {
  const { Text, Box } = ui
  const tail = run.tail.map(l => Text({ dimColor: true, wrap: 'truncate-end', children: [l] }))
  const row = (color: string, text: string): RenderElement =>
    Box({ flexDirection: 'row', children: [Text({ color, children: ['◆ '] }), Text({ wrap: 'wrap', children: [text] })] })
  switch (run.state) {
    case 'running':
      return [row(TONE.info, `Running for ${ago(run.startedMs)}`), ...tail]
    case 'ok':
      return [row(TONE.ok, `Last run ok · ${ago(run.finishedMs)} ago`)]
    case 'failed':
      return [row(TONE.bad, `Last run FAILED (exit ${run.exitCode ?? '?'}) · ${ago(run.finishedMs)} ago`), ...tail]
    case 'stopped':
      return [row(TONE.bad, 'Last run stopped (its process is gone)'), ...tail]
    default:
      return []
  }
}
