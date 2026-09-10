/**
 * Tier 0: the language's own checker.
 *
 * This tier exists because it is the cheapest true statement anyone can make
 * about a file — "the compiler parsed and accepted it" — and because it catches
 * the failure mode that costs the most time in an agent loop: an edit that
 * breaks syntax, reported three steps later by an unrelated command.
 *
 * Two rules are enforced here and they matter more than coverage:
 *
 * - **A missing checker is reported, never skipped.** If `tsc` is absent, the
 *   result says `unavailable` with the reason. A tier that silently returns
 *   "fine" when it could not run is worse than no tier at all.
 * - **Only real exit status decides.** `ok` is set from the process, not from
 *   whether any output was produced, so a checker that prints warnings is not
 *   mistaken for a checker that failed.
 *
 * @module @dsh-external/dsh-tool-strict-check/language
 */

import { existsSync } from 'node:fs'
import { resolveExecutable, runProcess } from './runner.js'
import { firstLine, parseColonDiagnostics, parsePythonDiagnostics, formatDiagnostic } from './parse.js'
import { languageOf } from './static.js'

/**
 * The checker for one language, as data.
 *
 * `argv` is a function of the path so a checker can be told to be quiet, to be
 * machine-readable, or to stop at the first error without the caller knowing
 * which flag does that.
 */
