# CLI UX 约定

本文是 Skillsenv 命令行表层的长期规范。它规定命令与参数的取舍依据、帮助与输出
契约、退出码分类、兼容与弃用政策，以及新增命令前必须回答的问题。

代码侧的单一事实源是 [`src/cli-contract.mjs`](../src/cli-contract.mjs)：解析、帮助
渲染、别名、参数适用范围和测试矩阵全部由它派生。本文记录**为什么**，契约记录
**是什么**。两者冲突时以契约与测试为准，并同步修正本文。

## 参考层级

Skillsenv 的目标不是复制任何一个工具，而是让常见动作符合用户既有预期，同时保持
Marketplace、Agent、信任和链接的领域语义。

| 层级 | 采用内容 | 不采用内容 |
| --- | --- | --- |
| uv（主参考） | 声明/锁/环境三层分离，`add`/`remove`/`lock`/`sync`，命令级帮助，`--locked`、严格离线、结构化输出、退出码分类 | Python、虚拟环境、工具执行，以及 `--frozen` 的“跳过新鲜度检查”语义 |
| npm（词汇基线） | `install`/`remove` 的用户认知，`--` 边界，项目/用户配置优先级，稳定兼容别名的做法 | 历史错拼别名、生命周期脚本、`node_modules`、职责过载的 `install`、退出码模型 |
| Bun（辅助参考） | 简洁帮助，目录选择参数，quiet/verbose 的可发现性 | 自动安装、运行时快捷命令、Node 专属包树，以及“优先离线”替代严格离线 |

选择 uv 作主参考的理由是状态关系最接近：项目声明与锁是可提交事实，Agent 实际可见
性是可由锁收敛的环境。npm 与 Bun 以包树安装为中心，若作主参考会继续强化
`install` 同时承担“加声明、解析、写锁、落地”的含糊职责。

退出码不采 npm：实测 npm `--help` 退出 `1`，且官方文档只在 release-age 过滤场景
提到“非零退出”，没有通用退出码契约。uv 的三段式分类可直接使用。

## 状态模型

四个可独立观察的状态对象。每个命令必须能说清它读哪些、写哪些。

| 状态对象 | 位置 | 是否共享 |
| --- | --- | --- |
| 声明 | `.skillsenv` 或用户 `user.yaml` | 项目声明随仓库提交 |
| 锁 | `.skillsenv.lock` 或用户 `user.lock` | 项目锁随仓库提交 |
| 内容缓存 | `SKILLSENV_HOME/cache/` | 本机 |
| 环境 | Agent Skill 目录中的托管链接 + `SKILLSENV_HOME/state/` | 本机 |

三条状态轴分别由独立参数控制，不互相兼并：

- 锁是否可被改写 → `--locked`
- 是否允许网络 → `--offline`
- 是否收敛实际环境 → `--no-sync`

`--dry-run` 与三者正交：执行真实解析和完整预检，但不做任何持久写入。

网络轴对写命令和读命令的默认值相反：`add`、`sync` 等写命令默认允许出网，用
`--offline` 收紧；`marketplace show`、`info` 这类零写入的查看命令默认离线，用
`--online`放开。理由是浏览市场不应该因为某个 Plugin 声明了远程来源就隐式克隆。
契约用 `sideEffects.networkOptIn` 表达这一点，并禁止同时声明 `network: true`。

读命令在离线状态下遇到无法解析的 Plugin 时逐条降级：该 Plugin 附一条原因，其余
照常输出，命令仍以 `0` 退出。整条命令失败只保留给"目标本身不存在"这类错误。

## 命令决策

| 命令表面 | 决策 | 理由 |
| --- | --- | --- |
| `help [command...]` / `-h`/`--help` | 规范化 | 同一契约支持层级发现，不维护两套帮助正文 |
| `-V`/`--version` | 规范化 | 查询二进制版本；`version` 词形暂作兼容别名 |
| `init` | 保留并对齐 | 三个参考工具均有；当前初始化无交互，不增加 `--yes` |
| `add` / `remove` | 新规范命令 | uv 与 Bun 一致，npm 也把 `add`/`remove` 作为公开别名 |
| `install` / `uninstall` | 兼容别名 | 保护现有调用；不继承 npm 的职责过载与错拼别名集合 |
| `lock` / `sync` | 保留并以 uv 为主 | 与锁定产物和实际链接环境一一对应 |
| `marketplace add/list/show/use/update/remove` | 领域自定义 | Marketplace 是稳定领域对象，嵌套 CRUD 比泛化 `update` 清晰 |
| `marketplace show` / `info` | 领域自定义、参考读命令惯例 | `list` 回答"有哪些市场"，`show` 回答"市场提供什么"，`info` 聚焦单个 Plugin；与 `npm view`、`brew info` 的只读职责一致 |
| `activate` / `trust` / `untrust` | 领域自定义 | 表达自动激活前的缓存与信任安全边界，无主流等价物 |
| `status` / `clean` / `agents` / `shell-init` | 保留 | 均有现存领域对象；只有一个 Agent 查询动作时不增加浅层 `agent list` 组 |
| `run` / 泛化 `update` / `ci` | 不新增 | 没有脚本运行时、独立升级策略或新的 CI 状态机 |

