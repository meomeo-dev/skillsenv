# Claude Code Plugin Marketplace 协议契约

## 权威与适用范围

Skillsenv 的市场协议（marketplace protocol）唯一采用 Claude Code Plugin
Marketplace。市场根目录必须包含：

```text
.claude-plugin/marketplace.json
```

本契约于 2026-08-02 对照 Claude Code `2.1.220`、官方文档与 SchemaStore
schema 核对。上游增加兼容字段时，Skillsenv 可以透传或忽略；不得用私有市场
清单替代 `marketplace.json`，也不得把 `catalog.yaml`、任意 `SKILL.md` 树或
Skillsenv 配置伪装成 Marketplace。

权威资料：

- <https://code.claude.com/docs/en/plugin-marketplaces>
- <https://code.claude.com/docs/en/plugins-reference>
- <https://json.schemastore.org/claude-code-marketplace.json>

三类依据的职责与优先级为：

1. Claude Code 官方文档定义公开协议语义。
2. 目标 Claude Code 版本的 `plugin` 命令和真实安装行为决定运行时兼容性。
3. SchemaStore 用于编辑器补全和静态检查；`$schema` 在 Claude 运行时被忽略。

三者短期漂移时，不把 SchemaStore 的缺项当作官方字段无效，也不把 CLI 暂时容忍的
未知字段写成稳定契约。记录差异，以官方文档和目标 CLI 的共同结果决定支持范围。
本次核对中，官方文档列出 `renames`、`displayName`、`relevance` 与
`defaultEnabled`，而 2026-04-23 生成的 SchemaStore 未完整列出；SchemaStore
另列出 `forceRemoveDeletedPlugins`。这些字段须保持漂移记录，不能互相推翻。

## Marketplace 清单

Marketplace 顶层必填字段为：

| 字段 | 契约 |
| --- | --- |
| `name` | 市场标识；用于 `plugin@marketplace` |
| `owner` | 维护者对象；其中 `owner.name` 必填 |
| `plugins` | Plugin 条目数组 |

标准可选字段包括 `$schema`、`description`、`version`、
`metadata.pluginRoot`、`allowCrossMarketplaceDependenciesOn` 与 `renames`。
`metadata.pluginRoot` 只改变相对 Plugin source 的解析基目录，不改变市场根目录。
Claude Code 新版本还可能增加迁移或删除策略字段；只有官方文档与目标 CLI 均确认后，
Skillsenv 才把它们纳入稳定输入契约。

每个 Plugin 条目至少包含：

| 字段 | 契约 |
| --- | --- |
| `name` | Plugin 标识；在一个 Marketplace 内唯一 |
| `source` | 标准 Plugin 来源字符串或对象 |

条目可使用 Plugin manifest 字段，并可增加 Marketplace 字段 `category`、
`tags`、`strict`、`relevance` 与 `defaultEnabled`。常见元数据包括
`displayName`、`description`、`version`、`author`、`homepage`、`repository`、
`license` 与 `keywords`；组件字段包括 `skills`、`commands`、`agents`、`hooks`、
`mcpServers`、`lspServers`、`monitors`、`settings`、`userConfig`、
`outputStyles`、`themes`、`channels` 与 `dependencies`。

Skillsenv 只接受可证明为 Skill-only 的 Plugin。发现 commands、agents、hooks、
MCP、LSP、monitors、依赖或其他非 Skill 组件时明确拒绝并报告组件名称，既不执行
也不静默丢弃。这是安全投影（skills-only projection），不是 Claude Plugin
运行时的完整兼容声明。

## 标准 Plugin 来源

Skillsenv 必须识别 Claude Code 定义的全部五类来源：

| 类型 | 形式与必填字段 |
| --- | --- |
| 相对路径 | `"./relative/path"` |
| GitHub | `{ "source": "github", "repo": "owner/repo" }` |
| Git URL | `{ "source": "url", "url": "https://...git" }` |
| Git 子目录 | `{ "source": "git-subdir", "url": "...", "path": "..." }` |
| npm | `{ "source": "npm", "package": "name" }` |

GitHub、Git URL 与 Git 子目录可带 `ref`、`sha`；两者同时存在时 `sha` 是有效
固定点（effective pin）。npm 可带 `version`、`registry`。Skillsenv 调用 npm
时必须禁用 lifecycle scripts。

市场来源（marketplace source）与 Plugin 来源（plugin source）是两个独立固定
点。前者描述如何取得 `.claude-plugin/marketplace.json`，支持本地目录、GitHub
shorthand、Git URL 和该 JSON 的远程 URL；后者只能取自 Plugin 条目的标准
`source`。登记市场不得重写 Plugin source。

