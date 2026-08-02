# Claude Code Plugin Marketplace 协议契约

## 权威与适用范围

Skillsenv 的市场协议（marketplace protocol）唯一采用 Claude Code Plugin
Marketplace。市场根目录必须包含：

```text
.claude-plugin/marketplace.json
```

本契约于 2026-08-01 对照 Claude Code `2.1.220`、官方文档与 SchemaStore
schema 核对。上游增加兼容字段时，Skillsenv 可以透传或忽略；不得用私有市场
清单替代 `marketplace.json`，也不得把 `catalog.yaml`、任意 `SKILL.md` 树或
Skillsenv 配置伪装成 Marketplace。

权威资料：

- <https://code.claude.com/docs/en/plugin-marketplaces>
- <https://code.claude.com/docs/en/plugins-reference>
- <https://json.schemastore.org/claude-code-marketplace.json>

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

每个 Plugin 条目至少包含：

| 字段 | 契约 |
| --- | --- |
| `name` | Plugin 标识；在一个 Marketplace 内唯一 |
| `source` | 标准 Plugin 来源字符串或对象 |

条目可使用 Plugin manifest 字段，并可增加 Marketplace 字段 `category`、
`tags`、`strict` 与 `relevance`。Skillsenv 只接受可证明为 Skill-only 的
Plugin；发现 hooks、agents、MCP、LSP、commands、依赖或其他非 Skill 组件时
明确拒绝，并报告组件名称，既不执行也不静默丢弃。

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

## 路径边界

相对 Plugin source 先应用 `metadata.pluginRoot`，再相对 Marketplace 根目录
解析。词法路径逃逸、真实路径逃逸和符号链接逃逸均必须拒绝。Plugin manifest
声明的 Skill 路径也必须在 Plugin 根目录内；路径存在不代表越界路径可接受。

远程 URL 市场只取得单个 `marketplace.json`，没有可供解析的 Marketplace 文件
树，因此其中的相对 Plugin source 不可安装。Git 或本地目录市场可以使用相对
Plugin source。

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
5. `strict: false` 时 Marketplace 条目是完整组件定义，只发现条目明确声明的
   Skill 路径。

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
3. Git commit SHA
4. 非 Git 本地目录为 `unknown`

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

## 验证门禁

Marketplace 发布者应运行官方校验：

```sh
claude plugin validate /path/to/marketplace --strict
```

Skillsenv 在读取时还要检查必填字段、名称唯一性、标准 source 形状、路径边界、
Plugin/Skill 唯一性和选择器有效性。官方校验通过不解除本地信任与链接冲突门禁。
