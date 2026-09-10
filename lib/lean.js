/**
 * The Lean half: a real kernel check, plus the audit that keeps it honest.
 *
 * The whole reason to reach for Lean rather than a linter is that it does not
 * have an opinion — it either accepts the proof or it does not. That strength
 * has two exact failure modes, and this module is built to close both:
 *
 * 1. **A green exit code that proves nothing.** `lean file.lean` exits 0 on a
 *    file full of `sorry`, because a missing proof is a *warning* in Lean. The
 *    fix is not a regex: the harness promotes `hasSorry` to an error, so the
 *    missing proof changes the exit code, and the source scan in `static.js`
 *    runs as a second, independent net.
 * 2. **A solver that never terminates.** Lean bounds work with heartbeats. A
 *    file that raises or removes that bound cannot be distinguished from one
 *    that simply has not finished, so the bound is pinned on the command line
 *    and a heartbeat stop is reported as a budget result rather than a failure.
 *
 * What is deliberately NOT here: `lake check`, comparator, and `leanchecker`.
 * The first two are Linux-only (they need `bwrap` and user namespaces), and
 * `leanchecker` re-checks declarations that are already kernel-checked — it
 * catches environment hacking, which is not the threat model for a spec the
 * agent just wrote. Building that plumbing now would be cost without coverage;
 * Lean 4.35 is expected to ship `lake check`, and that is the right time to
 * adopt it.
 *
 * @module @dsh-external/dsh-tool-strict-check/lean
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { elanBinDirs, isExecutableFile, resolveExecutable, runProcess, WINDOWS } from './runner.js'
import { findForbidden, dropForbidden, mergeDiagnostics, parseLeanJson } from './parse.js'
import { ALLOWED_AXIOMS } from './static.js'

/**
 * The oldest Lean release whose kernel is safe to trust.
 *
 * Between 2026-07-30 and 2026-08-20 eight soundness bugs were found in the Lean
 * kernel and runtime, each exploited to make the official kernel accept a proof
 * of `False`; they were fixed in 4.33.1 (2026-08-21). A proof accepted by an
 * older kernel is not evidence of anything, so an older toolchain is reported
 * as a blocking problem rather than a warning — and the version actually used
 * is printed with every result, because "checked" is only meaningful next to
 * the checker that checked it.
 */
export const MINIMUM_SAFE_VERSION = [4, 33, 1]

/** Message kinds that mean a goal was abandoned rather than proved. */
export const SORRY_KINDS = ['hasSorry', 'sorry']

/**
 * Parse a Lean version out of `lean --version` output.
 *
 * The output must actually come from Lean. Measured on this machine, `lean
 * --version` prints `Lean (version 4.33.1, x86_64-w64-windows-gnu, commit …,
 * Release)`, while `node --version` prints `v24.16.0` — and a bare
 * `major.minor.patch` regex would read that as a toolchain newer than the
 * soundness floor and wave through a "kernel check" performed by Node. Anchoring
 * on the product name is what makes the identity check real.
 * @param text - `lean --version` output.
 * @returns `[major, minor, patch]`, or null when this is not Lean's version line.
 */
