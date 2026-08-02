# Agent 工具与 Skill 目录上游同步契约

## 归属与事实源

Skillsenv 是独立实现的环境管理器，不是 `vercel-labs/skills` 的 fork，也不在运行时
导入其代码。以下配置数据来自公开上游
[`vercel-labs/skills`](https://github.com/vercel-labs/skills)：

- 支持的 Agent 工具标识；
- 各 Agent 的项目级 Skill 目录；
- 各 Agent 的用户级 Skill 目录；
- 影响目录解析的环境变量和特殊回退规则。

上游主事实源（primary source of truth）是固定提交中的 `src/agents.ts`；字段契约
来自 `src/types.ts`。Skillsenv 将经过审查的结果投影到
[`config/agent-paths.yaml`](../config/agent-paths.yaml)，后者是
Skillsenv 运行时使用的规范注册表（canonical registry）。

当前投影基线：

| 项目 | 固定值 |
| --- | --- |
| 上游仓库 | `https://github.com/vercel-labs/skills` |
| 上游文件 | `src/agents.ts` |
| 上游提交 | `1164afa5f0e21ebd01e6fc11249759353f494ad1` |
| 上游包版本 | `1.5.21` |
| 同版本 release commit | `7cb7db64dc1201052dea305e508a2fc490f7e5e2` |
| 上游 Agent 数 | `76` |
| 采集日期 | `2026-08-01` |
| 许可证 | MIT |

`config/agent-paths.yaml` 中的 `source` 和 `license_notice` 必须随投影一起维护，不能
只改目录条目。上游 MIT 许可不改变 Skillsenv 自身代码的归属。

## 权威文件范围

不能只看上游 README 或版本号。每次同步至少审查：

| 上游文件 | 需要判断的内容 |
| --- | --- |
| `src/agents.ts` | Agent ID、显示名、项目目录、用户目录、环境变量和特殊回退 |
| `src/types.ts` | `AgentConfig` 字段及可空语义 |
| `src/installer.ts` | 通用目录、规范副本、符号链接和实际写入目标 |
| `src/skills.ts` | 本地 Skill 发现目录 |
| `src/blob.ts` | 远程 Skill 发现目录优先级 |
| `scripts/sync-agents.ts` | README 与包关键词的生成规则 |
| `scripts/validate-agents.ts` | 上游实际执行的注册表门禁 |
| `.github/workflows/agents.yml` | 上游何时校验和重生成目录表 |
| `README.md` | 由注册表生成的人类可读目录矩阵 |
| `package.json` | 发布版本、工具名称和 Agent 关键词 |
| Agent 路径专项测试 | 环境变量、XDG、回退、项目专用和通用目录行为 |

README 的 Supported Agents 表适合交叉核对，不是独立事实源。上游安装器对
`.agents/skills` 通用目录还有规范副本和链接策略；“注册表声明某目录”也不保证
上游每次安装都会创建该专用目录。Skillsenv 只继承明确投影的数据，不继承
`vercel-labs/skills` 的安装策略。

特别是，上游对 `skillsDir === ".agents/skills"` 的 universal Agent 会直接使用
规范目录；非 universal Agent 通常先维护规范副本，再按检测结果创建专用链接，
Claude Code 另有显式处理。Skillsenv 则按自己的 `.skillsenv` 声明把每个目标目录
分组并创建托管链接。两套工具可能使用同一目录数据，但安装机制不是同一契约。

上游 `src/skills.ts` 与 `src/blob.ts` 还维护独立的发现目录表，不能从
`src/agents.ts` 自动推导。若这些表变化，应判断 Skillsenv 的 Marketplace Skill
发现是否受影响，而不是直接追加 Agent 目录。

## 投影规则

每个上游 Agent 条目按以下规则转换：

| 上游 | Skillsenv | 规则 |
| --- | --- | --- |
| 注册表键或 `name` | `agents.<id>` | 保持稳定 kebab-case ID |
| `displayName` | `display_name` | 保留面向用户的名称 |
| `skillsDir` | `project_dir` | 保持项目根目录下的相对路径 |
| `globalSkillsDir` | `user_dir` | 转成结构化根与相对路径 |
| `globalSkillsDir: undefined` | `user_dir: null` | 表示仅支持项目级安装 |

绝对用户目录不得直接写入配置。公共根使用 `roots` 表达：

- `XDG_CONFIG_HOME`，回退到 `~/.config`；
- `CLAUDE_CONFIG_DIR`，回退到 `~/.claude`；
- `CODEX_HOME`，回退到 `~/.codex`；
- `AUTOHAND_HOME`、`VIBE_HOME`、`HERMES_HOME`、`GROK_HOME`；
- OpenClaw 按 `.openclaw`、`.clawdbot`、`.moltbot` 的存在顺序选择。

Eve、PromptScript 等没有用户级目录的条目必须保持 `user_dir: null`。任何新增的
动态目录算法都应先扩展结构化 `roots` 和解析测试，不得把平台相关逻辑塞进路径
字符串。

下游扩展必须显式标注 `origin`，并从 `source.upstream_agent_count` 排除。当前
`codex-universal` 来自 OpenAI 官方通用目录说明，使用
`origin: openai-official`，且不参与 `--agent all`。`aliases`、`include_in_all` 等
Skillsenv 策略字段也不是上游事实，必须作为本地扩展单独审查。

## 拉取与差异审查

在独立 `skillsenv` 仓库根目录执行。使用临时 clone，不把上游添加为长期 remote：

```sh
npm ci

UPSTREAM_DIR=$(mktemp -d /tmp/skillsenv-vercel-skills.XXXXXX)
git clone https://github.com/vercel-labs/skills.git "$UPSTREAM_DIR"
git -C "$UPSTREAM_DIR" rev-parse HEAD
git -C "$UPSTREAM_DIR" show HEAD:package.json | rg '"version"'
```

从 `config/agent-paths.yaml` 读取当前固定提交，并比较全部权威文件：

```sh
CURRENT_SHA=$(node --input-type=module -e '
  import fs from "node:fs";
  import yaml from "js-yaml";
  const value = yaml.load(fs.readFileSync("config/agent-paths.yaml", "utf8"));
  process.stdout.write(value.source.commit);
')

git -C "$UPSTREAM_DIR" diff --stat "$CURRENT_SHA"..HEAD -- \
  src/agents.ts src/types.ts src/installer.ts src/skills.ts src/blob.ts \
  scripts/sync-agents.ts scripts/validate-agents.ts \
  .github/workflows/agents.yml README.md package.json tests

git -C "$UPSTREAM_DIR" diff "$CURRENT_SHA"..HEAD -- \
  src/agents.ts src/types.ts src/installer.ts src/skills.ts src/blob.ts
```

若浅 clone 不包含 `CURRENT_SHA`，先执行：

```sh
git -C "$UPSTREAM_DIR" fetch origin "$CURRENT_SHA"
```

生产固定点必须是完整 40 位 commit SHA。不要以可移动的 `main` 或单独的
`package.json.version` 作为固定点。上游 `main` 可能在新 release 前仍保留旧版本号。

## 是否需要更新

| 观察结果 | 决策 |
| --- | --- |
| 上游 HEAD 未变化 | 不更新 |
| HEAD 变化，但权威文件无相关差异 | 不更新注册表，记录复核结果 |
| 仅 README 生成内容变化 | 回查 `src/agents.ts` 和生成脚本，不机械复制 |
| Agent 新增、删除、重命名或目录变化 | 更新注册表、测试和版本 |
| 环境变量、回退或安装语义变化 | 更新解析机制、注册表和专项测试 |
| Skill 发现目录变化 | 审查 Marketplace 投影，按实际影响更新 |
| 上游只发布新 SemVer，目录事实未变 | 不因版本号单独更新 |
| 许可证或安全边界变化 | 暂停机械同步，先完成许可证与风险审查 |

当前基线 `1164afa...` 与 2026-08-02 查询到的上游 `main` HEAD 相同，注册表可加载
出 76 个上游 Agent，因此本次检查不需要更新目录数据。上游 `v1.5.21` 标签指向更早
的 commit `7cb7db6...`，而 `main` 的包版本仍为 `1.5.21`，这也证明版本字符串不足
以判断新旧。稳定渠道应同时记录 tag 与解引用 commit；跟踪前沿时应固定完整 SHA。

## 实施顺序

确认需要同步后按以下顺序执行：

1. 固定候选上游完整 SHA，保存相关文件差异。
2. 更新 `config/agent-paths.yaml` 的条目、`source.commit`、
   `source.package_version`、`captured_at` 和 `upstream_agent_count`。
3. 若解析语义变化，先更新 `roots` 与 `src/agent-paths.mjs`，再更新条目。
4. 为新增、删除、环境变量、XDG、项目专用、OpenClaw 回退和通用目录补测试。
5. 保留所有本地扩展的 `origin`；不得把扩展计入上游数量。
6. 运行完整门禁，并用 `skillsenv agents` 人工复核关键路径。
7. 按兼容性升级 Skillsenv：新增 Agent 通常为 MINOR，映射修正通常为 PATCH，
   删除 ID 或不兼容地改变默认目标通常为 MAJOR。
8. 在独立仓库提交、推送并发布，确保提交可从远端取得。
9. 回到父仓库，固定新发布提交并提交子模块指针。

父仓库不应使用浮动的 `git submodule update --remote` 直接决定发布版本。先在独立
仓库完成审查和发布，再显式固定：

```sh
git -C tools/skillsenv fetch origin --tags
git -C tools/skillsenv checkout <released-commit-sha>
git add tools/skillsenv README.md
```

## 验证门禁

在独立仓库运行：

```sh
npm ci
npm run verify
node bin/skillsenv.mjs agents
git diff --check
```

至少确认：

- 注册表加载成功，实际上游条目数等于 `source.upstream_agent_count`；
- Claude Code、Codex、Cursor、OpenCode 等代表性目录与固定上游一致；
- `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME` 覆盖生效；
- `user_dir: null` 不允许用户级安装；
- OpenClaw legacy 回退与本地扩展仍通过；
- 上游增加的安装策略没有被误写成 Skillsenv 的既有行为。

更新父仓库指针后，再运行父仓库的 catalog 校验、Marketplace 严格校验和
`git diff --check`。子模块提交在远端不可取得时，禁止提交父仓库指针。