## 参数决策

| 参数 | 决策 | 契约 |
| --- | --- | --- |
| `-h`/`--help`、`-V`/`--version` | 对齐主流 | 任意层级可发现，成功且无副作用 |
| `--directory <path>` | 采用 uv 词汇 | 统一执行目录与项目发现起点；`--root` 暂作别名，不再增加 `--cwd`/`--project` 同义项 |
| `-q`/`--quiet`、`-v`/`--verbose` | 对齐主流 | 只改变诊断详细度，不改变结果或错误可见性 |
| `--dry-run` | 保留并对齐 | 真实解析与预检，零持久写入 |
| `--locked`、`--offline`、`--no-sync` | 按 uv 状态轴拆分 | 分别控制锁写入/新鲜度、网络、实际环境写入 |
| `--frozen` | 兼容期自定义 | 保持“新鲜锁 + 仅缓存”安全语义，等价于 `--locked --offline` |
| `--output-format <text\|json>` | 对齐 uv 输出形式 | 仅用于有结构化结果或计划的命令，JSON 保持纯净 |
| `--scope`、`--agent`、`--skill` | 领域自定义 | 分别选择环境、Agent 目标和 Skill 投影 |
| `--skills` | 领域自定义 | 只在只读列举中把 Plugin 展开到 Skill 名单；与选择投影的 `--skill` 互斥，任一命令都不同时声明两者 |
| `--online` | 领域自定义 | 只读命令默认离线，显式放开出网才解析远程 Plugin 来源 |
| `--group`、`--all-groups` | 领域语义、主流词汇 | 与 uv 词汇一致，但值来自 `.skillsenv` 声明 |
| `--replace` | 领域自定义 | 只允许备份后替换冲突链接，不扩大为通用强制参数 |
| `-g`/`--global`、`--yes`、`--color`、`--no-progress` | 不新增 | 没有对应对象或行为时不暴露空参数 |

`--force` 永远不得成为跳过锁一致性、路径边界、信任或来源校验的通用逃生口。

## 严格参数真值表

`sync` 的状态轴组合。“网络”指是否允许出网，“写锁”指是否可能改写锁文件。

| 组合 | 锁缺失 | 锁与声明不一致 | 缓存命中 | 缓存缺失 | 网络 | 写锁 | 写环境 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 默认 | 解析后新建 | 重新解析并改写 | 复用 | 按来源补齐 | 允许 | 是 | 是 |
| `--locked` | 失败 | 失败 | 复用 | 按锁定来源补齐 | 允许 | 否 | 是 |
| `--offline` | 解析后新建 | 重新解析并改写 | 复用 | 失败 | 禁止 | 是 | 是 |
| `--locked --offline` | 失败 | 失败 | 复用 | 失败 | 禁止 | 否 | 是 |
| `--frozen` | 同 `--locked --offline` | 同上 | 同上 | 同上 | 禁止 | 否 | 是 |
| `--dry-run` | 解析但不写 | 解析但不写 | 复用 | 按来源取但不写缓存 | 允许 | 否 | 否 |

`--offline` 单独使用时仍会重新解析。远程 Git 或 npm Plugin 来源在离线下必然失败，
这是严格离线的正确结果，不降级为“优先离线”。本地 Marketplace 与已缓存的远程
Marketplace 可在离线下完成解析。

`--locked` 下补齐缓存时，按锁中记录的 `marketplace_revision`、`plugin_source`、
`plugin_revision` 重新物化，并断言重算出的 `cache_key` 与每个 Skill 的 `sha256`
都等于锁中记录值。任一不一致即失败，锁绝不被改写。

`add` / `remove` 的组合：

