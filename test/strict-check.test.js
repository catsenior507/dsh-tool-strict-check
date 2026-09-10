/**
 * Strict-check tests.
 *
 * The Lean tests are split in two on purpose. The parsing tests feed **recorded
 * output from Lean 4.33.1 on this machine** into the parser, so they fail if the
 * wire format changes. The integration tests actually execute the discovered
 * compiler and are skipped when no toolchain is present, because a test that
 * silently degrades to "no checker available, so nothing to assert" would pass
 * on a machine where the plugin is broken.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

import { inject, name, apply } from '../lib/index.js'
import { resolveConfig, DEFAULTS } from '../lib/config.js'
import { elanBinDirs, resolveExecutable, runProcess } from '../lib/runner.js'
import {
  findForbidden,
  formatDiagnostic,
  kindName,
  mergeDiagnostics,
  parseColonDiagnostics,
  parseLeanJson,
  parsePythonDiagnostics,
} from '../lib/parse.js'
import {
  hasBlockingFinding,
  languageOf,
  leanDeclarations,
  scanCommand,
  scanText,
  stripPowerShellComment,
} from '../lib/static.js'
import {
  MINIMUM_SAFE_VERSION,
  checkLean,
  compareVersions,
  detectLean,
  leanArgs,
  parseLeanVersion,
  resolveLean,
} from '../lib/lean.js'
import { checkLanguage } from '../lib/language.js'
import { registerTool } from '../lib/tool.js'

/** One throwaway scratch root per test process. */
const ROOT = mkdtempSync(join(tmpdir(), 'strict-check-test-'))
after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Resolved config rooted in the throwaway directory. */
function config(overrides = {}) {
  return resolveConfig({ workDir: ROOT, ...overrides })
}

/**
 * Verbatim `lean --json` lines recorded from Lean 4.33.1 on Windows.
 *
 * Positions in these payloads are **0-based**, which is exactly the detail the
 * parser has to get right; the assertions below expect 1-based output.
 */
const RECORDED = {
  sorryWarning: '{"caption":"","data":"declaration uses `sorry`","endPos":{"column":7,"line":1},"fileName":"C:\\\\tmp\\\\sorry.lean","isSilent":false,"keepFullRange":false,"kind":"hasSorry","pos":{"column":0,"line":1},"severity":"warning"}',
  sorryError: '{"caption":"","data":"declaration uses `sorry`","endPos":{"column":7,"line":1},"fileName":"C:\\\\tmp\\\\sorry.lean","isSilent":false,"keepFullRange":false,"kind":"hasSorry","pos":{"column":0,"line":1},"severity":"error"}',
  unknownIdentifier: '{"caption":"","data":"Unknown identifier `x`","endPos":{"column":18,"line":2},"fileName":"C:\\\\tmp\\\\typo.lean","isSilent":false,"keepFullRange":false,"kind":"lean.unknownIdentifier._namedError","pos":{"column":11,"line":2},"severity":"error"}',
  guardFailure: '{"caption":"","data":"Expression\\n  double 3 == 7\\ndid not evaluate to `true`","endPos":{"column":20,"line":2},"fileName":"C:\\\\tmp\\\\guard.lean","isSilent":false,"keepFullRange":false,"kind":"[anonymous]","pos":{"column":0,"line":2},"severity":"error"}',
}

