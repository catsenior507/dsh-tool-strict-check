/**
 * Static rules: defects that are decidable by reading, not by running.
 *
 * Two kinds of rule live here and they are held to different standards.
 *
 * **Language defects** (the `pwsh` rules) are the ones that actually cost time
 * in this harness, and each names a real failure this shell produces. They are
 * reported as findings with a severity, and a finding is never presented as a
 * proof — only as "this text says X".
 *
 * **Policy violations** (the `lean` rules) are the other way round: they exist
 * because a check can be *technically green and worthless*. A proof that uses
 * `sorry`, a budget widened with `maxHeartbeats 0`, or `@[implemented_by]`
 * binding a proof to unverified code all pass `lean file.lean` while proving
 * nothing, so a strict checker that did not name them would be a false
 * assurance. Nothing here replaces the kernel; it narrows what reaches it.
 *
 * @module @dsh-external/dsh-tool-strict-check/static
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'

/**
 * @typedef {object} Finding
 * @property {string} rule - stable rule id.
 * @property {'error'|'warning'|'info'} severity - how much it matters.
 * @property {number} line - 1-based line number, 0 when whole-file.
 * @property {string} message - what was seen.
 * @property {string} reason - why it matters.
 * @property {string} excerpt - the offending text, trimmed.
 */

/** Language family of a file, by extension. */
export function languageOf(path) {
  const extension = extname(String(path ?? '')).toLowerCase()
  if (extension === '.ps1' || extension === '.psm1' || extension === '.psd1') return 'powershell'
  if (extension === '.lean') return 'lean'
  if (extension === '.py' || extension === '.pyi') return 'python'
  if (extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts') return 'typescript'
  if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') return 'javascript'
  if (extension === '.json') return 'json'
  return 'unknown'
}

/** Read a file as UTF-8, returning null when it cannot be read. */
export function readSource(path) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Strip a PowerShell comment from the end of a line, ignoring `#` in strings. */
export function stripPowerShellComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote === null) {
      if (character === "'" || character === '"') quote = character
      else if (character === '#') return line.slice(0, index)
    } else if (character === quote) {
      // PowerShell escapes a quote by doubling it.
      if (line[index + 1] === quote) index += 1
      else quote = null
    }
  }
  return line
}

/**
 * Blank out the contents of every quoted string, preserving offsets.
 *
 * Blanked rather than removed so a rule can still report the original line and
 * so match indices stay aligned. Without this, `Write-Output 'a && b'` reads as
 * a use of the chain operators and the rule becomes noise the reader learns to
 * ignore — which is worse than not having the rule.
 * @param line - one line of source.
 * @returns the same line with string bodies replaced by spaces.
 */
export function blankPowerShellStrings(line) {
  const characters = [...String(line ?? '')]
  let quote = null
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character
        characters[index] = ' '
      }
      continue
    }
    characters[index] = ' '
    if (character === quote) {
      // A doubled quote is an escaped quote, not the end of the string.
      if (characters[index + 1] === quote) {
        characters[index + 1] = ' '
        index += 1
        continue
      }
      quote = null
    }
  }
  return characters.join('')
}

/**
 * Ordering operators PowerShell 5.1 does not have.
 *
 * `pwsh` (7+) accepts `&&` and `||`; the Windows PowerShell 5.1 that a tool
 * call actually spawns does not, and the resulting parse error names the token
 * rather than the cause. `Test-Path x && ...` is a very common way to write this
 * by accident because the same text works in the interactive shell an operator
 * tested it in.
 */
