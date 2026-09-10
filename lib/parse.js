/**
 * Diagnostic extraction: turning checker output into rows a reader can act on.
 *
 * The formats below were read off this machine's own toolchains rather than
 * recalled. Two properties matter more than completeness:
 *
 * - **An unrecognized line is still reported.** A parser that silently drops
 *   output it does not understand turns "the checker said something I did not
 *   parse" into "the checker said nothing", which is the exact failure mode this
 *   plugin exists to prevent. Unparsed output is kept in `raw` and surfaced in
 *   the tool's notes.
 * - **Severity drives the verdict, not the presence of output.** Lean's own
 *   `sorry` warning does not change its exit code, so a checker's exit status
 *   alone is not a verdict; `warningAsError` and explicit sorry scanning are
 *   what make the verdict strict.
 *
 * @module @dsh-external/dsh-tool-strict-check/parse
 */

/**
 * @typedef {object} Diagnostic
 * @property {string} file - path as the checker reported it.
 * @property {number} line - 1-based line, or 0 when unknown.
 * @property {number} column - 1-based column, or 0 when unknown.
 * @property {'error'|'warning'|'info'|'hint'} severity - normalized severity.
 * @property {string} kind - checker-specific message kind, when reported.
 * @property {string} message - the rendered message text.
 */

/** Normalize a severity word. */
function severityOf(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'error') return 'error'
  if (text === 'warning') return 'warning'
  if (text === 'info' || text === 'information') return 'info'
  return 'hint'
}

/**
 * Read the message kind out of a Lean JSON message.
 *
 * Measured on Lean 4.33.1, the field is a bare string holding either a tag
 * (`"hasSorry"`) or a dotted name (`"lean.unknownIdentifier._namedError"`).
 * The tagged-object form is accepted too, because an older serialization used
 * it and the sorry detector downstream keys off this value — a missed kind is a
 * missed vacuous proof.
 * @param raw - the `kind` field of a serialized Lean message.
 * @returns the kind name, or '' when absent.
 */
export function kindName(raw) {
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.tag === 'string') return raw.tag
    if (typeof raw.name === 'string') return raw.name
  }
  return ''
}

/**
 * Parse the output of `lean --json`.
 *
 * Measured against Lean 4.33.1: one JSON object per line on **stdout**, with
 * `fileName`, `pos{line,column}`, `endPos`, `severity`, `kind`, `caption`,
 * `data`, `isSilent`, and `keepFullRange`.
 *
 * Two details are load-bearing and neither is guessable:
 *
 * - **`pos.line` and `pos.column` are 0-based.** They are converted to the
 *   1-based numbers every editor and every other compiler in this plugin
 *   reports, so a location printed by `strict_check` points at the same
 *   character the user's editor underlines.
 * - **`data` is the rendered message text**; `caption` is a heading that is
 *   empty for ordinary diagnostics.
 *
 * Lines that are not JSON are preserved as raw text, so a version change cannot
 * turn diagnostics into silence.
 * @param stdout - the process stdout.
 * @returns `{ diagnostics, raw }`.
 */
export function parseLeanJson(stdout) {
  const diagnostics = []
  const raw = []
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (!text.startsWith('{')) {
      raw.push(text)
      continue
    }
    let message
    try {
      message = JSON.parse(text)
    } catch {
      raw.push(text)
      continue
    }
    const caption = String(message.caption ?? '').trim()
    const body = String(message.data ?? '').trim()
    diagnostics.push({
      file: String(message.fileName ?? ''),
      // 0-based on the wire, 1-based everywhere else.
      line: (Number(message.pos?.line) || 0) + 1,
      column: (Number(message.pos?.column) || 0) + 1,
      severity: severityOf(message.severity),
      kind: kindName(message.kind),
      message: caption === '' || body.startsWith(caption) ? body : caption + ': ' + body,
    })
  }
  return { diagnostics, raw }
}

/** `path:line:col: severity CODE1234: message` — tsc and several linters. */
const COLON_DIAGNOSTIC = /^(?<file>[^:\n]+?):(?<line>\d+):(?<column>\d+)(?:\s*-\s*\d+:\d+)?\s*[-:]?\s*(?<severity>error|warning|info|hint)\s*(?<rest>.*)$/i

/** `path(line,col): severity CODE: message` — MSBuild and .NET analyzers. */
const PAREN_DIAGNOSTIC = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\)\s*:\s*(?<severity>error|warning|info)\s*(?<rest>.*)$/i

/** Python: `  File "x.py", line 12` followed by the offending source line. */
const PYTHON_FRAME = /^\s*File "(?<file>.+?)", line (?<line>\d+)/

/**
 * Parse `file:line:col: severity: message` output.
 * @param text - combined checker output.
 * @returns `{ diagnostics, raw }`.
 */