describe('lean diagnostics parsing', () => {
  it('reads a recorded sorry warning and converts 0-based positions to 1-based', () => {
    const { diagnostics } = parseLeanJson(RECORDED.sorryWarning)
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].severity, 'warning')
    assert.equal(diagnostics[0].kind, 'hasSorry')
    assert.equal(diagnostics[0].message, 'declaration uses `sorry`')
    assert.equal(diagnostics[0].line, 2, 'wire line 1 is human line 2')
    assert.equal(diagnostics[0].column, 1, 'wire column 0 is human column 1')
  })

  it('reads a dotted kind name verbatim', () => {
    const { diagnostics } = parseLeanJson(RECORDED.unknownIdentifier)
    assert.equal(diagnostics[0].kind, 'lean.unknownIdentifier._namedError')
    assert.equal(diagnostics[0].line, 3)
    assert.equal(diagnostics[0].column, 12)
  })

  it('keeps a multi-line rendered message intact', () => {
    const { diagnostics } = parseLeanJson(RECORDED.guardFailure)
    assert.match(diagnostics[0].message, /did not evaluate to `true`/)
    assert.equal(diagnostics[0].kind, '[anonymous]')
  })

  it('promotes the same message from warning to error under -E hasSorry', () => {
    const warning = parseLeanJson(RECORDED.sorryWarning).diagnostics[0]
    const error = parseLeanJson(RECORDED.sorryError).diagnostics[0]
    assert.equal(warning.kind, error.kind)
    assert.equal(warning.severity, 'warning')
    assert.equal(error.severity, 'error')
  })

  it('accepts the tagged-object kind form an older serialization used', () => {
    assert.equal(kindName({ tag: 'hasSorry' }), 'hasSorry')
    assert.equal(kindName('hasSorry'), 'hasSorry')
    assert.equal(kindName(undefined), '')
  })

  it('keeps unparsable output rather than dropping it', () => {
    const { diagnostics, raw } = parseLeanJson('not json\n{"bad":\n{"caption":"","data":"d","fileName":"f","pos":{"line":0,"column":0},"severity":"error","kind":"x"}')
    assert.equal(diagnostics.length, 1)
    assert.deepEqual(raw, ['not json', '{"bad":'])
  })

  it('finds a forbidden kind by kind and by message text', () => {
    const { diagnostics } = parseLeanJson(RECORDED.sorryWarning + '\n' + RECORDED.unknownIdentifier)
    const found = findForbidden(diagnostics, ['hasSorry', 'sorry'])
    assert.equal(found.length, 1)
    assert.equal(found[0].kind, 'hasSorry')
  })

  it('de-duplicates the same diagnostic reported on both streams', () => {
    const one = parseLeanJson(RECORDED.sorryError).diagnostics
    assert.equal(mergeDiagnostics(one, one).length, 1)
  })

  it('formats a location the way an editor shows it', () => {
    const { diagnostics } = parseLeanJson(RECORDED.unknownIdentifier)
    assert.equal(formatDiagnostic(diagnostics[0]), 'C:\\tmp\\typo.lean:3:12 ERROR [lean.unknownIdentifier._namedError] Unknown identifier `x`')
  })

  it('parses tsc-style and MSBuild-style diagnostics', () => {
    const tsc = parseColonDiagnostics('src/a.ts(12,5): error TS2322: Type "string" is not assignable to type "number".')
    assert.equal(tsc.diagnostics.length, 1)
    assert.equal(tsc.diagnostics[0].line, 12)
    assert.match(tsc.diagnostics[0].message, /TS2322/)
    const plain = parseColonDiagnostics('src/a.ts:12:5 - error TS2322: nope')
    assert.equal(plain.diagnostics.length, 1)
    assert.equal(plain.diagnostics[0].column, 5)
  })

  it('parses a CPython syntax error down to the user frame', () => {
    const traceback = [
      '  File "C:\\tmp\\bad.py", line 2',
      '    def f(:',
      '          ^',
      'SyntaxError: invalid syntax',
      '',
      '  File "C:\\Python\\lib\\py_compile.py", line 150, in compile',
      '    compile(file, cfile, dfile)',
      'ValueError: source code string cannot contain null bytes',
    ].join('\n')
    const { diagnostics } = parsePythonDiagnostics(traceback)
    assert.equal(diagnostics.length, 1, 'only the last frame is the user error')
    assert.match(diagnostics[0].message, /ValueError|SyntaxError/)
  })
})

