# chord

**把编码 agent 当成一个集群来跑。**

<p align="center">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue"></a>
  <img alt="Node 24 or later" src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white">
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue">
  <a href="README.md"><img alt="English README" src="https://img.shields.io/badge/README-English-2F7CF6"></a>
  <a href="https://www.bilibili.com/video/BV1Cns96REZ2/"><img alt="B 站视频" src="https://img.shields.io/badge/%E8%A7%86%E9%A2%91-B%E7%AB%99-00A1D6?logo=bilibili&logoColor=white"></a>
</p>

一个仓库，想开几个 agent 就开几个。每个 agent 在自己的 worktree 里干活；一块共享的看板记着谁占着哪个文件；想改别人占着的文件，先问，等对方回话；活干完提交了，一个调用把分支 rebase 到 main 并快进。空闲的 agent 一有消息就被叫醒，所以 agent 之间自己协商，你只管用大白话继续派活。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/demo-dark.svg">
    <img alt="两个 agent 各在自己的终端里占用文件，通过消息商量一个共用文件，然后 finish 合进 main；chord ls 显示它们的状态" src="docs/demo-light.svg" width="100%">
  </picture>
</p>

## ✨ 特点

- 一个仓库、N 个 agent、每人一个 worktree：并行干活，互不踩脚
- 文件级的占用看板：改之前先登记，想改别人占着的文件先找占着的人说，没登记过的写入被 hook 挡回去
- agent 之间的异步消息：空闲的被叫醒，忙着的在下一次工具调用时听到
- `finish` 一步到位：rebase、快进 main、释放占用、通知其他人；遇到冲突什么都不动，让 agent 自己 rebase、解决、再 finish，解决不了才来问你
- 规则由 chord 自己教给 agent，启动时讲一遍，每条 prompt 再提醒一次；你只派任务，不用解释 chord
- 设计上不绑定某一家 agent：接一个新工具只是加一条启动配方，不用新写协调器
- `chord ls` 看全局，`messages` 和 `events` 回放发生过什么，`stop` 和 `clean` 收尾

## 📊 基准测试

