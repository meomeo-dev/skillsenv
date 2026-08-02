# Skillsenv

Skillsenv 是面向 Agent Skill 的声明式环境管理器（declarative environment
manager）。它以 Claude Code Plugin Marketplace 为唯一市场输入协议，从 Plugin
中只投影可证明安全的 Skill，并把选定 Skill 链接到 Claude Code、Codex、Cursor
等 Agent 的用户级或项目级目录。

## 能力边界

- 市场入口固定为 `.claude-plugin/marketplace.json`。
- 依赖标识固定为 `plugin-name@marketplace-name`。
- 支持 Claude Code 的相对路径、`github`、`url`、`git-subdir`、`npm` 五类
  Plugin source。
- `.skillsenv` 与 `.skillsenv.lock` 管理最近父目录的项目环境。
- 项目清单可声明 Marketplace 来源，不要求协作者预先登记同名市场。
- 核心依赖默认可见；命名依赖组可按测试、开发或其他用途选择。
- 可选 shell hook 只执行已信任、已锁定、已缓存的激活，不下载或升级。
- 支持 76 个公开 Agent 目标，并增加 OpenAI 官方 `~/.agents/skills` 兼容项。
- 冲突默认拒绝；`--replace` 会先创建可恢复备份。

Skillsenv 不是完整 Plugin 运行时。Plugin 含 commands、agents、hooks、MCP、LSP、
monitors、依赖或其他非 Skill 组件时，安装会明确拒绝。协议细节见
[`docs/claude-code-marketplace-protocol.md`](docs/claude-code-marketplace-protocol.md)。

## Agent 目录来源

