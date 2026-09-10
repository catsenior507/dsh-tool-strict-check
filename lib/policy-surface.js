/**
 * The policy-facing surface, in one file.
 *
 * Two plugins now depend on this contract: `strict_check` offers the checks, and
 * `dsh-policy-strict-gate` enforces them. They must judge a specification by
 * exactly the same rules — the same flags, the same version floor, the same
 * verdict vocabulary — or a spec the model was told is accepted would be treated
 * as unverified by the gate.
 *
 * Keeping the exports in one module makes that contract reviewable in one place
 * instead of scattered across the entry point. It exists because a package
 * `exports` map admits only `.`, so a re-export from a deeper file is
 * unreachable from another plugin.
 *
 * @module @dsh-external/dsh-tool-strict-check/policy-surface
 */

export { checkLean, leanArgs, MINIMUM_SAFE_VERSION, detectLean, formatVersion as formatLeanVersion, parseLeanVersion, compareVersions } from './lean.js'
export { checkLanguage, checkBatch, checkerFor, hasChecker } from './language.js'