const POWERSHELL_RULES = [
  {
    id: 'ps/chain-operators',
    severity: 'error',
    pattern: /(^|[^|&])(\|\||&&)(?![|&])/,
    message: 'uses the `&&` / `||` chain operators',
    reason: 'Windows PowerShell 5.1 does not support them; the command fails to parse. Use `;` with explicit `if`, or run under pwsh 7.',
  },
  {
    id: 'ps/dollar-question-chain',
    severity: 'info',
    pattern: /\$LASTEXITCODE|\$\?/,
    message: 'reads $LASTEXITCODE / $?',
    reason: 'A failed native command in 5.1 may not set $LASTEXITCODE; prefer an explicit exit-code check on the call.',
  },
  {
    id: 'ps/automatic-erroraction-preference',
    severity: 'warning',
    pattern: /\$ErrorActionPreference\s*=\s*['"]Continue['"]/,
    message: "sets $ErrorActionPreference = 'Continue'",
    reason: 'Non-terminating errors are then reported and ignored, so a command can "succeed" while doing nothing.',
  },
  {
    id: 'ps/backtick-newline',
    severity: 'info',
    pattern: /`\s*$/,
    message: 'continues the line with a backtick',
    reason: 'A trailing space after the backtick breaks the continuation silently; prefer splatting or parentheses.',
  },
  {
    id: 'ps/relative-path-push',
    severity: 'warning',
    pattern: /\b(Set-Location|cd|Push-Location)\b/,
    message: 'changes the working directory',
    reason: 'Each harness tool call starts a fresh shell; a directory change does not survive to the next call. Pass an absolute path instead.',
  },
  {
    id: 'ps/remove-item-recurse-force',
    severity: 'error',
    pattern: /Remove-Item\b[^\n]*-Recurse[^\n]*-Force|-Force[^\n]*-Recurse/,
    message: 'recursively force-deletes',
    reason: 'This cannot be undone and is not sandboxed. Confirm the exact path is inside the intended root before running it.',
  },
  {
    id: 'ps/pipeline-stop-on-error-missing',
    severity: 'info',
    pattern: /\|\s*(Remove-Item|Move-Item|Set-Content|Copy-Item)/,
    message: 'pipes into a mutating command',
    reason: 'A partially failed pipeline still runs the right-hand side; bind the input explicitly so partial results cannot be written.',
  },
]

/**
 * Forbidden constructs in a Lean specification.
 *
 * The severities are deliberate. `sorry` and `maxHeartbeats 0` are errors
 * because they turn a green check into a false assurance. `native_decide` is a
 * warning, not an error: it is a legitimate tool whose trust story changed in
 * Lean 4.29 (it now asserts an auto-generated axiom per computation, so an axiom
 * audit does catch it) and a blanket ban would be wrong — but a reader must be
 * told, because a proof that depends on it is outside what an independent
 * checker can re-verify.
 */
const LEAN_RULES = [
  {
    id: 'lean/sorry',
    severity: 'error',
    pattern: /\b(sorry|admit)\b/,
    message: 'uses sorry / admit',
    reason: 'A sorry closes the goal with sorryAx. `lean file.lean` still exits 0, so the file looks checked while nothing is proved.',
  },
  {
    id: 'lean/heartbeats-unbounded',
    severity: 'error',
    pattern: /maxHeartbeats\s+0\b/,
    message: 'removes the heartbeat bound',
    reason: 'maxHeartbeats 0 means "no limit", so a result that only appears to terminate can never be distinguished from one that does not.',
  },
  {
    id: 'lean/heartbeats-raised',
    severity: 'warning',
    pattern: /maxHeartbeats\s+(?!0\b)\d{6,}/,
    message: 'raises the heartbeat budget far past the default (200000)',
    reason: 'A proof that needs a six-figure budget is usually a proof that is searching; record the budget with the result, because "checked" is budget-relative.',
  },
  {
    id: 'lean/axiom-declared',
    severity: 'error',
    pattern: /^\s*(private\s+|protected\s+)?axiom\b/m,
    message: 'declares an axiom',
    reason: 'An axiom is an assumption, so every theorem that depends on it is conditional on it. Only the three standard axioms are safe to allow.',
  },
  {
    id: 'lean/unsafe',
    severity: 'error',
    pattern: /^\s*(private\s+|protected\s+|partial\s+)*unsafe\b/m,
    message: 'declares an unsafe definition',
    reason: 'Unsafe code bypasses the kernel guarantee entirely, so nothing downstream of it is proved.',
  },
  {
    id: 'lean/implemented-by',
    severity: 'error',
    pattern: /@\[\s*implemented_by\b/,
    message: 'binds a definition to an unverified implementation with @[implemented_by]',
    reason: 'The kernel checks the logical definition while the compiled code runs something else, so evaluation results can disagree with the proof.',
  },
  {
    id: 'lean/extern',
    severity: 'warning',
    pattern: /@\[\s*extern\b/,
    message: 'uses @[extern]',
    reason: 'The body is supplied outside Lean, so its behaviour is not covered by any proof in this file.',
  },
  {
    id: 'lean/native-decide',
    severity: 'warning',
    pattern: /\bnative_decide\b|\bbv_decide\b/,
    message: 'uses native_decide / bv_decide',
    reason: 'Since Lean 4.29 this asserts an auto-generated axiom per computation. It is real evidence, but an independent kernel checker cannot replay it — record it and audit the axioms.',
  },
  {
    id: 'lean/auto-implicit-on',
    severity: 'warning',
    pattern: /set_option\s+autoImplicit\s+true/,
    message: 're-enables autoImplicit',
    reason: 'autoImplicit is already the Lean default; a misspelled hypothesis name then becomes a fresh universally quantified variable and the theorem states something weaker than it reads.',
  },
]

/** The three axioms a Lean proof may use without further explanation. */
export const ALLOWED_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound']

/**
 * Apply one rule set line by line.
 * @param source - file text.
 * @param rules - rule definitions.
 * @param options - `stripComment` for shells, `blankStrings` to ignore quoted text.
 * @returns findings in line order.
 */
function applyRules(source, rules, options = {}) {
  const findings = []
  const lines = String(source ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/, '')
    let line = options.stripComment === true ? stripPowerShellComment(raw) : raw
    if (options.blankStrings === true) line = blankPowerShellStrings(line)
    for (const rule of rules) {
      if (!rule.pattern.test(line)) continue
      if (rule.discourageInComment === true && /^\s*[#/]/.test(raw)) continue
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: index + 1,
        message: rule.message,
        reason: rule.reason,
        excerpt: raw.trim().slice(0, 160),
      })
    }
  }
  return findings
}

/**
 * Scan one file with the rules for its language.
 * @param path - file to scan.
 * @returns `{ language, findings, unreadable }`.
 */
export function scanFile(path) {
  const language = languageOf(path)
  const source = readSource(path)
  if (source === null) return { language, findings: [], unreadable: true }
  const findings = scanText(source, language)
  // A file whose extension is unknown is still worth scanning for Lean policy
  // violations: a spec may legitimately be named `spec.txt` while it is Lean.
  if (findings.length === 0 && language === 'unknown' && /\b(theorem|lemma|example|def)\b/.test(source)) {
    return { language: 'lean?', findings: scanText(source, 'lean'), unreadable: false }
  }
  return { language, findings, unreadable: false }
}

/**
 * Scan text as one language.
 * @param source - the text.
 * @param language - a language name from {@link languageOf}, or 'lean'.
 * @returns findings in line order.
 */
export function scanText(source, language) {
  if (language === 'lean') return applyRules(source, LEAN_RULES)
  if (language === 'powershell') return applyRules(source, POWERSHELL_RULES, { stripComment: true, blankStrings: true })
  return []
}

/**
 * Hazard rules for one shell command string.
 *
 * A command typed into `pwsh` never reaches a file, so these run on the string
 * directly. They are intentionally conservative: a false positive here costs a
 * sentence of explanation, while a missed `Remove-Item -Recurse -Force` costs a
 * directory. Quoted text is blanked before matching, so a string literal that
 * merely *contains* `&&` is not reported.
 *
 * The rule set is the same for both shells: `&&` is a parse error in Windows
 * PowerShell 5.1, and the remaining rules describe the harness's own call
 * model, which does not change with the shell.
 * @param command - the command text.
 * @returns findings.
 */
export function scanCommand(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return []
  return applyRules(text, POWERSHELL_RULES, { stripComment: true, blankStrings: true })
}

/**
 * Extract the identifiers a Lean file declares, for a cheap "did you prove
 * anything" sanity check.
 * @param source - Lean source text.
 * @returns declared names, in order.
 */
export function leanDeclarations(source) {
  const names = []
  const pattern = /^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+|partial\s+|unsafe\s+)*(theorem|lemma|example|def|abbrev|instance|structure|inductive)\s+([A-Za-z_][\w'.]*)?/gm
  let match
  while ((match = pattern.exec(String(source ?? ''))) !== null) {
    names.push({ kind: match[1], name: match[2] ?? '(anonymous example)' })
  }
  return names
}

/** Whether a finding set contains a blocking problem. */
export function hasBlockingFinding(findings) {
  return (findings ?? []).some((finding) => finding.severity === 'error')
}
