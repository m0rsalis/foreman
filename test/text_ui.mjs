// Stand-in elements for the ops pane: build the same plain-data tree the
// surfaces get, and print it as text (for the self-test and test/preview.mjs).
// The text preview draws borders, chips ([ ]), rows side by side and wrapped
// rows at the pane's width, so the layout can be judged without a terminal.

const make = type => props => ({ type, props: props ?? {} })

export const textUi = {
  Box: make('Box'),
  Text: make('Text'),
  Button: make('Button'),
  Markdown: make('Markdown'),
}

/** The pane's width in columns for the wrapped rows of the preview. */
export const PANE_COLUMNS = 56

function inline(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  const { type, props } = node
  const children = props.children ?? []
  switch (type) {
    case 'Text': {
      let text = children.map(inline).join('')
      if (props.wrap === 'truncate-end' && [...text].length > PANE_COLUMNS - 6) text = `${[...text].slice(0, PANE_COLUMNS - 7).join('')}…`
      return props.backgroundColor ? `[${text.trim()}]` : text
    }
    case 'Button':
      return `< ${props.label}${props.hotkey ? ` (${props.hotkey})` : ''} >`
    case 'Markdown':
      return props.text
    case 'Box':
      return children.map(inline).join(props.flexDirection === 'row' ? ' '.repeat(props.columnGap ?? 0) : '\n')
    default:
      return `<${type}?>`
  }
}

const width = lines => Math.max(0, ...lines.map(l => [...l].length))
const pad = (line, w) => line + ' '.repeat(Math.max(0, w - [...line].length))

function row(blocks, gap, wrap) {
  const rows = []
  let current = []
  let used = 0
  for (const block of blocks) {
    const w = width(block)
    if (wrap && current.length > 0 && used + gap + w > PANE_COLUMNS) {
      rows.push(current)
      current = []
      used = 0
    }
    used += (current.length > 0 ? gap : 0) + w
    current.push(block)
  }
  if (current.length > 0) rows.push(current)
  const out = []
  for (const r of rows) {
    const height = Math.max(...r.map(b => b.length))
    for (let i = 0; i < height; i++) out.push(r.map(b => pad(b[i] ?? '', width(b))).join(' '.repeat(gap)).trimEnd())
  }
  return out
}

/** The tree as lines of text. */
export function toText(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string') return [node]
  const { type, props } = node
  const lines = []
  if (props.marginTop) lines.push('')
  if (type !== 'Box') {
    lines.push(...inline(node).split('\n'))
    return lines
  }
  const blocks = (props.children ?? []).map(toText).filter(b => b.length > 0)
  let body
  if (props.flexDirection === 'row') {
    if (props.justifyContent === 'space-between') {
      body = [blocks.map(b => b.join(' ')).join('   ')]
    } else {
      body = row(blocks, props.columnGap ?? 0, props.flexWrap === 'wrap')
    }
  } else {
    body = blocks.flat()
  }
  if (typeof props.width === 'number') {
    const w = props.width - (props.borderStyle ? 2 : 0)
    body = body.map(l => (props.alignItems === 'center' ? ' '.repeat(Math.floor((w - [...l].length) / 2)) + l : l)).map(l => pad(l, w))
  }
  if (props.borderStyle) {
    const w = width(body) + (props.paddingX ?? 0) * 2
    const side = ' '.repeat(props.paddingX ?? 0)
    body = [`╭${'─'.repeat(w)}╮`, ...body.map(l => `│${side}${pad(l, w - side.length * 2)}${side}│`), `╰${'─'.repeat(w)}╯`]
  }
  lines.push(...body)
  return lines
}

/** Every element of a type in the tree, depth first. */
export function findAll(node, type) {
  if (node === null || typeof node !== 'object') return []
  const own = node.type === type ? [node] : []
  return own.concat(...(node.props.children ?? []).map(child => findAll(child, type)))
}
