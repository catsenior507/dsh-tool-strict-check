/**
 * dsh-tool-strict-check, host half.
 *
 * The user's complaint is a specific kind of fatigue: an agent that is
 * confidently wrong, repeatedly, in the same way. Re-reading its own diff does
 * not fix that — the model wrote the diff, so it agrees with it. What fixes it
 * is a check the model cannot talk its way out of.
 *
 * This plugin supplies that check, and it is deliberately built around two
 * awkward facts rather than around a feature list:
 *
 * 1. **A green check can be worthless.** `lean file.lean` exits 0 on a file
 *    full of `sorry`. `py_compile` exits 0 on a file that is syntactically
 *    valid and semantically nonsense. So the tiers here are wired to make the
 *    cheap passes *fail loudly*: Lean runs with warnings promoted to errors and
 *    `autoImplicit` off, and a missing checker reports `unavailable` instead of
 *    a pass. "I could not check" and "I checked and it is fine" never look the
 *    same coming out of this tool.
 * 2. **The checker itself is an attack surface.** The Lean kernel had eight
 *    soundness bugs in 2026, fixed in 4.33.1; below that version a proof of
 *    `False` is accepted. So the version is checked against a floor and printed
 *    with every result, and an older toolchain is a blocking finding rather than
 *    a footnote. A formal check whose checker is compromised is worse than no
 *    check, because it launders the error into confidence.
 *
 * Pieces:
 *
 * - runner.js   — executable discovery and bounded process execution
 * - parse.js    — checker output to normalized diagnostics
 * - static.js   — defects and policy violations decidable by reading
 * - language.js — the language's own compiler as tier 0
 * - lean.js     — the strict tier: flags, version floor, verdict
 * - tool.js     — the `strict_check` tool the agent drives
 *
 * @module @dsh-external/dsh-tool-strict-check
 */

import { resolveConfig } from './config.js'
import { registerTool } from './tool.js'
import { detectLean, formatVersion } from './lean.js'

/**
 * The policy-facing surface, published from the package entry point.
 *
 * `dsh-policy-strict-gate` enforces what this plugin only offers, and it has to
 * judge a specification by exactly the same rules — the same flags, the same
 * version floor, the same verdict vocabulary. Rather than let the gate re-derive
 * that and drift, those primitives are exported here. This is internal API, not
 * model-facing: changing it changes a policy's meaning, so treat it as a
 * contract. It has to live on the entry module because the package `exports` map
 * admits `.` and nothing else, so a re-export from a deeper file is unreachable.
 *
 * The checker *configuration* is resolved by the gate and passed per call, so
 * the gate's own `timeoutMs` governs. That is why the low-level functions take
 * an explicit config: the module-level default would silently win otherwise.
 */
export { checkLean, checkLanguage, checkBatch, leanArgs, MINIMUM_SAFE_VERSION } from './policy-surface.js'
export { languageOf, hasBlockingFinding } from './static.js'
export { resolveConfig as resolveCheckConfig } from './config.js'

/** Cordis plugin name. */
export const name = 'tool-strict-check'

/**
 * Registering `strict_check` is impossible without the tool registry, so
 * `tools` is the one declared dependency. The logger is read optionally and
 * only changes what is reported at mount, never whether a check works.
 */
export const inject = ['tools']

/** Log through whichever channel this profile actually has. */
function makeLogger(ctx) {
  const logger = ctx?.logger
  return {
    info(message) {
      if (typeof logger?.info === 'function') logger.info(message)
    },
    warn(message) {
      if (typeof logger?.warn === 'function') logger.warn(message)
    },
  }
}

/**
 * Mount the plugin.
 * @param ctx - the plugin cordis context.
 * @param config - optional `config:` block from the profile row.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const log = makeLogger(ctx)

  // Discovery is reported at mount so a broken toolchain is visible in the boot
  // log, where an operator looks, instead of only inside a tool call the agent
  // may never make.
  void detectLean(resolved)
    .then((detection) => {
      if (detection.lean.path === null) {
        log.warn(
          '[strict-check] 未找到 lean：Lean 相关的检查会返回 unavailable（不会假装通过）。安装：elan toolchain install leanprover/lean4:v4.33.1',
        )
        return
      }
      if (detection.shimRefusal) {
        log.warn(
          '[strict-check] 解析到的是 elan shim 且没有默认工具链；请运行 elan default leanprover/lean4:v4.33.1，或在配置里设置 leanPath。',
        )
        return
      }
      const version = formatVersion(detection.version)
      if (!detection.safe) {
        log.warn(
          '[strict-check] Lean ' +
            version +
            ' 低于安全下限 4.33.1：2026 年有 8 个内核/运行时可靠性缺陷（均可证明 False），4.33.1 才修复。' +
            'strict_check 会把该工具链上的“通过”标为不可信。',
        )
        return
      }
      log.info('[strict-check] Lean ' + version + ' 就绪（内核安全下限 4.33.1 已满足）：' + String(detection.lean.path))
    })
    .catch((error) => {
      log.warn('[strict-check] 探测 Lean 失败：' + String(error))
    })

  if (resolved.exposeTool === false) return
  let tools
  try {
    tools = ctx.tools
  } catch {
    tools = undefined
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    log.warn('[strict-check] tools 服务不可用，strict_check 工具未注册')
    return
  }
  try {
    const dispose = registerTool(tools, resolved)
    if (typeof ctx?.effect === 'function') ctx.effect(() => () => dispose(), 'tool-strict-check: strict_check tool')
    log.info('[strict-check] strict_check 工具已注册')
  } catch (error) {
    log.warn('[strict-check] 注册 strict_check 工具失败：' + String(error))
  }
}

// Deliberately NO default export: cordis resolves a module plugin as
// module.default ?? module, so a default export would hide the named `inject`
// above and every `ctx.tools` read would fail with "cannot get property tools
// without inject".
