/**
 * The model-facing half: `strict_check`.
 *
 * The premise is narrow and worth stating, because it is the difference between
 * this tool and reading the code again: **a check that cannot fail is not a
 * check.** Every action here ends in a verdict that some program produced, and
 * every unavailable checker is reported as unavailable rather than quietly
 * skipped. When the tool says `accepted`, a compiler said so; when it says
 * `unavailable`, nothing was proved and the note says which binary is missing.
 *
 * The actions are the tiers, cheapest first:
 *
 * - `status` — what can actually be checked here, with versions. Call it first;
 *   everything else is interpreted relative to what this reports.
 * - `lean` — the strict tier. Writes the spec as UTF-8, runs `lean --json` with
 *   warnings promoted to errors and `autoImplicit` forced off, and reads the
 *   result out of the kernel's own diagnostics.
 * - `commands` — static hazards in shell text, because the harness spawns a
 *   fresh Windows PowerShell 5.1 per tool call and most of the shell failures
 *   that waste a turn are decidable before the command runs.
 * - `batch` — the language's own checker over several files: type and syntax
 *   errors, in one call, at the gate before a commit.
 *
 * @module @dsh-external/dsh-tool-strict-check/tool
 */

import { checkBatch, checkLanguage } from './language.js'
import { checkLean, collectAxiomReports, detectLean, formatVersion, MINIMUM_SAFE_VERSION } from './lean.js'
import { formatDiagnostic } from './parse.js'
import { resolveExecutable } from './runner.js'
import { hasBlockingFinding, languageOf, leanDeclarations, scanCommand, scanFile } from './static.js'

/** The model-facing tool name. */
export const TOOL_NAME = 'strict_check'

/** Parameter schema, written directly as JSON Schema. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'lean', 'batch', 'commands'],
      description:
        'status reports which checkers exist here and their versions. lean kernel-checks a Lean 4 specification (a proof, or a #guard / example assertion). batch runs the language compiler over files. commands statically checks shell text against the hazards of this harness shell. Run status first: every other action means less without knowing which tools are present.',
    },
    path: {
      type: 'string',
      description: 'One file to check. For lean, either this or code is required. For batch, separate several paths with commas.',
    },
    code: {
      type: 'string',
      description:
        'Inline Lean source for action=lean, written as UTF-8 into the scratch directory. Use it for a small check without touching the repository.',
    },
    name: { type: 'string', description: 'Label for inline code, used for the generated file name only.' },
    command: { type: 'string', description: 'Shell text for action=commands; checked statically and never executed.' },
    shell: { type: 'string', enum: ['pwsh', 'powershell'], description: 'Intended shell for action=commands. The harness spawns powershell 5.1.' },
    language: {
      type: 'string',
      enum: ['lean', 'python', 'javascript', 'typescript', 'powershell', 'json', ''],
      description: 'Override language inference for a check that would otherwise guess from the extension.',
    },
    allowSorry: {
      type: 'boolean',
      description:
        'For action=lean: keep going when a declaration uses sorry, and report it as incomplete instead of a failure. Useful while drafting a spec, never for a claim.',
    },
    relaxed: {
      type: 'boolean',
      description: 'For action=commands: drop the error-level shell rules and report them as notes only.',
    },
  },
  required: ['action'],
}

/** Output schema: the canonical value every call returns. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    summary: { type: 'string' },
    verdict: { type: 'string' },
    ok: { type: 'boolean' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          verdict: { type: 'string' },
          tool: { type: 'string' },
          version: { type: 'string' },
          location: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'summary', 'verdict', 'ok', 'rows', 'notes'],
}

/** The tool description the model reads. */
const DESCRIPTION = [
  'Check code and commands with real checkers instead of re-reading them. Use it when fixing a bug or touching a critical directory, where being wrong is more expensive than waiting.',
  'action=status reports which checkers exist on this machine, with versions, and is the honest answer to "can this even be checked here".',
  'action=lean kernel-checks a Lean 4 specification: pass path to a .lean file, or code for inline source. It runs lean with warnings promoted to errors, so a `sorry` fails the check instead of passing with a warning — that promotion is the whole point, because `lean file.lean` exits 0 on an unproved theorem.',
  'action=batch runs the language compiler (py_compile, node --check, tsc --noEmit) over files and returns the diagnostics.',
  'action=commands checks shell text against the hazards that actually break in this harness — `&&`/`||` chain operators that Windows PowerShell 5.1 cannot parse, directory changes that do not survive a tool call, recursive force-deletes. The command is never executed.',
  'A verdict of `unavailable` means no checker ran and nothing was proved. Treat it as a gap to close, not as a pass.',
].join(' ')

/** One blank row, so the output schema never sees an undefined property. */
function row(overrides) {
  return { name: '', verdict: '', tool: '', version: '', location: '', detail: '', ...overrides }
}