export function parseColonDiagnostics(text) {
  const diagnostics = []
  const raw = []
  for (const line of String(text ?? '').split('\n')) {
    const text2 = line.replace(/\r$/, '')
    if (text2.trim() === '') continue
    const match = COLON_DIAGNOSTIC.exec(text2.trim()) ?? PAREN_DIAGNOSTIC.exec(text2.trim())
    if (match?.groups === undefined) {
      raw.push(text2)
      continue
    }
    diagnostics.push({
      file: match.groups.file ?? '',
      line: Number(match.groups.line ?? 0) || 0,
      column: Number(match.groups.column ?? 0) || 0,
      severity: severityOf(match.groups.severity),
      kind: '',
      message: (match.groups.rest ?? '').trim(),
    })
  }
  return { diagnostics, raw }
}

/**
 * Parse a CPython traceback or compiler error.
 *
 * `python -m py_compile` reports `SyntaxError` as a traceback whose last useful
 * frame names the file and line, and whose final line names the fault. The
 * caret line that follows is dropped: it points at a column, and the message
 * line already carries the meaning.
 * @param text - combined stderr and stdout.
 * @returns `{ diagnostics, raw }`.
 */
export function parsePythonDiagnostics(text) {
  const diagnostics = []
  const raw = []
  const lines = String(text ?? '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '')
    if (line.trim() === '') continue
    const frame = PYTHON_FRAME.exec(line)
    if (frame?.groups === undefined) {
      raw.push(line)
      continue
    }
    // The fault text is the last non-empty, non-caret line before the next frame.
    let detail = ''
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor].replace(/\r$/, '')
      if (PYTHON_FRAME.test(candidate)) break
      if (candidate.trim() === '' || /^\s*\^+\s*$/.test(candidate)) continue
      detail = candidate.trim()
    }
    diagnostics.push({
      file: frame.groups.file ?? '',
      line: Number(frame.groups.line ?? 0) || 0,
      column: 0,
      severity: 'error',
      kind: 'SyntaxError',
      message: detail === '' ? 'syntax error' : detail,
    })
  }
  // A traceback's frames include library frames; the last one is the user's.
  if (diagnostics.length > 1) return { diagnostics: diagnostics.slice(-1), raw }
  return { diagnostics, raw }
}

/** First line of a message, for the one-line summary. */
export function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed
  }
  return ''
}

/**
 * Whether a diagnostic set shows a forbidden construct.
 *
 * `kinds` are matched case-insensitively against the checker's own message kind
 * and against the message text, because Lean's `hasSorry` tag is the reliable
 * signal when present and the rendered text is the fallback when a version stops
 * serializing the tag.
 * @param diagnostics - parsed diagnostics.
 * @param kinds - kind names or substrings that indicate a missing proof.
 * @returns the matching diagnostics.
 */
export function findForbidden(diagnostics, kinds) {
  const wanted = kinds.map((kind) => kind.toLowerCase())
  return diagnostics.filter((diagnostic) => {
    const kind = diagnostic.kind.toLowerCase()
    const message = diagnostic.message.toLowerCase()
    return wanted.some((needle) => (kind !== '' && kind.includes(needle)) || message.includes(needle))
  })
}

/**
 * Merge several diagnostic lists, de-duplicating identical rows.
 * @param lists - diagnostic arrays in priority order.
 * @returns one list, first occurrence wins.
 */
export function mergeDiagnostics(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists) {
    for (const diagnostic of list ?? []) {
      const key = [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.severity, diagnostic.message].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(diagnostic)
    }
  }
  return merged
}

/**
 * Remove the `sorry` diagnostics from a list.
 *
 * Used when the caller explicitly asked to draft with `allowSorry`: leaving the
 * promoted `hasSorry` error in place would make the verdict `rejected` and bury
 * the more useful answer, which is "this type-checks and nothing is proved".
 * @param diagnostics - parsed diagnostics.
 * @param kinds - kind names or substrings that identify the removed set.
 * @returns a new list without those diagnostics.
 */
export function dropForbidden(diagnostics, kinds) {
  const removed = new Set(findForbidden(diagnostics, kinds))
  return (diagnostics ?? []).filter((diagnostic) => !removed.has(diagnostic))
}

/** One diagnostic as a single line. */
export function formatDiagnostic(diagnostic) {
  const where = diagnostic.file === ''
    ? ''
    : diagnostic.file + (diagnostic.line > 0 ? ':' + diagnostic.line + (diagnostic.column > 0 ? ':' + diagnostic.column : '') : '') + ' '
  const kind = diagnostic.kind === '' ? '' : '[' + diagnostic.kind + '] '
  return where + diagnostic.severity.toUpperCase() + ' ' + kind + diagnostic.message
}
