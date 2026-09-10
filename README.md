<div align="center">

# Strict Check

**Stop re-reading your own diff. Make a compiler say it is wrong.**

A DeepSeek Harness host plugin that adds one tool, `strict_check`, which verifies
code and commands with real checkers instead of with another opinion.

[![License: MIT](https://img.shields.io/badge/license-MIT-3DA639.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-tool%20plugin-4D6BFE.svg)](#install)
[![version](https://img.shields.io/github/package-json/v/catsenior507/dsh-tool-strict-check?color=4D6BFE)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D20-3DA639.svg)](package.json)
[![stars](https://img.shields.io/github/stars/catsenior507/dsh-tool-strict-check?color=4D6BFE)](https://github.com/catsenior507/dsh-tool-strict-check/stargazers)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

## The problem

An agent that is confidently wrong does not fix itself by looking again. The model
wrote the change, so it agrees with the change. Reading the diff a second time
produces the same answer with more words.

The failures that actually cost turns are also the ones that are *mechanically
decidable*: a file that no longer parses, a shell construct the harness shell
cannot run, a `sorry` that makes a proof vacuous, a type error three files away.
None of those need judgement. They need a checker.

## What it does

One tool, four actions, cheapest first.

| Action | What it runs | What a pass means |
| --- | --- | --- |
| `status` | Probes every checker with `--version` | What can be checked on this machine, and what cannot |
| `lean` | `lean --json` with warnings promoted to errors | The Lean kernel accepted the proof |
| `batch` | `py_compile`, `node --check`, `tsc --noEmit`, the PowerShell parser | The language's own compiler accepted the files |
| `commands` | Static rules over shell text, never executed | No known harness-shell hazard matched |

### The Lean tier is the strict one

A Lean check is worth having only because it can say **no**. Two things make that
true here, and both are the opposite of the obvious implementation:

**A `sorry` must fail the check.** `lean file.lean` exits **0** on a file full of
`sorry`, because an unfinished proof is a *warning* in Lean. A checker that ran
Lean and read the exit code would report a vacuous theorem as verified. So the
exact run is:

```text
lean --json -DwarningAsError=true -DmaxErrors=0 -DautoImplicit=false -E hasSorry spec.lean
```

- `-E hasSorry` promotes only the missing-proof kind, so "no unfinished goals" is
  demanded without demanding "no warnings at all". The kind really is `hasSorry`,
  not `sorry`.
- `-DmaxErrors=0` removes the default cap of 100, past which Lean stops reporting
  and exits — which would hide every error after the hundredth.
- `-DautoImplicit=false` closes a footgun that is **on by default** in Lean: with
  it enabled, a misspelled hypothesis name silently becomes a fresh universally
  quantified variable, and the theorem states something weaker than it reads.

**The checker itself must be trustworthy.** In 2026, eight soundness bugs were
found in the Lean kernel and runtime; each was exploited to make the official
kernel accept a proof of `False`, and they were fixed in **4.33.1**. A proof
accepted by an older toolchain is not evidence of anything, so the version is
checked against that floor, is printed with every result, and an older toolchain
turns a pass into `unsafe-toolchain`.

### Everything is honest about not running

A verdict of `unavailable` means **no checker ran** and nothing was proved. It is
never returned as a pass. If `tsc` is missing, the result says so with the path it
looked for; if the resolved `lean` is the elan shim with no configured default
toolchain, the result says that too instead of reporting a compiler error.

<a id="install"></a>
## Install

The plugin is installed as a package into a dsh **profile**. `dsh plugin` forwards
to `pnpm` inside the profile directory, so any spec pnpm accepts works.

```bash
# from GitHub (the published form)
dsh plugin --profile web add github:catsenior507/dsh-tool-strict-check

# a local checkout, while developing
dsh plugin --profile web add /absolute/path/to/dsh-tool-strict-check
```

`web` is the shipped GUI profile; substitute `headless`, `sdk`, `acp`, or your own
profile name. On Windows, use forward slashes in a path.

Then **restart the host** and confirm with:

```
strict_check action=status
```

### Lean is optional, and here is how to add it

The other three tiers work without Lean. `status` reports Lean as `missing`, and
the `lean` action returns `unavailable` — never a pass.

```bash
# 1. elan, the Lean version manager
#    Windows (the installer writes to %USERPROFILE%\.elan):
Invoke-WebRequest https://elan.lean-lang.org/elan-init.ps1 -OutFile "$env:TEMP\elan-init.ps1"
& "$env:TEMP\elan-init.ps1" -NoPrompt 1 -DefaultToolchain none

# 2. the toolchain. 4.33.1 is the *minimum*, not a suggestion: see above.
& "$env:USERPROFILE\.elan\bin\elan.exe" toolchain install leanprover/lean4:v4.33.1
```

The plugin finds Lean without any configuration: it looks for a real compiler
under `<ELAN_HOME>/toolchains/*/bin` first and only then falls back to `PATH`. It
does this deliberately — the elan **shim** on `PATH` refuses to run until
`elan default` has been executed once, and that refusal is easy to misread as
"Lean is broken". To pin a specific toolchain, set `leanPath` in the plugin row.

> **Behind a proxy?** elan downloads through `curl`, which reads
> `~/.curlrc`. If the toolchain download stalls at 0 bytes while a browser works,
> write `proxy = "http://127.0.0.1:<port>"` into `%USERPROFILE%\.curlrc` and retry.

### What install does *not* do

- **No build step** — the published JavaScript is the source; no `prepare` script
  runs, no bundler is needed.
- **No dependencies** — `dependencies` and `peerDependencies` are empty. Cordis is
  provided by the host at runtime.
- **No mathlib** — see below for what that costs.

Node.js 20 or newer.

## What it does **not** do

Stated plainly, because a verification tool that oversells itself is worse than
none:

- **No mathlib.** Core `Init` and `Std` ship with the toolchain, so `import Std`
  and `by decide` work with no project, no network, and no ~10 GB download. What
  you lose is the tactic library: no `ring`, `norm_num`, `push_neg`, `field_simp`.
  Substitutes are `grind`, `decide`, `by_cases`, `simp`, `omega`.
- **No sandboxed re-check.** `lake check`, `comparator`, and `nanoda` need Linux
  namespaces (`bwrap`) and cannot run on Windows at all. `leanchecker` re-checks
  what the kernel already checked and does not catch `sorry`, so wrapping it would
  be cost without coverage. Lean 4.35 is expected to ship `lake check`; that is the
  right moment to adopt it, not now.
- **No statement-vs-intent check.** The kernel verifies that the proof proves the
  theorem. Whether the theorem is the one you meant is a specification question,
  and this tool will not pretend otherwise — which is exactly why the `commands`
  action prints "a clean scan is weak evidence" rather than "OK".

## Configure

`dsh plugin add` already inserted the plugin row. To change the defaults, edit
that row's `config` in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: tool-strict-check
      name: '@dsh-external/dsh-tool-strict-check'
      config:
        leanPath: '<ELAN_HOME>/toolchains/<toolchain>/bin/lean.exe'
        projectDir: '<path to a Lake project, if your specs import one>'
        timeoutMs: 120000
```

`leanPath` wins over discovery, which is what pins one toolchain.

## Development

```bash
npm test        # 61 tests; the Lean ones execute the real compiler
```

The Lean integration tests are skipped, not faked, when no safe toolchain exists.
Parsing tests replay **recorded `lean --json` output from Lean 4.33.1**, so they
fail if the wire format changes — including the detail that positions on the wire
are 0-based and are converted to 1-based.

| File | Role |
| --- | --- |
| `lib/runner.js` | Executable discovery, bounded process execution, spawn-failure handling |
| `lib/parse.js` | Checker output to normalized diagnostics |
| `lib/static.js` | Defects and policy violations decidable by reading |
| `lib/language.js` | Tier 0: the language's own compiler |
| `lib/lean.js` | The strict tier: flags, version floor, verdict |
| `lib/tool.js` | The `strict_check` tool |
| `lib/policy-surface.js` | The contract `dsh-policy-strict-gate` consumes |

## License

MIT
