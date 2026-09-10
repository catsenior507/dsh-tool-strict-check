/**
 * Process execution for the strict checker.
 *
 * Every checker this plugin drives is an external program with its own idea of
 * where its toolchain lives, so two things matter more than speed here:
 *
 * 1. **A tool is found or it is not.** `resolveExecutable` probes the
 *    configured path, then PATH, then the elan toolchain directory, and reports
 *    which of the three answered. A missing checker is a reported status, never
 *    a silent pass — "I could not check" and "I checked and it is fine" must
 *    never look the same to the model.
 * 2. **A hung checker cannot hang the agent.** Lean can loop on a bad tactic,
 *    and a timeout that leaves the child running would leak an elaborator per
 *    call, so the timeout escalates to `SIGKILL` and the partial output is still
 *    returned.
 *
 * @module @dsh-external/dsh-tool-strict-check/runner
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Windows needs the extension spelled out; `spawn` will not add it. */
export const WINDOWS = process.platform === 'win32'

/** Extensions worth probing for a bare command name. */
const WINDOWS_EXTENSIONS = ['', '.exe', '.cmd', '.bat', '.ps1']

/**
 * Whether one path is an executable file.
 * @param path - candidate path.
 * @returns true when it exists and is a file.
 */
export function isExecutableFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Expand a bare command name against PATH.
 * @param command - bare name such as `lean`.
 * @param env - environment to read PATH from.
 * @returns the absolute path, or null.
 */
export function findOnPath(command, env = process.env) {
  const path = env['PATH'] ?? env['Path'] ?? ''
  const extensions = WINDOWS ? WINDOWS_EXTENSIONS : ['']
  for (const directory of path.split(delimiter)) {
    if (directory.trim() === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * The elan-managed toolchain directories, newest first.
 *
 * `elan` installs toolchains under `<ELAN_HOME>/toolchains/<name>/bin` and only
 * puts shims on PATH when the installer is allowed to edit it. This plugin
 * deliberately does not edit PATH — it reads the directory instead, so a
 * profile that never ran the installer still finds the compiler.
 * @param env - environment to read ELAN_HOME / USERPROFILE from.
 * @returns candidate bin directories that exist.
 */
export function elanBinDirs(env = process.env) {
  const home = env['ELAN_HOME']
  const roots = []
  if (typeof home === 'string' && home.trim() !== '') roots.push(home.trim())
  const profile = env['USERPROFILE'] ?? env['HOME']
  if (typeof profile === 'string' && profile.trim() !== '') roots.push(join(profile.trim(), '.elan'))

  const dirs = []
  for (const root of roots) {
    const bin = join(root, 'bin')
    if (existsSync(bin)) dirs.push(bin)
    const toolchains = join(root, 'toolchains')
    if (!existsSync(toolchains)) continue
    let names = []
    try {
      names = readdirSync(toolchains)
    } catch {
      continue
    }
    // Prefer a stable release over a release candidate, then the newest name.
    names.sort((a, b) => {
      const candidate = Number(a.includes('rc')) - Number(b.includes('rc'))
      if (candidate !== 0) return candidate
      return b.localeCompare(a, undefined, { numeric: true })
    })
    for (const name of names) {
      const candidate = join(toolchains, name, 'bin')
      if (existsSync(candidate)) dirs.push(candidate)
    }
  }
  return dirs
}

/**
 * Resolve one executable.
 *
 * Resolution order is explicit path, then PATH, then the elan toolchain
 * directories — a pinned `leanPath` in the profile must win over whatever
 * happens to be on PATH, because that is the only way a user can force a
 * specific toolchain.
 * @param command - bare name or absolute path.
 * @param options - `explicit` path from config, `env` for PATH/ELAN lookups.
 * @returns `{ path, source, tried }`; `path` is null when nothing was found.
 */
export function resolveExecutable(command, options = {}) {
  const env = options.env ?? process.env
  const tried = []
  const explicit = options.explicit
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const path = explicit.trim()
    tried.push(path)
    if (isExecutableFile(path)) return { path, source: 'config', tried }
  }
  if (isAbsolute(command)) {
    tried.push(command)
    if (isExecutableFile(command)) return { path: command, source: 'absolute', tried }
  }
  const onPath = findOnPath(command, env)
  tried.push('PATH')
  if (onPath !== null) return { path: onPath, source: 'PATH', tried }
  const extensions = WINDOWS ? WINDOWS_EXTENSIONS : ['']
  for (const directory of elanBinDirs(env)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (isExecutableFile(candidate)) return { path: candidate, source: 'elan', tried }
    }
    tried.push(directory)
  }
  return { path: null, source: null, tried }
}

/** Environment for every spawned checker. */
function childEnv(env, extra) {
  return { ...env, ...extra }
}

/**
 * Run one process to completion.
 *
 * Never rejects: a spawn failure, a non-zero exit, and a timeout all come back
 * as data, because every caller in this plugin has to report *something* about
 * a check and "the checker crashed" is a result worth showing.
 * @param command - executable path.
 * @param args - argument vector.
 * @param options - cwd, timeoutMs, env, envExtra, input, maxOutputChars.
 * @returns `{ code, signal, stdout, stderr, timedOut, spawnError, durationMs }`.
 */
export function runProcess(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000
  const maxOutputChars = Number.isFinite(options.maxOutputChars) ? options.maxOutputChars : 20_000
  const started = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: childEnv(options.env ?? process.env, options.envExtra),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: String(error),
        timedOut: false,
        spawnError: String(error),
        durationMs: Date.now() - started,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError = null
    let settled = false
    let killTimer = null

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      // A second, shorter grace kill covers a child that survived SIGKILL on
      // Windows only via a wrapper process.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, 2000)
    }, timeoutMs)

    const clip = (text) =>
      text.length > maxOutputChars
        ? text.slice(0, maxOutputChars) + '\n…[output truncated at ' + maxOutputChars + ' chars]'
        : text

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      resolve({
        code,
        signal: signal ?? null,
        stdout: clip(stdout),
        stderr: clip(stderr),
        timedOut,
        spawnError,
        durationMs: Date.now() - started,
      })
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      // A spawn failure on Windows emits `error` and may never emit `close`,
      // which would leave this promise pending forever — so the failure settles
      // the run itself. The status field stays null: no process ever ran, and a
      // fabricated exit code would be read as a real verdict by every caller.
      if (spawnError === null) spawnError = String(error)
      stderr += '\n' + String(error)
      finish(null, null)
    })
    child.on('close', (code, signal) => {
      finish(code, signal)
    })

    if (typeof options.input === 'string') {
      try {
        child.stdin?.end(options.input)
      } catch {
        // The child may have exited already; its close event still resolves.
      }
    } else {
      try {
        child.stdin?.end()
      } catch {
        // as above
      }
    }
  })
}

/**
 * Run a checker whose exit code is the verdict.
 * @param command - executable path.
 * @param args - argument vector.
 * @param options - as {@link runProcess}.
 * @returns `{ ok, ...run }` where `ok` is a clean exit.
 */
export async function runChecked(command, args, options = {}) {
  const result = await runProcess(command, args, options)
  return { ...result, ok: result.spawnError === null && !result.timedOut && result.code === 0 }
}
