<div align="center">

# 严格检查 · Strict Check

**别再重读自己写的 diff 了。让编译器说它是错的。**

一个 DeepSeek Harness 宿主插件,只加一个工具 `strict_check` —— 用真正的检查器
去验证代码和命令,而不是再多一个观点。

[![License: MIT](https://img.shields.io/badge/license-MIT-3DA639.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-tool%20plugin-4D6BFE.svg)](#install)
[![version](https://img.shields.io/github/package-json/v/catsenior507/dsh-tool-strict-check?color=4D6BFE)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D20-3DA639.svg)](package.json)
[![stars](https://img.shields.io/github/stars/catsenior507/dsh-tool-strict-check?color=4D6BFE)](https://github.com/catsenior507/dsh-tool-strict-check/stargazers)

[English](README.md) · **简体中文**

</div>

---

## 要解决的问题

一个自信地犯错的 agent,不会因为"再看一眼"就改对。改动是它写的,所以它同意这个改动。
再读一遍 diff,只会得到同样的结论加上更多字。

而真正浪费回合的那些失败,恰恰是**机械上可判定**的:文件不再能解析、宿主 shell
根本跑不了的语法结构、一个让证明变成空话的 `sorry`、三个文件之外的类型错误。
这些都不需要判断力。它们需要一个检查器。

## 它做什么

一个工具,四个 action,由便宜到昂贵。

| action | 跑什么 | "通过"意味着什么 |
| --- | --- | --- |
| `status` | 用 `--version` 探测每个检查器 | 这台机器上能检查什么、不能检查什么 |
| `lean` | `lean --json`,并把警告提升为错误 | Lean 内核接受了这份证明 |
| `batch` | `py_compile`、`node --check`、`tsc --noEmit`、PowerShell 解析器 | 这门语言自己的编译器接受了这些文件 |
| `commands` | 对 shell 文本做静态规则检查,**从不执行** | 没有命中已知的宿主 shell 陷阱 |

### Lean 这一层才是「严格」的那层

Lean 检查之所以值得存在,唯一的理由就是它**能说不**。这里有两件事让这一点成立,
而它们都和"显而易见的实现"相反:

**`sorry` 必须让检查失败。** `lean file.lean` 对一个满是 `sorry` 的文件**退出码是 0**,
因为在 Lean 里"证明没写完"只是一条 *warning*。一个跑了 Lean 然后读退出码的检查器,
会把一个空定理报告成"已验证"。所以实际命令是:

```text
lean --json -DwarningAsError=true -DmaxErrors=0 -DautoImplicit=false -E hasSorry spec.lean
```

- `-E hasSorry` 只提升"证明缺失"这一类,于是既能要求"不许有未完成的目标",
  又不必要求"不许有任何警告"。这个 kind 确实叫 `hasSorry`,不是 `sorry`。
- `-DmaxErrors=0` 去掉默认的 100 条上限 —— 超过之后 Lean 会停止报告并退出,
  那会把第 100 条之后的错误全部藏起来。
- `-DautoImplicit=false` 关掉一个在 Lean 里**默认开启**的坑:开着它时,
  一个拼错的假设名会静默变成一个全新的全称量词变量,定理陈述的东西比它读起来更弱。

**检查器本身必须可信。** 2026 年 Lean 内核与运行时里被发现 8 个可靠性缺陷,
每一个都被用来让官方内核接受 `False` 的证明,它们在 **4.33.1** 里被修复。
一份被更旧工具链接受的证明不能作为任何证据,所以版本会对着这条下限检查、
并随每条结果一起打印;低于下限的工具链会把"通过"变成 `unsafe-toolchain`。

### 它对「没跑」这件事是诚实的

`unavailable` 这个结论意味着**没有任何检查器运行过**,什么都没有被证明。
它永远不会被当作"通过"返回。如果 `tsc` 不在,结果会说出来并附上它找过的路径;
如果解析到的 `lean` 是没配默认工具链的 elan shim,结果也会说出来,
而不是报一个编译器错误。

<a id="install"></a>
## 安装

本插件作为包安装进一个 dsh **profile**。`dsh plugin` 会在 profile 目录里转发给 `pnpm`,
所以 pnpm 接受的任何 spec 都可以用。

```bash
# 从 GitHub 安装（公开发布形式）
dsh plugin --profile web add github:catsenior507/dsh-tool-strict-check

# 本地检出安装（开发时用）
dsh plugin --profile web add /absolute/path/to/dsh-tool-strict-check
```

`web` 是自带 GUI 的 profile;可换成 `headless`、`sdk`、`acp` 或你自己的 profile 名。
Windows 上路径用正斜杠,或给路径加引号。

装完**重启宿主**,然后确认:

```
strict_check action=status
```

### Lean 是可选的,加装方式如下

另外三层不依赖 Lean。`status` 会把 Lean 报成 `missing`,`lean` action 返回
`unavailable` —— 永远不会是"通过"。

```bash
# 1. elan,Lean 的版本管理器
#    Windows（安装器写入 %USERPROFILE%\.elan）:
Invoke-WebRequest https://elan.lean-lang.org/elan-init.ps1 -OutFile "$env:TEMP\elan-init.ps1"
& "$env:TEMP\elan-init.ps1" -NoPrompt 1 -DefaultToolchain none

# 2. 工具链。4.33.1 是**下限**,不是建议值 —— 理由见上。
& "$env:USERPROFILE\.elan\bin\elan.exe" toolchain install leanprover/lean4:v4.33.1
```

插件不需要任何配置就能找到 Lean:它**先**去 `<ELAN_HOME>/toolchains/*/bin`
找真正的编译器,找不到才回退到 `PATH`。这是刻意的 —— `PATH` 上的 elan **shim**
在跑过一次 `elan default` 之前会拒绝运行,而那个拒绝很容易被误读成"Lean 坏了"。
要钉住某个特定工具链,在插件行里设置 `leanPath`。

> **走代理?** elan 通过 `curl` 下载,而 curl 会读 `~/.curlrc`。
> 如果工具链下载卡在 0 字节而浏览器正常,把
> `proxy = "http://127.0.0.1:<端口>"` 写进 `%USERPROFILE%\.curlrc` 再重试。

### 安装**不会**做的事

- **没有构建步骤** —— 发布的 JavaScript 就是源码;不会跑 `prepare` 脚本,不需要打包器。
- **没有依赖** —— `dependencies` 和 `peerDependencies` 都是空的。cordis 由宿主在运行时提供。
- **没有 mathlib** —— 代价见下。

需要 Node.js 20 或更新版本。

## 它**不**做什么

平实地说,因为一个自我吹嘘的验证工具比没有更糟:

- **没有 mathlib。** 核心 `Init` 和 `Std` 随工具链自带,所以 `import Std` 和 `by decide`
  不需要项目、不需要网络、不需要约 10 GB 下载就能用。你失去的是 tactic 库:
  没有 `ring`、`norm_num`、`push_neg`、`field_simp`。替代品是 `grind`、`decide`、
  `by_cases`、`simp`、`omega`。
- **没有沙箱级复核。** `lake check`、`comparator`、`nanoda` 需要 Linux 命名空间(`bwrap`),
  在 Windows 上完全跑不起来。`leanchecker` 复核的是内核已经检查过的东西,而且抓不到
  `sorry`,包一层只是成本没有覆盖。Lean 4.35 预计会自带 `lake check`;
  那才是接入的时机,不是现在。
- **不检查「陈述是否符合你的本意」。** 内核验证的是"这份证明证明了这条定理"。
  这条定理是不是你想要的,那是一个规格问题,这个工具不会假装自己能回答 ——
  这也正是 `commands` action 会打印"一次干净的扫描是弱证据"而不是"OK"的原因。

## 配置

`dsh plugin add` 已经替你插入了插件行。要改默认值,编辑 profile 的
`cordis.patch.yml` 里那一行的 `config`:

```yaml
- insert:
    - id: tool-strict-check
      name: '@dsh-external/dsh-tool-strict-check'
      config:
        leanPath: '<ELAN_HOME>/toolchains/<toolchain>/bin/lean.exe'
        projectDir: '<如果规格要 import 某个 Lake 项目,填该项目路径>'
        timeoutMs: 120000
```

`leanPath` 优先于自动发现 —— 这就是钉住某一个工具链的方式。

## 开发

```bash
npm test        # 61 个测试；Lean 相关的会真的执行编译器
```

没有安全工具链时,Lean 集成测试是**跳过**而不是伪造。解析测试回放的是
**从 Lean 4.33.1 录下来的 `lean --json` 真实输出**,所以线格式一变它们就会失败 ——
包括"线上位置是 0-based、会被转成 1-based"这个细节。

| 文件 | 职责 |
| --- | --- |
| `lib/runner.js` | 可执行文件发现、带超时的进程执行、spawn 失败处理 |
| `lib/parse.js` | 检查器输出 → 归一化诊断 |
| `lib/static.js` | 可读判定的缺陷与策略违规 |
| `lib/language.js` | 第 0 层:语言自己的编译器 |
| `lib/lean.js` | 严格层:flag、版本下限、结论 |
| `lib/tool.js` | `strict_check` 工具 |
| `lib/policy-surface.js` | `dsh-policy-strict-gate` 消费的契约 |

## 许可

MIT
