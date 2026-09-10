/**
 * Configuration for the strict checker.
 *
 * @module @dsh-external/dsh-tool-strict-check/config
 */

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fully resolved, always-total configuration. */
export const DEFAULTS = Object.freeze({
  /** Explicit `lean` executable; empty means discover it. */
  leanPath: '',
  /** Explicit `lake` executable; empty means discover it. */
  lakePath: '',
  /** Explicit `elan` executable; empty means discover it. */
  elanPath: '',
  /** A Lake project to run specs in; empty means a managed scratch project. */
  projectDir: '',
  /** Scratch root for generated projects. */
  workDir: '',
  /** Per-checker wall clock. */
  timeoutMs: 120_000,
  /** Checker output kept per run, in characters. */
  maxOutputChars: 20_000,
  /** Register the model-facing `strict_check` tool. */
  exposeTool: true,
})

/** Read a positive integer, falling back to the default. */
function intOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/** Read a string, falling back to the default. */
function stringOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text === '' ? fallback : text
}

/** Read a boolean-ish value, falling back to the default. */
function boolOr(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === '1' || text === 'on') return true
  if (text === 'false' || text === 'no' || text === '0' || text === 'off') return false
  return fallback
}

/**
 * The scratch root when the profile names none.
 * @returns an absolute directory path.
 */
export function defaultWorkDir() {
  const home = process.env['DSH_HOME']
  if (typeof home === 'string' && home.trim() !== '') return join(home.trim(), 'strict-check')
  try {
    return join(homedir(), '.dsh', 'strict-check')
  } catch {
    return join(tmpdir(), 'dsh-strict-check')
  }
}

/**
 * Resolve raw profile config into a total configuration object.
 * @param raw - the `config:` block of the plugin row, or undefined.
 * @returns every field present and validated.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    leanPath: stringOr(source.leanPath, DEFAULTS.leanPath),
    lakePath: stringOr(source.lakePath, DEFAULTS.lakePath),
    elanPath: stringOr(source.elanPath, DEFAULTS.elanPath),
    projectDir: stringOr(source.projectDir, DEFAULTS.projectDir),
    workDir: stringOr(source.workDir, defaultWorkDir()),
    timeoutMs: intOr(source.timeoutMs, DEFAULTS.timeoutMs),
    maxOutputChars: intOr(source.maxOutputChars, DEFAULTS.maxOutputChars),
    exposeTool: boolOr(source.exposeTool, DEFAULTS.exposeTool),
  }
}