Skillsenv 是独立实现，不是 `vercel-labs/skills` 的 fork。Agent 清单、项目级
Skill 目录和用户级 Skill 目录的配置数据来自公开上游
[`vercel-labs/skills`](https://github.com/vercel-labs/skills) 的 `src/agents.ts`，
经过固定提交审查后写入
[`config/agent-paths.yaml`](config/agent-paths.yaml)。运行时只读取这份固定注册表，
不下载或执行上游代码。拉取、差异判断、投影与发布流程见
[`docs/upstream-agent-paths-sync.md`](docs/upstream-agent-paths-sync.md)。

## 安装

要求 Node.js 18 或更高版本：

```sh
git clone https://github.com/meomeo-dev/skillsenv.git
cd skillsenv
npm ci
npm link
skillsenv --version
```

## 市场管理

市场来源可以是本地目录、GitHub `owner/repo`、Git URL 或远程
`marketplace.json`：

```sh
skillsenv marketplace add ./my-marketplace
skillsenv marketplace add owner/marketplace@stable
skillsenv marketplace add https://gitlab.example.com/team/marketplace.git#v1
skillsenv marketplace add https://example.com/marketplace.json

skillsenv marketplace list
skillsenv marketplace use marketplace-name
skillsenv marketplace update marketplace-name
skillsenv marketplace remove marketplace-name
```

切换默认市场只影响省略 `@marketplace` 的后续安装，不改写已有依赖。

用户登记的 Marketplace 保存在
`${SKILLSENV_HOME:-$HOME/.skillsenv}/config.yaml`，适合个人跨项目使用。项目需要
协作者共享的来源应声明在项目根目录 `.skillsenv` 中；同名项目声明优先于用户
登记。

## 项目环境

```sh
cd my-project
skillsenv init
skillsenv install quality-plugin@team-market \
  --agent claude,codex \
  --skill quality-review
skillsenv trust
skillsenv status
```

生成的清单为：

```yaml
schema_version: 1
marketplaces:
  team-market:
    source: ./plugin-marketplace
dependencies:
  - plugin: quality-plugin@team-market
    agents:
      - claude-code
      - codex
    skills:
      - quality-review
```

省略 `--skill` 时投影 Plugin 中发现的全部 Skill。项目发现采用最近父目录规则；
嵌套项目不会与更远父目录的清单隐式合并。

`marketplaces` 的来源支持本地相对目录、GitHub `owner/repo`、Git URL 或远程
`marketplace.json`。项目本地来源必须以 `./` 开头并位于项目根目录内；显式解析
时 Skillsenv 将解析出的 Skill 复制到用户缓存，lock 只记录相对来源和内容固定点。
由此，其他协作者取得同一项目目录后，不需要复用原作者的绝对路径或用户级市场
配置。

## 协作一致性

项目环境由共享声明、共享解析结果与个人激活状态共同组成：

| 位置 | 职责 | 是否提交 |
| --- | --- | --- |
| `.skillsenv` | Marketplace 来源、核心依赖、命名依赖组 | 是 |
| `.skillsenv.lock` | 全部声明的 Marketplace、Plugin 与 Skill 固定结果 | 是 |
| `${SKILLSENV_HOME}/state/` | 当前用户启用的依赖组与托管链接 | 否 |
| `${SKILLSENV_HOME}/config.yaml` | 当前用户跨项目复用的 Marketplace 登记 | 否 |

协作者提交 `.skillsenv`、`.skillsenv.lock` 和项目内本地 Marketplace 内容，即可
共享同一依赖全集。首次取得项目后，执行一次显式 `skillsenv sync` 建立本机缓存，
再执行 `skillsenv trust`。之后 `sync --frozen` 和自动 `activate` 只读取共享 lock
与本机缓存，不重新解析来源或联网。

Skillsenv 保证项目声明的 Skill 内容和目标一致，不接管 Agent 自己的用户级、
管理员级或系统级 Skill。每位协作者可以保留个人 Skill，因此“依赖一致”不等于
“进程只看得到这些 Skill”的严格隔离。

## 依赖组

`dependencies` 是始终启用的核心依赖（core dependencies）。
`dependency_groups` 是任意数量、任意合法名称的依赖组（dependency groups），用于
表达测试、开发、文档或其他按需环境；Skillsenv 不预设组名或固定组数。

```yaml
schema_version: 1
marketplaces:
  team-market:
    source: ./plugin-marketplace
dependencies:
  - plugin: core-plugin@team-market
    agents: [claude-code, codex]
dependency_groups:
  test:
    - plugin: test-plugin@team-market
      agents: [claude-code]
  development:
    - plugin: dev-plugin@team-market
      agents: [claude-code, codex]
```

默认只同步核心依赖；可选择一个、多个或全部组：

```sh
skillsenv sync
skillsenv sync --group test
skillsenv sync --group test --group development
skillsenv sync --all-groups
```

每次非冻结同步都会把核心依赖和所有组解析进同一个 `.skillsenv.lock`，但只链接
核心依赖与本次选择的组。选择保存在当前用户的本机状态中，不改写共享清单或 lock；
`activate` 会恢复最近一次成功同步的选择。未知组、重复 Plugin，以及同时使用
`--group` 与 `--all-groups` 都会快速失败。

这里不使用 npm `optionalDependencies` 术语，因为该字段表示依赖安装失败时仍可
继续；Skillsenv 的组内依赖仍是严格依赖，只是由用户显式选择是否启用该组。

显式同步命令：

```sh
skillsenv lock
skillsenv sync
skillsenv sync --frozen
skillsenv clean
skillsenv uninstall quality-plugin@team-market
```

`sync --frozen` 和 `activate` 只消费现有锁与缓存。`clean` 只删除 Skillsenv 自己
创建且仍指向记录源的链接；兼容的既有手工链接只复用，不接管所有权。

## 用户级安装

```sh
skillsenv install quality-plugin@team-market \
  --scope user \
  --agent claude,codex \
  --skill quality-review
```

用户级清单位于 `${SKILLSENV_HOME:-$HOME/.skillsenv}/user.yaml`。工具专用根目录
可通过绝对路径环境变量 `SKILLSENV_HOME` 覆盖。

## 自动激活

自动激活必须显式加入 shell 配置：

```sh
# zsh
eval "$(skillsenv shell-init zsh)"

# bash
eval "$(skillsenv shell-init bash)"

# fish
skillsenv shell-init fish | source
```

清单或锁文件摘要变化后，自动激活会拒绝运行，直到显式执行 `skillsenv lock` 或
`skillsenv sync`，检查变更，再执行 `skillsenv trust`。项目同步只增加 Agent
原生项目目录中的 Skill，不能隐藏 Agent 已有的用户级或系统级 Skill。

## 安全操作

```sh
skillsenv install plugin@market --agent claude --dry-run
skillsenv sync --dry-run
skillsenv sync --group test --dry-run
skillsenv sync --replace
skillsenv agents
```

`--dry-run` 完成解析和冲突预检但不写清单、锁、缓存或链接。`--replace` 的备份
保存在 Skillsenv 用户根目录的 `backups/links/`，不留在 Agent 的扫描目录中。

## 开发与发布门禁

```sh
npm ci
npm run verify
git diff --check
```

`npm run verify` 包含语法检查、自动化测试和生产依赖审计。依赖选择与退出条件见
[`config/dependencies.yaml`](config/dependencies.yaml)，架构与安全不变式见
[`docs/architecture-and-safety.md`](docs/architecture-and-safety.md)。

## 许可证

MIT