| 组合 | 声明 | 锁 | 环境 | 网络 |
| --- | --- | --- | --- | --- |
| 默认 | 写 | 写 | 写 | 允许 |
| `--no-sync` | 写 | 写 | 不写 | 允许 |
| `--dry-run` | 不写 | 不写 | 不写 | 允许 |
| `--offline` | 写 | 写 | 写 | 禁止 |

`--locked` 不适用于 `add` / `remove`：这两个命令必然改变声明摘要，从而必然使锁需要
更新，断言“锁不变”自相矛盾。该组合以用法错误退出 `2`。

`activate` 无条件只消费现有锁与缓存，且要求信任摘要匹配，因此不接受
`--locked`、`--offline` 或 `--no-sync`。

## 帮助契约

- `help`、`help <command>`、`help marketplace <leaf>` 与对应层级的 `-h`/`--help`
  输出相同内容。
- `--help` 在任意位置出现即立即渲染帮助，**不进入任何命令处理器**，因此不读写
  声明、锁、缓存、信任或链接状态。
- 帮助正文由命令契约生成。不允许存在与契约分离的硬编码帮助副本。
- 每个命令、别名和参数在契约中只有一个规范定义；重复定义由
  `assertContract()` 在测试中判为失败。

## 输出契约

| 通道 | 内容 |
| --- | --- |
| stdout | 命令的正常结果 |
| stderr | 诊断、警告、迁移提示、`--verbose` 细节、错误 |

- `-q`/`--quiet` 只压制诊断与提示，**不隐藏错误**。
- `-v`/`--verbose` 只增加诊断细节，不改变结果内容或退出码。
- `--output-format json` 时 stdout 只有一个可被标准解析器读取的 JSON 文档；
  进度、迁移提示和人类说明文本一律走 stderr，因此 JSON 不被污染。
- 只有契约中声明 `outputFormats` 的命令接受 `--output-format`；其余命令使用该参数
  以用法错误退出 `2`。
- JSON 字段名保持稳定。新增字段是兼容变更，重命名或删除字段是不兼容变更。

## 退出码契约

| 退出码 | 类别 |
| --- | --- |
| `0` | 成功，含帮助与版本查询 |
| `2` | 参数或用法错误：未知命令、未知参数、不适用参数、缺失值、重复值、互斥组合 |
| `1` | 运行或外部资源失败：解析、网络、校验、信任、链接冲突、文件系统 |

入口不得把三类结果压平为同一退出码。错误输出不含未请求的堆栈；堆栈仅在
`--verbose` 下打印。

## 兼容与弃用政策

兼容别名至少保留一个 MINOR 发布周期。移除只能进入后续不兼容版本，并且必须同时
具备替代命令、稳定迁移提示和测试证据。

| 兼容形式 | 规范形式 | 引入兼容期 |
| --- | --- | --- |
| `install` | `add` | 0.3.0 |
| `uninstall` | `remove` | 0.3.0 |
| `--root <path>` | `--directory <path>` | 0.3.0 |
| `--frozen` | `--locked --offline` | 0.3.0 |
| `version` | `--version` | 0.3.0 |

兼容形式必须与规范形式对相同输入产生**相同状态变更**，并向 stderr 输出稳定迁移
提示。提示不得写入 stdout，以免污染 JSON 输出。

## 上游复核触发条件

出现以下情况时重新核对参考工具的官方文档与目标版本帮助输出：

- 新增命令或参数，且主流工具存在同名或近义表面。
- 参考工具发布主版本，或改变锁、离线、输出格式的语义。
- 收到“与 uv/npm/Bun 行为不一致”的使用反馈。

复核只更新证据与决策记录，不得未经评估机械照搬。若上游语义与 Skillsenv 的安全
不变式冲突，保留自有语义并在本文记录冲突与理由，`--frozen` 即此类先例。

复核时同时记录探针版本，例如“npm 10.9.4、uv 0.11.28、Bun 1.2.19”。

## 新增命令检查表

新增命令或参数前必须回答：

1. 它读哪些状态对象，写哪些？写入是否原子、可回滚？
2. 是否幂等？连续执行两次结果是否相同？
3. 是否需要网络？在 `--offline` 下的行为是否是可行动错误而非静默降级？
4. 失败属于用法错误（`2`）还是运行失败（`1`）？
5. 是否有结构化结果？若有，JSON 字段是否稳定？
6. 主流工具是否有同名表面？语义是否一致？不一致时是否记录了理由？
7. 是否引入了与现有参数重复的同义词？
8. 契约、帮助、测试矩阵是否同时更新？