describe('static rules', () => {
  it('flags the chain operators Windows PowerShell 5.1 cannot parse', () => {
    const findings = scanCommand('Test-Path x && Remove-Item x')
    assert.equal(findings.some((finding) => finding.rule === 'ps/chain-operators' && finding.severity === 'error'), true)
  })

  it('does not flag a pipe or a logical or inside a string', () => {
    assert.deepEqual(scanCommand('Get-ChildItem | Select-Object Name'), [])
    assert.deepEqual(scanText("Write-Output 'a && b'", 'powershell').filter((f) => f.rule === 'ps/chain-operators'), [])
  })

  it('flags a working-directory change, which cannot survive a tool call', () => {
    const findings = scanCommand('cd D:\\work; Get-ChildItem')
    assert.equal(findings.some((finding) => finding.rule === 'ps/relative-path-push'), true)
  })

  it('flags a recursive force delete', () => {
    const findings = scanCommand('Remove-Item -Recurse -Force D:\\tmp\\x')
    assert.equal(findings.some((finding) => finding.rule === 'ps/remove-item-recurse-force' && finding.severity === 'error'), true)
  })

  it('ignores a commented-out hazard', () => {
    assert.deepEqual(scanText('# Remove-Item -Recurse -Force C:\\', 'powershell'), [])
  })

  it('strips a comment but respects a hash inside a string', () => {
    assert.equal(stripPowerShellComment("Write-Output 'a#b' # real comment"), "Write-Output 'a#b' ")
  })

  it('treats sorry and an unbounded heartbeat budget as blocking Lean findings', () => {
    const findings = scanText('theorem t : True := by sorry', 'lean')
    assert.equal(hasBlockingFinding(findings), true)
    assert.equal(scanText('set_option maxHeartbeats 0 in\nexample : True := by trivial', 'lean').some((f) => f.rule === 'lean/heartbeats-unbounded'), true)
  })

  it('treats native_decide as a warning, not a ban', () => {
    const findings = scanText('example : (2 + 2 = 4) := by native_decide', 'lean')
    assert.equal(findings[0].rule, 'lean/native-decide')
    assert.equal(findings[0].severity, 'warning')
    assert.equal(hasBlockingFinding(findings), false)
  })

  it('flags a declared axiom and an unsafe definition as blocking', () => {
    assert.equal(hasBlockingFinding(scanText('axiom bad : False', 'lean')), true)
    assert.equal(hasBlockingFinding(scanText('unsafe def f : Nat := 0', 'lean')), true)
  })

  it('flags @[implemented_by] but not a plain @[simp]', () => {
    assert.equal(scanText('@[implemented_by fast] def f : Nat := 0', 'lean')[0].rule, 'lean/implemented-by')
    assert.deepEqual(scanText('@[simp] theorem t : True := trivial', 'lean'), [])
  })

  it('infers a language from the extension', () => {
    assert.equal(languageOf('a.lean'), 'lean')
    assert.equal(languageOf('a.PS1'), 'powershell')
    assert.equal(languageOf('a.tsx'), 'typescript')
    assert.equal(languageOf('a.unknown'), 'unknown')
  })

  it('extracts Lean declarations, including an anonymous example', () => {
    const declarations = leanDeclarations('theorem a : True := trivial\nexample : True := trivial\ndef b : Nat := 0')
    assert.deepEqual(declarations.map((entry) => entry.kind), ['theorem', 'example', 'def'])
    assert.equal(declarations[1].name, '(anonymous example)')
  })
})