export function parseLeanVersion(text) {
  const value = String(text ?? '')
  if (!/\blean\b/i.test(value)) return null
  const match = /version\s+(\d+)\.(\d+)\.(\d+)/i.exec(value)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare a version triple against the minimum safe release.
 * @param version - `[major, minor, patch]`.
 * @returns negative when older, 0 when equal, positive when newer.
 */
export function compareVersions(version, minimum = MINIMUM_SAFE_VERSION) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (version[index] ?? 0) - (minimum[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Render a version triple. */
export function formatVersion(version) {
  return version === undefined || version === null ? 'unknown' : version.join('.')
}

/**
 * Find a `lean` that actually runs.
 *
 * The elan *shim* at `<ELAN_HOME>/bin/lean.exe` is a hardlink of `elan.exe` and
 * answers every invocation with `error: no default toolchain configured` until
 * `elan default` has been run once — measured on this machine, and easy to
 * mistake for "Lean is broken". The real compiler lives at
 * `<ELAN_HOME>/toolchains/<name>/bin/lean.exe` and runs with no configuration
 * at all, which is exactly what a plugin should depend on: the check must not
 * change meaning because someone edited a global elan setting.
 *
 * So the toolchain directory is searched **first**, newest release preferred,
 * release candidates last, and PATH is only consulted afterwards. An explicit
 * `leanPath` in the profile still wins over everything.
 * @param config - resolved plugin configuration.
 * @returns `{ path, source, tried, shimOnly }`.
 */
export function resolveLean(config) {
  if (typeof config.leanPath === 'string' && config.leanPath.trim() !== '') {
    const explicit = config.leanPath.trim()
    if (isExecutableFile(explicit)) return { path: explicit, source: 'config', tried: [explicit], shimOnly: false }
  }
  const extensions = WINDOWS ? ['', '.exe', '.cmd', '.bat'] : ['']
  const tried = []
  for (const directory of elanBinDirs()) {
    // `elanBinDirs` returns `…/bin` shim directories and `…/toolchains/<v>/bin`
    // directly, so shim directories are skipped here rather than probed and
    // rejected: a shim that resolves but cannot run is worse than none.
    if (/[\\/]toolchains[\\/][^\\/]+[\\/]bin$/.test(directory)) {
      for (const extension of extensions) {
        const candidate = join(directory, 'lean' + extension)
        if (isExecutableFile(candidate)) return { path: candidate, source: 'elan-toolchain', tried, shimOnly: false }
      }
    }
    tried.push(directory)
  }
  const onPath = resolveExecutable('lean', {})
  if (onPath.path !== null) {
    const source = onPath.source === 'elan' ? 'elan-shim' : onPath.source
    return { path: onPath.path, source, tried: [...tried, ...onPath.tried], shimOnly: source === 'elan-shim' }
  }
  return { path: null, source: null, tried, shimOnly: false }
}

/** Whether output looks like the elan "no default toolchain" refusal. */
export function isShimRefusal(text) {
  return /no default toolchain configured/i.test(String(text ?? ''))
}

/**
 * Discover the Lean toolchain and report exactly what was found.
 * @param config - resolved plugin configuration.
 * @returns `{ lean, lake, elan, version, versionText, safe, toolchainFile }`.
 */
export async function detectLean(config) {
  const lean = resolveLean(config)
  const lake = resolveExecutable('lake', { explicit: config.lakePath })
  const elan = resolveExecutable('elan', { explicit: config.elanPath })
  const report = {
    lean: { path: lean.path, source: lean.source, tried: lean.tried },
    lake: { path: lake.path, source: lake.source },
    elan: { path: elan.path, source: elan.source },
    version: null,
    versionText: '',
    safe: false,
    shimRefusal: false,
    toolchainFile: '',
  }
  if (lean.path === null) return report

  const probe = await runProcess(lean.path, ['--version'], { timeoutMs: 30_000 })
  const probeText = (probe.stdout + '\n' + probe.stderr).trim()
  report.shimRefusal = isShimRefusal(probeText)
  report.versionText = probeText.split('\n')[0] ?? ''
  report.version = parseLeanVersion(report.versionText)
  report.safe = report.version !== null && compareVersions(report.version) >= 0

  // `lean --print-prefix` names the toolchain root, which is how the pinned
  // `lean-toolchain` file is found without guessing elan's layout.
  if (!report.shimRefusal) {
    const prefix = await runProcess(lean.path, ['--print-prefix'], { timeoutMs: 30_000 })
    const prefixText = (prefix.stdout || prefix.stderr).trim()
    if (prefixText !== '') report.toolchainFile = join(prefixText, '..', 'lean-toolchain')
  }
  return report
}

/**
 * Build the argument vector for one strict check.
 *
 * Every flag earns its place:
 * - `--json` makes the output machine-readable, so a diagnostic cannot be lost
 *   to a formatting change.
 * - `-DwarningAsError=true` is what turns "declaration uses `sorry`" from a
 *   warning into a failure. Without it a vacuous proof exits 0.
 * - `-E hasSorry` promotes only the missing-proof kind, so a check can demand
 *   "no unfinished goals" without demanding "no warnings at all".
 * - `-DmaxErrors=0` removes the default cap of 100, past which Lean stops
 *   reporting and exits — which would hide every error after the hundredth.
 * - `-DautoImplicit=false` closes the vacuity footgun where a misspelled
 *   hypothesis name silently becomes a fresh universally quantified variable.
 *   It is ON by default in Lean, so it must be turned off explicitly.
 * @param path - the file to check.
 * @param options - `allowSorry` keeps the file checkable but reports it.
 * @returns the argument vector.
 */
export function leanArgs(path, options = {}) {
  const args = ['--json', '-DwarningAsError=true', '-DmaxErrors=0', '-DautoImplicit=false']
  if (options.allowSorry !== true) args.push('-E', 'hasSorry')
  args.push(path)
  return args
}

/**
 * Language-level check of one Lean source.
 *
 * A `.lean` sibling of the spec is written next to the checked file so the
 * agent's own toolchain selection (a `lean-toolchain` file or a Lake project)
 * applies to it exactly as it would to the file it wrote.
 * @param config - resolved plugin configuration.
 * @param input - `{ path?, code?, name?, allowSorry? }`.
 * @returns the check result.
 */
export async function checkLean(config, input) {
  const detection = await detectLean(config)
  const result = {
    tool: 'lean',
    executable: detection.lean.path,
    version: formatVersion(detection.version),
    versionText: detection.versionText,
    toolchainSafe: detection.safe,
    exitCode: null,
    timedOut: false,
    ok: false,
    verdict: 'unavailable',
    diagnostics: [],
    forbidden: [],
    raw: [],
    notes: [],
    args: [],
    durationMs: 0,
  }

  if (detection.lean.path === null) {
    result.notes.push(
      'lean was not found. Install it with `elan toolchain install leanprover/lean4:v4.33.1`, then either point `leanPath` at `<ELAN_HOME>/toolchains/<toolchain>/bin/lean.exe` or leave it empty and let discovery find the toolchain directory.',
    )
    return result
  }
  if (detection.shimRefusal) {
    result.verdict = 'unavailable'
    result.notes.push(
      'the resolved `lean` is the elan shim and it has no default toolchain configured, so nothing was checked. Run `elan default leanprover/lean4:v4.33.1` once, or set `leanPath` to the real compiler under `<ELAN_HOME>/toolchains/<toolchain>/bin/lean.exe`.',
    )
    return result
  }
  if (!detection.safe) {
    result.verdict = 'unsafe-toolchain'
    result.notes.push(
      'Lean ' +
        (result.version === 'unknown' ? '(unparseable version)' : result.version) +
        ' is older than ' +
        formatVersion(MINIMUM_SAFE_VERSION) +
        '. Eight kernel and runtime soundness bugs fixed in 4.33.1 each allowed a proof of `False`, so a pass here is not evidence.',
    )
  }

  let path = input.path
  let source = null
  if (typeof input.code === 'string' && input.code.trim() !== '') {
    source = input.code
    if (typeof path !== 'string' || path.trim() === '') {
      const root = scratchDir(config)
      path = join(root, sanitizeName(input.name ?? 'spec') + '.lean')
    }
  }
  if (typeof path !== 'string' || path.trim() === '') {
    result.notes.push('no file path and no code were given')
    result.verdict = 'no-input'
    return result
  }
  if (source !== null) {
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      // UTF-8 without a BOM, written from Node: Lean decodes source bytes
      // lossily, so a file saved in the machine's GBK code page would silently
      // turn `∀` and `→` into replacement characters instead of failing.
      writeFileSync(path, source, 'utf8')
    } catch (error) {
      result.verdict = 'io-error'
      result.notes.push('could not write the spec file: ' + String(error))
      return result
    }
  } else if (!existsSync(path)) {
    result.verdict = 'no-input'
    result.notes.push('file does not exist: ' + path)
    return result
  }

  result.args = leanArgs(path, input)
  const run = await runProcess(detection.lean.path, result.args, {
    cwd: config.projectDir === '' ? undefined : config.projectDir,
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
  })
  result.exitCode = run.code
  result.timedOut = run.timedOut
  result.durationMs = run.durationMs

  // Lean writes messages to stdout and CLI-usage errors to stderr; both carry
  // diagnostics, so both are parsed.
  const parsed = mergeDiagnostics(parseLeanJson(run.stdout).diagnostics, parseLeanJson(run.stderr).diagnostics)
  const forbidden = findForbidden(parsed, SORRY_KINDS)
  // With `allowSorry` the promoted sorry error is dropped from the diagnostic
  // list so it cannot decide the verdict; it is still reported separately, so
  // the draft is described as incomplete rather than as accepted.
  result.diagnostics = input.allowSorry === true ? dropForbidden(parsed, SORRY_KINDS) : parsed
  result.raw = [...parseLeanJson(run.stdout).raw, ...parseLeanJson(run.stderr).raw].slice(0, 40)
  result.forbidden = forbidden

  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')

  if (run.timedOut) {
    result.verdict = 'budget'
    result.notes.push(
      'the checker was killed at ' + config.timeoutMs + ' ms. Lean bounds work with heartbeats (default 200000); a stop there is reported as `runtime.maxHeartbeats` — read the diagnostics before assuming the proof is wrong.',
    )
  } else if (run.spawnError !== null) {
    result.verdict = 'unavailable'
    result.notes.push('could not start the checker: ' + run.spawnError)
  } else if (!detection.safe) {
    // Deliberately ordered before the error checks: a clean exit code from a
    // toolchain below the soundness floor must never be reported as `accepted`,
    // and `ok` already refuses it — leaving the verdict at `accepted` would
    // make the two fields contradict each other on exactly the result a reader
    // is most likely to skim.
    result.verdict = 'unsafe-toolchain'
  } else if (errors.some((diagnostic) => diagnostic.kind.toLowerCase().includes('maxheartbeat') || diagnostic.message.toLowerCase().includes('maxheartbeats'))) {
    result.verdict = 'budget'
    result.notes.push('Lean stopped at its heartbeat budget; the source is neither proved nor refuted at this budget.')
  } else if (errors.length > 0) {
    result.verdict = 'rejected'
  } else if (result.forbidden.length > 0) {
    // Unreachable while `-E hasSorry` is passed, because the promoted warning
    // is already an error; it stays as the path taken when the caller asked for
    // `allowSorry`, which is exactly when a human needs to be told.
    result.verdict = 'incomplete'
    result.notes.push(
      result.forbidden.length +
        ' declaration(s) still depend on `sorry`. The file type-checks, but every theorem downstream of those declarations is unproved.',
    )
  } else if (warnings.length > 0) {
    result.verdict = 'accepted-with-warnings'
  } else {
    result.verdict = 'accepted'
  }

  result.ok = result.verdict === 'accepted' && result.toolchainSafe
  result.notes.push('checked with ' + (result.versionText === '' ? 'lean (version unparsed)' : result.versionText))
  if (detection.lean.source === 'elan-toolchain') {
    result.notes.push(
      'toolchain resolved inside the elan toolchains directory, not through the elan shim or PATH — the check does not depend on a configured default toolchain.',
    )
  }
  return result
}

/** The scratch root for generated specs. */
export function scratchDir(config) {
  const root = join(config.workDir, 'specs')
  mkdirSync(root, { recursive: true })
  return root
}

/** A file-name-safe version of an arbitrary label. */
export function sanitizeName(name) {
  const text = String(name ?? 'spec').trim()
  if (text === '') return 'spec'
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
}

/**
 * The axiom list Lean printed for a declaration, if the spec asked for one.
 *
 * `#print axioms foo` is an info message, so it never changes the exit code —
 * which is precisely why it is worth reading back: an axiom audit is the only
 * cheap evidence about *why* a proof holds.
 * @param diagnostics - parsed lean diagnostics.
 * @returns one row per declaration the spec asked about.
 */
export function collectAxiomReports(diagnostics) {
  const reports = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind.toLowerCase() !== 'printaxioms' && !/depends on axioms/i.test(diagnostic.message)) continue
    const match = /'?([\w'.]+)'?\s+depends on axioms:\s*\[([^\]]*)\]/i.exec(diagnostic.message)
    const axioms = match === null
      ? []
      : match[2].split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    reports.push({
      declaration: match === null ? diagnostic.message.slice(0, 80) : match[1],
      axioms,
      unexpected: axioms.filter((axiom) => !ALLOWED_AXIOMS.includes(axiom)),
    })
  }
  return reports
}

/** Whether the platform can run the sandboxed strict checkers at all. */
export function strictBackendAvailable() {
  return !WINDOWS && process.platform === 'linux'
}