/** Render the canonical value for the model. */
function render(_args, value) {
  const lines = [value.summary]
  for (const note of value.notes) lines.push('· ' + note)
  if (value.rows.length > 0) {
    lines.push('')
    for (const entry of value.rows) {
      const head = [entry.name, entry.verdict, entry.tool, entry.version].filter((part) => part !== '').join('  |  ')
      lines.push(head)
      if (entry.location !== '') lines.push('    ' + entry.location)
      if (entry.detail !== '') {
        for (const line of entry.detail.split('\n')) lines.push('    ' + line)
      }
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the `strict_check` tool.
 * @param tools - the `ctx.tools` registry.
 * @param config - resolved plugin configuration.
 * @returns the disposer removing the tool.
 */
export function registerTool(tools, config) {
  const definition = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args) {
      return run(config, args ?? {})
    },
  }
  return tools.register(definition)
}

/** Execute one call. */
async function run(config, args) {
  const action = typeof args.action === 'string' ? args.action : 'status'
  const notes = []
  const rows = []
  let summary = ''
  let verdict = 'unavailable'
  let ok = false

  if (action === 'status') {
    const detection = await detectLean(config)
    const leanVersion = detection.version === null ? (detection.shimRefusal ? 'shim, no default toolchain' : '') : formatVersion(detection.version)
    rows.push(row({
      name: 'lean',
      verdict: detection.lean.path === null ? 'missing' : detection.shimRefusal ? 'unusable' : 'available',
      tool: detection.lean.path ?? '',
      version: leanVersion,
      detail: detection.lean.path === null
        ? 'Not found on PATH or under ELAN_HOME. `elan toolchain install leanprover/lean4:v4.33.1` installs it.'
        : detection.shimRefusal
          ? 'The elan shim is present but no default toolchain is configured. Run `elan default leanprover/lean4:v4.33.1`, or set leanPath to the toolchain binary.'
          : '',
    }))
    if (detection.version !== null) {
      rows.push(row({
        name: 'kernel safety floor',
        verdict: detection.safe ? 'met' : 'below floor',
        version: 'needs >= ' + formatVersion(MINIMUM_SAFE_VERSION),
        detail: detection.safe
          ? 'Kernel soundness bugs fixed in 4.33.1 are not present in this toolchain.'
          : 'This toolchain predates the fixes for eight kernel and runtime soundness bugs, each of which allowed a proof of `False`.',
      }))
    }
    const languageProbes = [
      { language: 'python', command: 'python' },
      { language: 'javascript', command: 'node' },
      { language: 'typescript', command: 'tsc' },
      { language: 'powershell', command: 'powershell' },
    ]
    for (const probe of languageProbes) {
      const resolved = resolveExecutable(probe.command, {})
      rows.push(row({
        name: probe.language,
        verdict: resolved.path === null ? 'missing' : 'available',
        tool: resolved.path ?? probe.command,
      }))
    }
    const missing = rows.filter((entry) => entry.verdict === 'missing').map((entry) => entry.name)
    verdict = detection.lean.path !== null && !detection.shimRefusal ? 'ready' : 'degraded'
    ok = verdict === 'ready'
    summary =
      verdict === 'ready'
        ? 'Strict checking is available: Lean ' + (leanVersion === '' ? '' : leanVersion + ' ') + 'and the language compilers resolved.'
        : 'Strict checking is degraded: ' + (missing.length > 0 ? missing.join(', ') + ' missing' : 'Lean unusable') + '.'
    notes.push('Paths above are absolute and were executed with `--version`; a name that is missing is a real gap, not a guess.')
    if (!detection.safe && detection.version !== null) {
      notes.push('A Lean pass on this toolchain is not evidence: upgrade to 4.33.1 or newer before trusting a proof.')
    }
    return { action, summary, verdict, ok, rows, notes }
  }

  if (action === 'lean') {
    const result = await checkLean(config, {
      path: args.path,
      code: args.code,
      name: args.name,
      allowSorry: args.allowSorry === true,
    })
    verdict = result.verdict
    ok = result.ok
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
    for (const diagnostic of [...errors, ...warnings, ...result.diagnostics.filter((d) => d.severity === 'info')].slice(0, 30)) {
      rows.push(row({
        name: diagnostic.severity,
        verdict: diagnostic.kind,
        location: diagnostic.file + ':' + diagnostic.line + ':' + diagnostic.column,
        detail: diagnostic.message,
      }))
    }
    for (const report of collectAxiomReports(result.diagnostics)) {
      rows.push(row({
        name: 'axioms',
        verdict: report.unexpected.length === 0 ? 'within the allowed set' : 'UNEXPECTED',
        tool: report.declaration,
        detail: report.axioms.length === 0 ? '(no axioms reported)' : report.axioms.join(', '),
      }))
    }
    summary =
      'lean ' + result.verdict + (result.version === '' ? '' : ' (Lean ' + result.version + ')') +
      ': ' + errors.length + ' error(s), ' + warnings.length + ' warning(s), exit ' + String(result.exitCode) +
      ', ' + result.durationMs + ' ms.'
    notes.push(...result.notes)
    if (result.raw.length > 0) {
      notes.push('unparsed checker output (kept rather than dropped): ' + result.raw.slice(0, 3).join(' ⏎ '))
    }
    if (result.verdict === 'accepted') {
      notes.push('This is a kernel check with `sorry` promoted to an error and autoImplicit disabled. It is the strongest verdict this tool can give; it is not a statement about whether the spec says what you meant.')
    }
    if (result.verdict === 'incomplete') {
      notes.push('Every theorem downstream of a `sorry` is unproved even though the file type-checks. Replace the sorry, or pass allowSorry only while drafting.')
    }
    return { action, summary, verdict, ok, rows, notes }
  }

  if (action === 'commands') {
    const text = typeof args.command === 'string' ? args.command : ''
    if (text.trim() === '') throw new Error('strict_check: action=commands requires command')
    const findings = scanCommand(text, args.shell === 'powershell' ? 'powershell' : 'pwsh')
    const relaxed = args.relaxed === true
    for (const finding of findings) {
      const severity = relaxed && finding.severity === 'error' ? 'warning' : finding.severity
      rows.push(row({
        name: finding.severity,
        verdict: finding.rule,
        location: 'line ' + finding.line,
        detail: finding.message + ' — ' + finding.reason + (finding.excerpt === '' ? '' : '\n> ' + finding.excerpt),
      }))
    }
    const blocking = findings.filter((finding) => finding.severity === 'error')
    verdict = blocking.length > 0 && !relaxed ? 'rejected' : findings.length > 0 ? 'noted' : 'clean'
    ok = verdict === 'clean'
    summary =
      findings.length === 0
        ? 'No static hazard matched. The command was NOT executed, so this is a statement about its text, not about its result.'
        : findings.length + ' finding(s): ' + blocking.length + ' error-level.'
    notes.push('This action never runs the command. Run it yourself once the findings are addressed, and read the failure journal if it still fails.')
    if (verdict === 'clean') {
      notes.push('A clean scan is weak evidence: it cannot know whether the paths exist or whether the program is correct.')
    }
    return { action, summary, verdict, ok, rows, notes }
  }

  if (action === 'batch') {
    const raw = typeof args.path === 'string' ? args.path : ''
    const paths = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    if (paths.length === 0) throw new Error('strict_check: action=batch requires path (comma-separate several files)')
    const language = typeof args.language === 'string' ? args.language : ''
    const { rows: results, counts } = await checkBatch(config, paths, language)
    for (const result of results) {
      rows.push(row({
        name: result.file,
        verdict: result.verdict,
        tool: result.tool,
        location: result.diagnostics.length > 0 ? result.diagnostics.slice(0, 8).map(formatDiagnostic).join('\n') : '',
        detail: result.notes.join(' '),
      }))
    }
    verdict = counts.rejected > 0 ? 'rejected' : counts.unavailable > 0 ? 'partial' : 'accepted'
    ok = counts.rejected === 0 && counts.unavailable === 0
    summary =
      results.length + ' file(s): ' + counts.accepted + ' accepted, ' + counts.rejected + ' rejected, ' +
      counts.unavailable + ' not checked.'
    if (counts.unavailable > 0) {
      notes.push('A file counted as "not checked" had no checker available. That is a gap in evidence, not a pass.')
    }
    return { action, summary, verdict, ok, rows, notes }
  }

  throw new Error('strict_check: unknown action ' + action)
}

/**
 * Static scan of one file without running a compiler.
 *
 * Exported because `batch` is expected to grow a `static` mode and because the
 * rule sets are the part most worth testing in isolation.
 * @param path - file to scan.
 * @returns findings plus the language that was assumed.
 */
export function scanOne(path) {
  const result = scanFile(path)
  return { ...result, blocking: hasBlockingFinding(result.findings) }
}

/** Re-exported so the rules and the declaration extractor are testable alone. */
export { leanDeclarations, languageOf, checkLanguage, scanCommand, scanFile, hasBlockingFinding }

/**
 * The policy-facing surface.
 *
 * `dsh-policy-strict-gate` enforces what this plugin only offers, and it must
 * judge a specification by exactly the same rules — the same flags, the same
 * version floor, the same verdict vocabulary. Rather than let the gate re-derive
 * that and drift, this plugin publishes the primitives it needs. This is
 * internal API, not model-facing: changing it changes a policy's meaning, so
 * treat it as a contract rather than as exports.
 */
export { checkLean, detectLean, leanArgs, formatVersion, MINIMUM_SAFE_VERSION } from './lean.js'

/** The configuration type the checkers expect, for a policy that drives them. */
export { resolveConfig } from './config.js'