describe('lean toolchain handling', () => {
  it('parses the version line Lean actually prints', () => {
    const version = parseLeanVersion('Lean (version 4.33.1, x86_64-w64-windows-gnu, commit 819816b2, Release)')
    assert.deepEqual(version, [4, 33, 1])
    assert.equal(parseLeanVersion('elan 4.2.4'), null)
  })

  it('treats anything below the soundness fix as unsafe', () => {
    assert.ok(compareVersions([4, 33, 0]) < 0)
    assert.equal(compareVersions([4, 33, 1]), 0)
    assert.ok(compareVersions([4, 34, 0]) > 0)
    assert.deepEqual(MINIMUM_SAFE_VERSION, [4, 33, 1])
  })

  it('builds a flag set that makes a missing proof fail the check', () => {
    const args = leanArgs('spec.lean')
    assert.equal(args.includes('-DwarningAsError=true'), true)
    assert.equal(args.includes('-DmaxErrors=0'), true, 'the default cap of 100 would hide later errors')
    assert.equal(args.includes('-DautoImplicit=false'), true, 'autoImplicit is ON by default in Lean')
    // The promotion pair sits before the file name, which must stay last.
    const promotion = args.indexOf('-E')
    assert.equal(args[promotion + 1], 'hasSorry', 'the kind is hasSorry, not sorry')
    assert.equal(args.at(-1), 'spec.lean')
    assert.equal(leanArgs('spec.lean', { allowSorry: true }).includes('-E'), false)
  })

  it('prefers an explicit leanPath over discovery', () => {
    const resolved = resolveLean(config({ leanPath: process.execPath }))
    assert.equal(resolved.path, process.execPath)
    assert.equal(resolved.source, 'config')
  })

  it('prefers a real toolchain directory over the elan shim on PATH', () => {
    const resolved = resolveLean(config())
    if (resolved.path === null) return // no toolchain on this machine
    assert.equal(resolved.source, 'elan-toolchain')
    assert.match(resolved.path, /toolchains/)
  })

  it('reports candidate directories rather than guessing', () => {
    assert.ok(Array.isArray(elanBinDirs()))
  })

  it('passes an explicit request to checkLean even when code is supplied', async () => {
    const result = await checkLean(config({ leanPath: process.execPath }), { code: 'example : True := trivial' })
    // node.exe is not lean; the check must fail loudly, not pretend to pass.
    assert.notEqual(result.verdict, 'accepted')
    assert.equal(result.ok, false)
  })
})

describe('language checks', () => {
  it('reports a missing checker as unavailable instead of passing', async () => {
    const file = join(ROOT, 'sample.ts')
    writeFileSync(file, 'export const x: number = 1\n', 'utf8')
    const result = await checkLanguage(config(), file, 'nonexistent-language')
    assert.equal(result.verdict, 'unavailable')
    assert.equal(result.ok, false)
    assert.match(result.notes.join(' '), /No checker is known/)
  })

  it('accepts valid JSON and rejects broken JSON in-process', async () => {
    const good = join(ROOT, 'good.json')
    const bad = join(ROOT, 'bad.json')
    writeFileSync(good, '{"a":1}', 'utf8')
    writeFileSync(bad, '{"a":1,}', 'utf8')
    assert.equal((await checkLanguage(config(), good)).verdict, 'accepted')
    assert.equal((await checkLanguage(config(), bad)).verdict, 'rejected')
  })

  it('reports a missing file as no-input rather than as a pass', async () => {
    const result = await checkLanguage(config(), join(ROOT, 'does-not-exist.py'))
    assert.equal(result.verdict, 'no-input')
    assert.equal(result.ok, false)
  })

  it('runs the real Python compiler when it exists', async () => {
    const python = resolveExecutable('python', {})
    if (python.path === null) return
    const good = join(ROOT, 'ok.py')
    const bad = join(ROOT, 'bad.py')
    writeFileSync(good, 'def f(n):\n    return n + 1\n', 'utf8')
    writeFileSync(bad, 'def f(:\n', 'utf8')
    assert.equal((await checkLanguage(config(), good, 'python')).verdict, 'accepted')
    const rejected = await checkLanguage(config(), bad, 'python')
    assert.equal(rejected.verdict, 'rejected')
    assert.ok(rejected.diagnostics.length > 0, 'a broken file must produce a diagnostic')
  }, 60_000)

  it('checks a PowerShell script with the parser the harness will actually use', async () => {
    if (process.platform !== 'win32') return
    const file = join(ROOT, 'broken.ps1')
    // `&&` is the exact construct Windows PowerShell 5.1 cannot parse.
    writeFileSync(file, 'Get-Item x && Get-Item y\n', 'utf8')
    const result = await checkLanguage(config(), file, 'powershell')
    assert.equal(result.verdict, 'rejected')
  }, 60_000)

  it('runs node --check on a syntax error without executing the file', async () => {
    const file = join(ROOT, 'broken.js')
    writeFileSync(file, 'const = 1\n', 'utf8')
    const result = await checkLanguage(config(), file, 'javascript')
    assert.equal(result.verdict, 'rejected')
  }, 60_000)
})

