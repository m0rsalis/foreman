// Prints the ops pane as text from the live files, the way the mod reads
// them, so the panel can be checked without Claude Code:
//   node --experimental-strip-types test/preview.mjs [repo]
// The repo defaults to the main checkout of the current directory.

import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'

import { LOCAL_CONFIG, PROJECT_CONFIG, collect, newCache, parseConfig } from '../plugin/hooks/data.ts'
import { renderPanel } from '../plugin/hooks/view.ts'
import { textUi, toText } from './text_ui.mjs'

function run(argv, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Like $.process.run: a program that cannot start rejects, any exit code resolves.
      if (err && typeof err.code === 'string') reject(err)
      else resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}

const io = {
  read: path => readFile(path, 'utf8'),
  exists: path => access(path).then(() => true, () => false),
  list: async path =>
    Promise.all(
      (await readdir(path, { withFileTypes: true })).map(async d => ({
        name: d.name,
        kind: d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other',
        mtimeMs: d.isFile() ? (await stat(`${path}/${d.name}`)).mtimeMs : 0,
      })),
    ),
  mtimeMs: async path => (await stat(path)).mtimeMs,
  run,
  agentLocksEnv: async () => process.env.OPS_AGENT_LOCKS,
  homeEnv: async () => process.env.HOME,
}

let repo = process.argv[2]
const common = (await run(['/usr/bin/git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], repo ?? process.cwd())).stdout.trim()
repo = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : (repo ?? process.cwd())
const maybe = path => readFile(path, 'utf8').catch(() => null)
const config = parseConfig(await maybe(`${repo}/${PROJECT_CONFIG}`), await maybe(`${repo}/${LOCAL_CONFIG}`))
const snapshot = await collect(io, { repo, config, nowMs: Date.now(), isForced: true }, newCache())
const noop = () => {}
const tree = renderPanel(
  textUi,
  { snapshot, isConfirming: false, notice: null, problem: null },
  { refresh: noop, askAction: noop, confirmAction: noop, cancelAction: noop, openPreviews: noop },
)
console.log(toText(tree).join('\n'))