Claude Code 标准相对 source 以 `./` 开头。Skillsenv 另接受 `.` 与 `./` 作为
“Marketplace 根目录即 Plugin 根目录”的显式别名；只有 `metadata.pluginRoot`
明确提供基目录时才接受其他不带 `./` 的相对路径。
`github`、`url` 与 `git-subdir` 的 `ref` 可以是分支或标签；`sha` 必须是完整的
40 位小写 commit SHA。两者同时存在时，`sha` 是实际固定点。Marketplace 自身的
添加来源与 Plugin source 不同，不应假定两者支持完全相同的固定字段。

## 路径边界

相对 Plugin source 先应用 `metadata.pluginRoot`，再相对 Marketplace 根目录
解析。词法路径逃逸、真实路径逃逸和符号链接逃逸均必须拒绝。Plugin manifest
声明的 Skill 路径也必须在 Plugin 根目录内；路径存在不代表越界路径可接受。

远程 URL 市场只取得单个 `marketplace.json`，没有可供解析的 Marketplace 文件
树，因此其中的相对 Plugin source 不可安装。Git 或本地目录市场可以使用相对
Plugin source。

Claude Code 安装时会把 Plugin 复制到版本化缓存。安装后的 Plugin 不能依赖其根
目录之外的 `../shared` 文件。发布者必须把 Skill 运行需要的全部文件放入 Plugin
source；路径存在、软链接可解析或本地仓库恰好有邻接文件，都不能放宽这个边界。

## Plugin 到 Skill 的投影

依赖安装单元沿用 Claude Code 标识：

```text
plugin-name@marketplace-name
```

Skill 发现遵循以下顺序与边界：

1. 发现标准 `skills/<name>/SKILL.md`。
2. Plugin 没有 `skills/` 且未声明 `skills` 时，可发现根级 `SKILL.md`。
3. 读取 Plugin manifest 或 Marketplace 条目的 `skills` 补充路径。
4. `strict: true` 为默认值，以 `.claude-plugin/plugin.json` 为组件权威，
   Marketplace 条目可以补充 Skill。
5. `strict: false` 时 Marketplace 条目是完整组件定义，不合并 `plugin.json`；
   Skill 仍按默认目录、条目声明路径与根级 fallback 发现。

在 Skillsenv 中，`strict: true` 要求 Plugin 自身存在
`.claude-plugin/plugin.json`，manifest 与 Marketplace 条目中的组件按 Claude
规则合并。`strict: false` 不要求 `plugin.json`；若 `plugin.json` 同时声明组件，
Skillsenv 将其视为冲突并拒绝，防止两个组件事实源产生含糊结果。

若 Plugin 没有 `skills/` 且未声明 `skills`，Claude Code `2.1.142+` 可以把
Plugin 根目录的单个 `SKILL.md` 作为 Skill。`my-skills` 当前每个条目直接指向
规范 Skill 目录并使用 `strict: false`，正是依赖此根级 fallback，不维护第二份
`skills/<name>/SKILL.md`。

`.skillsenv` 可对已发现结果增加 Skill 过滤器：

```yaml
schema_version: 1
dependencies:
  - plugin: quality-review-plugin@my-plugins
    agents: [claude-code, codex]
    skills: [quality-review]
```

`skills` 省略时投影该 Plugin 的全部有效 Skill。`skills` 与 `agents` 是
Skillsenv 项目/用户清单字段，不属于 Marketplace，不得写回
`marketplace.json`。

## 版本与锁定

Plugin 显示版本按 Claude Code 优先级解析：

1. `.claude-plugin/plugin.json` 的 `version`
2. Marketplace Plugin 条目的 `version`
3. Git commit SHA（Git 来源或 Git-hosted Marketplace 的相对 source）
4. npm 或非 Git 本地目录为 `unknown`

显式版本同时是 Claude Code 的缓存键。发布内容变化但版本不变时，用户可能继续
使用旧缓存；`plugin.json.version` 还会遮蔽 Marketplace 条目的版本。发布者必须
选择一个版本权威位置，并在每次运行内容变化时递增版本。

`.skillsenv.lock` 还必须记录 Marketplace revision、Plugin revision、标准化
source、所选 Agent、Skill 相对路径和 Skill 内容 SHA-256。锁文件摘要用于判断
信任是否仍有效，不取代上游版本字段。

远程、Git 与 npm Plugin 的 Skill 固定到 Skillsenv 内容缓存。本地 Marketplace
中的相对 Plugin source 则直接链接原始 Skill，并在锁中记录 `local_path` 与内容
摘要，以满足本地开发的即时反馈；这种链接天然可变，源文件变化会立即对 Agent
可见，并使后续 `activate` 的摘要校验失败，直到用户显式重新锁定并信任。

## 可见性与信任

最近父目录中的 `.skillsenv` 决定当前项目声明；不与更远父目录隐式合并。
项目同步只在该项目的 Agent 原生项目 Skill 目录增加托管链接，不能隐藏 Agent
已有的用户级、管理员级或系统级 Skill，因此 Skillsenv 不承诺严格沙箱隔离。