describe('runner', () => {
  it('captures a non-zero exit without rejecting', async () => {
    const result = await resolveExit()
    assert.equal(result.code, 1)
    assert.equal(result.spawnError, null)
  })

  it('kills a process that outlives its budget and says so', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 800 })
    assert.equal(result.timedOut, true)
    assert.equal(result.code === 0, false)
  }, 20_000)

  it('reports a missing executable instead of throwing', async () => {
    const result = await runProcess(join(ROOT, 'definitely-not-here.exe'), [], { timeoutMs: 5000 })
    assert.notEqual(result.spawnError, null)
  })

  it('finds node on PATH', () => {
    assert.notEqual(resolveExecutable('node', {}).path, null)
  })
})

/** Run node with an explicit failing exit code. */
function resolveExit() {
  return runProcess(process.execPath, ['-e', 'process.exit(1)'], { timeoutMs: 20_000 })
}

describe('strict_check tool', () => {
  /** A registry that captures the registered definition. */
  function fakeRegistry() {
    return {
      definition: null,
      register(definition) {
        this.definition = definition
        return () => { this.definition = null }
      },
    }
  }

  /** Register the tool against a fresh registry. */
  function mount(overrides = {}) {
    const registry = fakeRegistry()
    registerTool(registry, config(overrides))
    return registry.definition
  }

  it('registers a definition the harness schema subset accepts', () => {
    const definition = mount()
    assert.equal(definition.name, 'strict_check')
    assert.deepEqual(definition.parameters.required, ['action'])
    assert.deepEqual(definition.parameters.properties.action.enum, ['status', 'lean', 'batch', 'commands'])
    assert.equal(definition.output.schema.type, 'object')
  })

  it('always returns every declared output property', async () => {
    const definition = mount()
    const properties = Object.keys(definition.output.schema.properties)
    const values = [
      await definition.execute({ action: 'status' }),
      await definition.execute({ action: 'commands', command: 'Get-ChildItem' }),
    ]
    for (const value of values) {
      for (const key of properties) assert.notEqual(value[key], undefined, key + ' was undefined for ' + value.action)
    }
  }, 60_000)

  it('rejects a hazardous command and never executes it', async () => {
    const definition = mount()
    const value = await definition.execute({ action: 'commands', command: 'cd D:\\x && Remove-Item -Recurse -Force .' })
    assert.equal(value.verdict, 'rejected')
    assert.equal(value.ok, false)
    assert.equal(value.rows.some((entry) => entry.verdict === 'ps/chain-operators'), true)
    assert.match(value.notes.join(' '), /never runs the command/)
  })

  it('downgrades errors to notes when relaxed', async () => {
    const definition = mount()
    const value = await definition.execute({ action: 'commands', command: 'cd D:\\x && Get-ChildItem', relaxed: true })
    assert.equal(value.verdict, 'noted')
    assert.equal(value.ok, false)
  })

  it('says a clean scan is weak evidence', async () => {
    const definition = mount()
    const value = await definition.execute({ action: 'commands', command: 'Get-ChildItem -Path D:\\work' })
    assert.equal(value.verdict, 'clean')
    assert.match(value.notes.join(' '), /weak evidence/)
  })

  it('fails loudly when commands is called without a command', async () => {
    const definition = mount()
    await assert.rejects(() => definition.execute({ action: 'commands' }), /requires command/)
  })

  it('fails loudly when batch is called without a path', async () => {
    const definition = mount()
    await assert.rejects(() => definition.execute({ action: 'batch' }), /requires path/)
  })

  it('rejects an unknown action instead of silently doing nothing', async () => {
    const definition = mount()
    await assert.rejects(() => definition.execute({ action: 'nonsense' }), /unknown action/)
  })

  it('renders a status table naming the Lean executable', async () => {
    const definition = mount()
    const value = await definition.execute({ action: 'status' })
    const text = definition.output.render({}, value)[0].text
    assert.match(text, /lean/)
    assert.match(text, /kernel safety floor/)
  }, 60_000)
})

