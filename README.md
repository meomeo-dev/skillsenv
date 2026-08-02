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
- 可选 shell hook 只执行已信任、已锁定、已缓存的激活，不下载或升级。
- 支持 76 个公开 Agent 目标，并增加 OpenAI 官方 `~/.agents/skills` 兼容项。
- 冲突默认拒绝；`--replace` 会先创建可恢复备份。

Skillsenv 不是完整 Plugin 运行时。Plugin 含 commands、agents、hooks、MCP、LSP、
monitors、依赖或其他非 Skill 组件时，安装会明确拒绝。协议细节见
[`docs/claude-code-marketplace-protocol.md`](docs/claude-code-marketplace-protocol.md)。

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
