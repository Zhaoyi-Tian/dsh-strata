import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const base = resolve(process.env.DSH_STRATA_TEST_ROOT ?? join(root, 'node_modules/.cache/dsh-strata'))
mkdirSync(base, { recursive: true })
const work = mkdtempSync(join(base, 'install-'))
const home = join(work, 'home')
const env = { ...process.env, DSH_HOME: home, TMPDIR: work, PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}`, DSH_TOOLS_MODE: 'native' }
const tarball = process.env.DSH_STRATA_TARBALL ?? join(root, `dsh-strata-${JSON.parse(readFileSync(join(root, 'package.json'))).version}.tgz`)
const manifestPath = join(home, 'profiles/headless/package.json')
const packageOptions = [
  ...process.env.DSH_STRATA_PNPM_STORE ? [`--store-dir=${process.env.DSH_STRATA_PNPM_STORE}`] : [],
  ...process.env.DSH_STRATA_PNPM_CACHE ? [`--config.cacheDir=${process.env.DSH_STRATA_PNPM_CACHE}`] : [],
]

function dsh(args) {
  try {
    return execFileSync(process.execPath, [cli, ...args], { cwd: work, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`dsh ${args.join(' ')} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error })
  }
}

function overlay(mode) {
  const path = join(work, `${mode}.yml`)
  const provider = pathToFileURL(join(root, 'tests/support/installed-model.mjs')).href
  const contextMode = ['full', 'summary'].includes(mode) ? `- id: dsh-strata\n  config:\n    mode: ${mode}\n${mode === 'summary' ? '    summary:\n      compactAtTokens: 1000\n' : ''}` : ''
  writeFileSync(path, contextMode + `- id: agent-default-model\n  config:\n    provider: dsh-strata-test\n    model: scripted\n- id: tools\n  config:\n    mode: native\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: dsh-strata-test-model\n      name: ${JSON.stringify(provider)}\n      config:\n        mode: ${mode}\n`)
  return path
}

function run(mode, task, sessionId) {
  const args = ['--profile', 'headless', '--patch', overlay(mode), '--json']
  if (sessionId) args.push('--session-id', sessionId)
  args.push(task)
  const events = dsh(args).trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  const expected = { resume: 'RESUMED', disabled: 'DISABLED', full: 'FULL', summary: 'SUMMARY', recover: 'RECOVERED' }[mode]
  assert.equal(events.find(event => event.type === 'final')?.text, `DSH_STRATA_${expected}`)
  return events.find(event => event.type === 'session')?.sessionId
}

function entry(dump, id) {
  const row = dump.split(/(?=^- id: )/m).find(row => row.startsWith(`- id: ${id}\n`))
  assert.ok(row, `profile contains ${id}`)
  return row
}

try {
  dsh(['plugin', '--profile', 'headless', 'add', tarball, ...packageOptions])
  const manifest = JSON.parse(readFileSync(manifestPath))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-strata'])
  assert.equal(manifest.dsh.profile.bundles.filter(name => name === 'dsh-strata').length, 1)
  const installed = join(home, 'profiles/headless/node_modules/dsh-strata')
  assert.ok(readFileSync(join(installed, 'dist/index.js'), 'utf8').includes('dsh-strata'))
  const dump = dsh(['--profile', 'headless', '--dump-config'])
  assert.match(entry(dump, 'dsh-strata'), /name: dsh-strata/)
  for (const id of ['compaction-basic', 'command-compact', 'tool-result-pruner', 'spill-policy', 'spill-local', 'image-offload']) {
    assert.match(entry(dump, id), /^  disabled: true$/m)
  }
  console.log('PASS: one-command package installation and profile activation')

  const sessionId = run('recover', 'RECOVERY_NEEDLE: use the installed context windows plugin.\n' + 'historical context '.repeat(4000))
  assert.ok(sessionId)
  run('resume', 'Resume from the saved checkpoint.', sessionId)
  console.log('PASS: installed tools, context switch, full history recovery without spill, and cross-process session resume')

  run('full', 'Run with complete context and no memory tools.')
  run('summary', 'SUMMARY_ORIGINAL_TASK: observe and continue from a summary.')
  console.log('PASS: full startup and custom summary compaction both continue without notes tools')

  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-strata')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  run('disabled', 'Check disabled plugin.')
  const disabled = dsh(['--profile', 'headless', '--dump-config'])
  assert.doesNotMatch(disabled, /id: dsh-strata/)
  for (const id of ['compaction-basic', 'command-compact']) assert.doesNotMatch(entry(disabled, id), /^  disabled: true$/m)
  console.log('PASS: disabling the bundle removes its tools and restores default compaction')

  manifest.dsh.profile.bundles.push('dsh-strata')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  run('resume', 'Read the checkpoint after re-enabling the bundle.', sessionId)
  console.log('PASS: re-enabling preserves existing notes')

  dsh(['plugin', '--profile', 'headless', 'remove', 'dsh-strata', ...packageOptions])
  assert.ok(!JSON.parse(readFileSync(manifestPath)).dependencies?.['dsh-strata'])
  console.log('PASS: uninstall')
} finally {
  rmSync(work, { recursive: true, force: true })
}