### 0.4.0 新增命令与扩展

以下决策以 issue #9「讨论」段的表格为据：

| 问题 | `marketplace show` | `info` | `status` 扩展 |
| --- | --- | --- | --- |
| 读哪些状态对象 | config + cache | lock + config + cache | state |
| 写哪些 | 无 | 无 | 无 |
| 幂等 | 是 | 是 | 是 |
| 需要网络 | 默认否，`--online` 放开 | 同左 | 否 |
| 失败分类 | 用法 `2` / 运行 `1` | 同左 | 运行 `1` |
| 结构化结果 | 是，JSON 字段稳定 | 是 | 已有，新增 `managed_entries` |
| 主流同名表面 | npm show / brew info | npm info | npm ls / uv pip list |
| 新同义词 | 否 | 否 | 否 |

**`--online` 而非 `--offline` 翻转**

写命令（`add`/`sync`）默认出网，用 `--offline` 禁止——这是 uv 语义。读命令零副
作用，但远程 Plugin 来源（`github`/`git-subdir`/`npm`）需要 git clone 或 npm
install，这不是零副作用。因此读命令翻转极性：默认守住，显式 `--online` 放开。
uv 自身的 `pip list` / `pip show` 不联网（它只读本地 `site-packages`），但
`pip index versions` 联网且不接受 `--offline`——因为它的唯一数据源是远程的。
skillsenv 的数据源是*可能*本地*也可能*远程的，所以需要一个中间策略：能回答就回答
（本地源），回答不了就告诉你为什么而不是失败或偷偷出网。`--online` 让那些远程源
也可回答。

**`--skills` 与 `--skill` 的关系**

`--skill <name[,name...]>`（`add`/`remove` 上的投影过滤）与 `--skills`
（`marketplace show` 上的展开布尔）拼写相近但语义正交。契约用显式 `field` 区分
（`skills` vs `expand_skills`），且任一命令都不同时声明两者，类型二义不可能发生。
若用户误用 `--skill` 在 `show` 上（或反过来），退出 `2` 并指向正确帮助。

## 回归清单

- 根命令、每个一级命令、`marketplace` 组、每个 Marketplace 叶子命令的 `--help`
  均退出 `0` 且零副作用。
- 契约遍历生成的帮助覆盖矩阵与实际解析结果一致，无重复定义。
- `add`/`install` 与 `remove`/`uninstall` 对相同输入产生相同状态变更，兼容形式输出
  迁移提示且不污染 JSON stdout。
- 参数位于命令前后、`--` 边界、未知参数、不适用参数、缺失值、重复值、互斥组合、
  Marketplace 嵌套命令均有覆盖。
- `--locked`、`--offline`、`--frozen`、`--no-sync` 的真值表覆盖锁缺失、锁过期、
  缓存命中、缓存缺失和环境漂移，并断言网络访问与每个状态文件的写入结果。
- `--dry-run` 在新旧命令和各输出格式下均无持久变更；连续两次 `sync` 幂等。
- text/JSON、quiet/verbose、stdout/stderr、退出码均有端到端测试；JSON 可被标准
  解析器读取，错误输出不含未请求的堆栈。

## 官方依据

- npm CLI 命令与词汇：<https://docs.npmjs.com/cli/v11/commands/npm>
- npm 安装、删除与 CI：<https://docs.npmjs.com/cli/v11/commands/npm-install>、
  <https://docs.npmjs.com/cli/v11/commands/npm-uninstall>、
  <https://docs.npmjs.com/cli/v11/commands/npm-ci>
- npm 配置、离线、颜色与日志：<https://docs.npmjs.com/cli/v11/using-npm/config>
- uv CLI 参考：<https://docs.astral.sh/uv/reference/cli/>
- uv 锁与同步语义：<https://docs.astral.sh/uv/concepts/projects/sync/>
- uv 依赖与工具边界：
  <https://docs.astral.sh/uv/concepts/projects/dependencies/>、
  <https://docs.astral.sh/uv/concepts/tools/>
- Bun add/install 与锁：<https://bun.com/docs/pm/cli/add>、
  <https://bun.com/docs/pm/cli/install>、<https://bun.com/docs/pm/lockfile>
- Bun 初始化与运行时边界：<https://bun.com/docs/runtime/templating/init>、
  <https://bun.com/docs/runtime>