在 [CooperBench](https://github.com/cooperbench/CooperBench) 上，两个 agent 在同一个仓库里各做一个功能，合并后的结果通过两个功能的测试才算这一对通过。

| chord 对比 | gpt-6.1-sol | gpt-6-luna |
|---|---|---|
| solo（一个 agent 做两个功能） | 76% vs 74% | 63% vs 51% |
| coop + git（消息加一个共享的 git 远端） | 76% vs 73% | 63% vs 47% |
| team（一个主管派活） | 76% vs 69% | **63% vs 34%** |
| coop（只有消息） | 76% vs 11% | 63% vs 11% |

在强模型上 chord 和最好的基线持平。在弱模型上它是唯一不掉到单 agent 以下的双 agent 方案，比 team 高 20 个点。chord 的 agent 只拿到功能描述，而 coop + git 和 team 的 prompt 里把怎么分工、怎么合并都写明了。

## 🤖 支持的 agent

| agent | 状态 |
|---|---|
| Claude Code | 支持 |
| Codex CLI | 支持 |
| OpenCode | 支持 |
| Gemini CLI | 计划中 |
| Cursor CLI | 计划中 |
| GitHub Copilot CLI | 计划中 |
| Qwen Code | 计划中 |
| DeepSeek Harness | 计划中 |

接一个新 agent 需要它的工具提供三样东西：启动时注入 hook 和 MCP server 的办法、hook 事件的名字和载荷、一个空闲/忙碌信号。

## 🧩 工作原理

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
    <img alt="你把任务交给一群 agent，每人一个 worktree；agent 共享一块占用和消息的看板，做完 finish 进 main" src="docs/architecture-light.svg" width="100%">
  </picture>
</p>

1. **隔离。** 每个 agent 在自己的分支、自己的 worktree 里干活。主 checkout 只通过 `finish` 变化。
2. **协调。** 一块共享看板存着占用、消息和事件。agent 用 chord 给的工具登记、占用、对话；hook 在每次写入前查占用，并在它干活时把新消息递过去。
3. **合并。** `finish` 把分支 rebase 到 main 再快进。rebase 干净、项目的 test 命令通过就合进去；遇到冲突什么都不动，agent 自己解决再 finish。

## 📦 安装

机器上有 Node 24 和 git：

```
npm install -g chord-cli
```

Linux 上加 `--allow-scripts=node-pty`，并装好 python3、make 和 g++：node-pty 不带 Linux 的二进制，安装时现场编译。macOS 不需要额外步骤：node-pty 自带 macOS 的二进制。

或者从源码：

```
git clone https://github.com/Cedr1cSun/chord-cli && cd chord-cli
npm install && npm link
```

## 🚀 快速开始

一个项目是一个文件夹，仓库放在它的子目录里：

```
my-project/
  my-repo/        主 checkout
  chord/          chord 自己的文件，在仓库之外
```

在项目文件夹里，一个终端开一个 agent：

```
chord claude                                     # 开一个 agent
chord codex --name api                           # 再开一个，起个名字
chord opencode --name web                        # 工具随便搭配
chord claude "fix the flaky test in tests/auth"  # 工具名后面的参数原样交给工具
```

在这些终端里像平时一样派任务。另开一个终端：

```
chord ls                 # agent、各自在做什么、未读消息、分支状态、文件占用
chord messages api       # 某个 agent 说过什么、收到过什么
chord events             # 占用、释放、合并、冲突
chord stop api           # 让它做完这一轮再退出
chord clean              # 删掉已经离开的 agent 的工作区和分支
```

`--name` 固定 agent 的名字、工作区和分支，以后用同一个名字启动就回到同一个 worktree。`chord resume <agent>` 也是这样，还会接着打开这个 agent 自己的对话，Claude、Codex 和 OpenCode 都一样。在仓库根目录里跑 chord，它会先提议把仓库移进一个子目录。

agent 在项目文件夹里启动，也就是你平时直接敲 `claude`、`codex` 或 `opencode` 的那个目录，所以那仍然是它们的项目：同一份 `/resume` 列表，同一个 CLAUDE.md，同一次信任确认。每个 agent 只改 `chord/agents/<名字>/` 下自己的 worktree；chord 拒绝对主 checkout 和其他 agent 的 worktree 的编辑（编辑器工具、apply_patch），shell 命令在那里跑过之后也会说一声。

## 🧰 命令

| 命令 | 作用 |
|---|---|
| `chord <agent> [--name x] [tool args...]` | 开一个 agent：`claude`、`codex` 或 `opencode` |
| `chord resume <agent> [tool args...]` | 把离开的 agent 再开起来，回到它的 worktree，接着它自己的对话 |
| `chord ls [--all]` | 本项目的 agent 和占用，或所有项目的 |
| `chord messages [agent] [-n N]` | 消息记录 |
| `chord events [agent] [-n N]` | 占用、释放、合并、冲突的记录 |
| `chord stop <agent>` | 等 agent 这一轮结束、输入框为空时退出它 |
| `chord clean [--force] [agent...]` | 删掉离线 agent 的工作区、worktree 和分支；还没到 main 上的工作留着，除非 `--force` |
| `chord --version` | 安装的版本 |

## ⚙️ 配置

`<项目>/chord/config.json`：

```json
{ "setup": "npm ci", "test": "npm test" }
```

`setup` 在每个新建的 worktree 里、agent 启动前跑一次，环境里带着 `CHORD_*` 变量，这样新 worktree 一来就装好了依赖。setup 失败则放弃这次启动并删掉 worktree。

`test` 设置了的话，每次 `finish` 把分支 rebase 到 main 之后、main 移动之前，在 agent 的 worktree 里跑一遍。失败就什么都不合，agent 拿到输出的末尾：rebase 干净也可能弄坏别人刚合进去的东西。它跑的时候其他 agent 的 `finish` 等着。

仓库自带的 Claude 配置（`.claude/settings*.json`、`.mcp.json`）在你自己在 Claude Code 里信任过这个仓库或项目文件夹之后才会到达 agent；你在那里批准过的 MCP server 才会启动。

## 🔌 chord 怎么和你的工具相处

- **叫醒 agent** 就是往它的终端里敲一句短话。chord 只在输入框为空、键盘安静了几秒、终端回显了这句话之后才这么做；对话框永远收不到那个回车。
- **信任**：agent 在项目文件夹里跑，所以 Claude 像平时敲 `claude` 一样只问一次；chord 不往 `~/.claude.json` 里写任何东西。Codex 会让你审核一次 chord 的 hook，hook 定义变了会再问一次；选 "trust all"。有 hook 被关掉时 chord 会在启动时告诉你。OpenCode 什么都不问：chord 通过 `OPENCODE_CONFIG_CONTENT` 把插件和 MCP server 交给它，所以你自己写在这个变量里的配置在 agent 运行期间不会被读取；全局配置、`OPENCODE_CONFIG_DIR` 和项目里的 `opencode.json` 照常生效。
- **分支和 worktree。** 每个 agent 添一个 `chord/<名字>` 分支和一个 worktree；`chord clean` 在 agent 离开后删掉它们，还没到 main 上的东西留着。
- **权限。** chord 自己的工具对 Claude 预先放行，所以独自干活的 agent 不会卡在它们的确认框上；你平时的 shell 和编辑审批照旧。Codex 沿用你自己配置里的沙箱和审批模式。Windows 上 chord 拒绝命令行里给出的沙箱，因为那个沙箱起不来 hook；Linux 和 macOS 上沙箱里 hook 照常运行，但 Codex 会让你逐个批准 chord 的工具调用。OpenCode 运行 chord 的工具不会询问，和其他 MCP 工具一样；其余工具沿用你自己的权限规则。
- **终端标题**是 `chord <agent> · <任务>`，每个窗口都说得出自己是谁。
- **hook 把关的是编辑器工具。** 从 shell 改的文件在每条命令之后按名字报出来，并附上该做的占用。

## 🗺️ 范围

- 在 Windows 11、macOS 和 Linux 上运行。
- 每个项目一个仓库。
- 项目路径最长约 190 个字符。
- 仓库里有 CRLF 文件和一条从未重新规范化过的 `* text` 属性时，每个 worktree 都会出现假改动；chord 会报出文件名和把仓库修好的命令。

## 🧪 测试

`npm test` 在临时文件夹里的真实 git 仓库上跑单元测试。协调本身用真实工具做过端到端验证，从两个 agent 商量一个文件到二十个 agent 合进同一个 main，还有 Python、Rust 和 JavaScript 的开源仓库。

## 📄 许可

[MIT](LICENSE)