自动同步是显式启用的 shell hook。`skillsenv trust` 绑定项目根目录、清单摘要和
锁文件摘要。hook 只能同步已信任、已锁定且已缓存的依赖，不得下载、更新市场、
解析浮动 ref 或运行 npm。下载与重新锁定只能由显式用户命令触发。

Claude Code 的 Marketplace 声明 scope 与 Plugin 安装 scope 是两组独立状态。
`marketplace add --scope` 支持 `user`、`project`、`local`；`plugin install --scope`
也支持这三种作用域。local Plugin 只在指定项目启用，但 Claude Code 仍可能把已知
Marketplace、安装元数据和版本化缓存写入 `~/.claude/plugins`。因此 local 不等于
零用户目录副作用，验证报告必须分别记录启用范围和物理状态位置。

以上是 Claude Code 原生 scope。Skillsenv 自身只提供 `project` 和 `user` 两种环境
scope；本地 Marketplace 描述来源类型，不会新增第三种 Skillsenv scope。

## 验证门禁

Marketplace 发布者应运行官方校验：

```sh
claude plugin validate /path/to/marketplace --strict
```

Skillsenv 在读取时还要检查必填字段、名称唯一性、标准 source 形状、路径边界、
Plugin/Skill 唯一性和选择器有效性。官方校验通过不解除本地信任与链接冲突门禁。

## `my-skills` 发布同步契约

`my-skills` 使用本地目录 Marketplace，不发布为远程市场。仓库中的三类事实源各有
独立职责：

| 事实源 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| `catalog.yaml` | Skill 路径、版本、运行文件 SHA-256、发布历史 | Claude Marketplace 解析 |
| `.claude-plugin/marketplace.json` | Plugin 名、source、版本、描述和 strict 模式 | Skill 文件校验和与历史 release |
| Skill 规范目录 | `SKILL.md` 及运行资源的唯一可变副本 | 市场选择和安装作用域 |

必须保持以下映射：

- `plugins[].name` 等于 `catalog.yaml` 的 Skill `name`；
- `plugins[].source` 等于 `./${catalog.path}`；
- `plugins[].version` 等于 `catalog.current_version`；
- source 目录存在，根级 `SKILL.md` frontmatter `name` 与 Plugin 名一致；
- `strict: false` 条目不得从 `plugin.json` 引入第二套组件声明；
- Plugin source 内不得出现 Skillsenv 拒绝的非 Skill 组件。

根仓库的 `npm run validate` 已机械检查 Plugin 集合、source、version 和
`strict: false`。运行文件缓存边界、Claude 版本兼容和真实会话可见性仍须由 Claude
原生命令验证，不能由 catalog 校验替代。

新增、更新、移动或弃用 Skill 时，在同一变更中同步 catalog、README 和
Marketplace。仅修改市场描述、不改变安装内容时不升级 Skill 版本；Skill 任一运行
文件变化时，必须先按仓库 SemVer 规则升级 Skill，再同步 Marketplace 版本。

## Claude 协议更新流程

以下任一事件会触发协议复核：

- Claude Code 目标版本升级；
- 官方 Marketplace 或 Plugin reference 文档发生相关变化；
- SchemaStore 新增、删除或改变字段；
- `claude plugin validate --strict` 对现有市场产生新错误或警告；
- Skillsenv 遇到新的 source、strict、版本或组件形状；
- 真实安装、更新、缓存或 Skill 发现行为与本契约不一致。

复核流程：

1. 记录 Claude Code 版本、官方文档 URL、SchemaStore 获取日期和变更摘要。
2. 将官方字段与目标 CLI 行为分类为新增兼容、破坏性变化、文档澄清或未知漂移。
3. 先更新本契约和测试夹具，再修改 Skillsenv 解析器；未知字段不得静默获得执行
   语义。
4. 对新增非 Skill 组件保持默认拒绝，除非产品边界经明确变更。
5. 运行 Skillsenv 完整门禁与 Claude 原生严格校验。
6. 若发现、strict 或缓存语义变化，在隔离配置和临时项目中完成真实登记、安装、
   list 回读和 Skill 加载验证。
7. 记录已验证版本与仍存在的 SchemaStore 漂移，再发布 Skillsenv。

可复跑的静态与 CLI 探针：

```sh
claude --version
claude plugin validate /path/to/marketplace --strict
claude plugin marketplace add /path/to/marketplace --scope local
claude plugin install plugin-name@marketplace-name --scope local
claude plugin list --json

npm ci
npm run verify
```

`marketplace update` 只刷新市场来源；已经安装的 Plugin 仍应按目标 Claude Code
版本的 `plugin update plugin@marketplace --scope <scope>` 语义单独验证。测试结束后
应使用同一 scope 卸载 Plugin 和移除 Marketplace，或明确记录保留的 local 状态。

模型会话能实际调用 `Skill` 才能证明运行时发现与加载；manifest 校验、安装成功或
缓存文件存在都不能单独证明模型会话可见。只有发现规则或运行时集成变化时才需要
消耗模型额度，纯字段和解析器变化可由确定性门禁覆盖。