describe('cordis mount', () => {
  it('declares the tools dependency and exports no default', async () => {
    assert.equal(name, 'tool-strict-check')
    assert.deepEqual(inject, ['tools'])
    const module = await import('../lib/index.js')
    assert.equal(module.default, undefined)
  })

  it('registers the tool on a real context and unregisters it on dispose', async () => {
    const ctx = new Context()
    const registered = new Map()
    ctx.provide('tools', {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    })
    const fiber = ctx.plugin({ name, inject, apply }, { workDir: ROOT })
    await fiber.await()
    assert.equal(registered.has('strict_check'), true)
    await fiber.dispose()
    assert.equal(registered.size, 0)
  })
})

describe('config', () => {
  it('defaults the scratch root under DSH_HOME', () => {
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = ROOT
    try {
      assert.equal(resolveConfig({}).workDir, join(ROOT, 'strict-check'))
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('rejects nonsense back to the defaults', () => {
    const resolved = resolveConfig({ timeoutMs: -1, maxOutputChars: 'x', exposeTool: 'perhaps' })
    assert.equal(resolved.timeoutMs, DEFAULTS.timeoutMs)
    assert.equal(resolved.maxOutputChars, DEFAULTS.maxOutputChars)
    assert.equal(resolved.exposeTool, DEFAULTS.exposeTool)
  })

  it('reads YAML-ish booleans and trims paths', () => {
    const resolved = resolveConfig({ exposeTool: 'false', leanPath: '  C:\\lean.exe  ' })
    assert.equal(resolved.exposeTool, false)
    assert.equal(resolved.leanPath, 'C:\\lean.exe')
  })
})

/**
 * Live Lean integration.
 *
 * These run the real compiler and assert on real verdicts. They are skipped
 * only when no toolchain exists at all — a machine that cannot run them is a
 * machine where the plugin honestly reports `unavailable`, which the status test
 * above already covers.
 */
describe('live Lean kernel checks', () => {
  let detection

  before(async () => {
    detection = await detectLean(config())
  })

  /** Whether a usable, safe Lean toolchain is present. */
  const usable = () => detection.lean.path !== null && !detection.shimRefusal && detection.safe

  it('accepts a real proof and reports the version used', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), {
      code: 'def double (n : Nat) : Nat := n + n\ntheorem t (n : Nat) : double n = 2 * n := by simp [double, Nat.two_mul]\nexample : double 2 = 4 := by decide\n#guard double 3 == 6',
      name: 'accept',
    })
    assert.equal(result.verdict, 'accepted')
    assert.equal(result.ok, true)
    assert.equal(result.toolchainSafe, true)
    assert.match(result.version, /^4\./)
  }, 120_000)

  it('rejects a file full of sorry — the case `lean file.lean` exits 0 on', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), { code: 'example : Nat := by sorry', name: 'sorry' })
    assert.equal(result.verdict, 'rejected')
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
    assert.equal(result.forbidden.some((diagnostic) => diagnostic.kind === 'hasSorry'), true)
  }, 120_000)

  it('reports incomplete instead of rejected when allowSorry is set', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), { code: 'example : Nat := by sorry', name: 'draft', allowSorry: true })
    assert.equal(result.verdict, 'incomplete')
    assert.equal(result.ok, false)
    assert.match(result.notes.join(' '), /unproved/)
  }, 120_000)

  it('rejects a failing #guard, which is a real executable assertion', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), {
      code: 'def double (n : Nat) : Nat := n + n\n#guard double 3 == 7',
      name: 'guard',
    })
    assert.equal(result.verdict, 'rejected')
    assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join(' '), /did not evaluate to `true`/)
  }, 120_000)

  it('catches the autoImplicit typo footgun', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), { code: 'theorem t : x = 1 := by rfl', name: 'typo' })
    assert.equal(result.verdict, 'rejected')
    assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join(' '), /autoImplicit/)
  }, 120_000)

  it('rejects an unknown hole rather than passing it', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), { code: 'def f : Nat := Nat.notARealFunction 3', name: 'unknown' })
    assert.equal(result.verdict, 'rejected')
  }, 120_000)

  it('reports a missing file as no-input, not as a pass', async (t) => {
    if (!usable()) return t.skip('no safe Lean toolchain on this machine')
    const result = await checkLean(config(), { path: join(ROOT, 'absent.lean') })
    assert.equal(result.verdict, 'no-input')
    assert.equal(result.ok, false)
  }, 60_000)
})