const CHECKERS = {
  python: {
    command: 'python',
    label: 'python -m py_compile',
    argv: (path) => ['-m', 'py_compile', path],
    parse: (stdout, stderr) => parsePythonDiagnostics(stderr + '\n' + stdout),
    note: 'py_compile compiles to bytecode without importing, so no side effects run and no dependencies are required.',
  },
  javascript: {
    command: 'node',
    label: 'node --check',
    argv: (path) => ['--check', path],
    parse: (stdout, stderr) => parseColonDiagnostics(stderr + '\n' + stdout),
    note: 'node --check parses the file without executing it.',
  },
  typescript: {
    command: 'tsc',
    label: 'tsc --noEmit',
    argv: (path) => ['--noEmit', '--pretty', 'false', '--skipLibCheck', path],
    parse: (stdout, stderr) => parseColonDiagnostics(stdout + '\n' + stderr),
    note: 'A single-file tsc run cannot see the project tsconfig, so path aliases and ambient types may be reported as missing. Run the project build for those.',
  },
  json: {
    command: null,
    label: 'JSON.parse',
    note: 'Parsed in-process: JSON has no external checker worth spawning.',
  },
  powershell: {
    command: 'powershell',
    label: 'powershell -Command [Parser]::ParseFile',
    argv: () => [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[void][System.Management.Automation.Language.Parser]::ParseFile((Get-Location).Path + '\\' + $args[0], [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { Write-Output ($_.Extent.StartLineNumber.ToString() + ':' + $_.Extent.StartColumnNumber.ToString() + ': error ' + $_.Message) } ; exit 1 }",
      'PLACEHOLDER',
    ],
    parse: (stdout, stderr) => parseColonDiagnostics(stdout + '\n' + stderr),
    note: 'Parses with the same engine that will run the script; a Windows PowerShell 5.1 parse failure is exactly what the harness would hit.',
  },
  lean: {
    command: null,
    label: 'strict_check lean',
    note: 'Lean needs the flag set and the axiom audit; use action=lean instead.',
  },
  unknown: { command: null, label: 'none', note: 'No checker is known for this extension. Supply a command with action=command, or name the language explicitly.' },
}

/** The checker descriptor for a language, or the unknown placeholder. */
export function checkerFor(language) {
  return CHECKERS[language] ?? CHECKERS.unknown
}

/** Whether this language has a real external checker. */
export function hasChecker(language) {
  return typeof checkerFor(language).command === 'string'
}

/**
 * Run the language-level check for one file.
 *
 * JSON is the one language with no useful external checker: a JSON error from a
 * spawned process is a worse message than `JSON.parse` produces in-process.
 * @param config - resolved plugin configuration.
 * @param path - the file to check.
 * @param language - an explicit language override, or '' to infer from the path.
 * @returns the check result.
 */
export async function checkLanguage(config, path, language = '') {
  const resolved = language === '' ? languageOf(path) : language
  const checker = checkerFor(resolved)
  const result = {
    file: path,
    language: resolved,
    tool: checker.label,
    executable: null,
    exitCode: null,
    timedOut: false,
    ok: false,
    verdict: 'unavailable',
    diagnostics: [],
    raw: [],
    notes: [],
    durationMs: 0,
  }

  if (!existsSync(path)) {
    result.verdict = 'no-input'
    result.notes.push('file does not exist: ' + path)
    return result
  }

  if (resolved === 'json') {
    const { readFileSync } = await import('node:fs')
    try {
      JSON.parse(readFileSync(path, 'utf8'))
      result.verdict = 'accepted'
      result.ok = true
    } catch (error) {
      result.verdict = 'rejected'
      result.diagnostics = [{ file: path, line: 0, column: 0, severity: 'error', kind: 'JSONError', message: String(error?.message ?? error) }]
    }
    result.notes.push(checker.note)
    return result
  }

  if (checker.command === null) {
    result.notes.push(checker.note)
    return result
  }

  const executable = resolveExecutable(checker.command, {})
  result.executable = executable.path
  if (executable.path === null) {
    result.verdict = 'unavailable'
    result.notes.push(
      '`' + checker.command + '` is not on PATH, so this file was NOT checked. Add the language toolchain or pass an explicit command instead of treating this as a pass.',
    )
    return result
  }

  // The PowerShell parser takes the file name as a positional argument, so the
  // argument vector is rewritten here rather than inside the descriptor, which
  // must stay a pure function of the path.
  const argv = checker.argv(path).map((entry) => (entry === 'PLACEHOLDER' ? path : entry))
  const run = await runProcess(executable.path, argv, {
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
  })
  result.exitCode = run.code
  result.timedOut = run.timedOut
  result.durationMs = run.durationMs
  const parsed = checker.parse(run.stdout, run.stderr)
  result.diagnostics = parsed.diagnostics
  result.raw = parsed.raw.slice(0, 40)

  if (run.timedOut) {
    result.verdict = 'budget'
    result.notes.push('the checker was killed at ' + config.timeoutMs + ' ms with no verdict')
  } else if (run.spawnError !== null) {
    result.verdict = 'unavailable'
    result.notes.push('could not start the checker: ' + run.spawnError)
  } else if (run.code === 0) {
    result.verdict = 'accepted'
    result.ok = true
  } else {
    result.verdict = 'rejected'
    if (result.diagnostics.length === 0) {
      result.notes.push(
        'the checker exited ' + run.code + ' but its output did not match a known diagnostic format; the raw output below is the whole result.',
      )
    }
  }
  result.notes.push(checker.note)
  return result
}

/**
 * Check several files, sequentially.
 *
 * Sequential on purpose: a batch of checks is a stop-the-line gate before a
 * commit, and running four compilers at once turns a clear first failure into
 * four interleaved ones while competing for the same CPU the dashboard needs.
 * @param config - resolved plugin configuration.
 * @param paths - files to check.
 * @param language - an explicit language override applied to every file.
 * @returns one row per file plus a totals summary.
 */
export async function checkBatch(config, paths, language = '') {
  const rows = []
  for (const path of paths) {
    rows.push(await checkLanguage(config, path, language))
  }
  const counts = { accepted: 0, rejected: 0, unavailable: 0, other: 0 }
  for (const row of rows) {
    if (row.verdict === 'accepted') counts.accepted += 1
    else if (row.verdict === 'rejected') counts.rejected += 1
    else if (row.verdict === 'unavailable') counts.unavailable += 1
    else counts.other += 1
  }
  return { rows, counts }
}

/** One line summarizing a language check, for the tool's notes. */
export function summarizeLanguageCheck(result) {
  const head = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').slice(0, 3).map(formatDiagnostic)
  if (head.length > 0) return head.join(' | ')
  return firstLine(result.raw.join('\n'))
}
