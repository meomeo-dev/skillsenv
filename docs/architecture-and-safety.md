# 架构与安全不变式

## 领域模型

Skillsenv 分离四类对象：

| 对象 | 职责 | 事实源 |
| --- | --- | --- |
| Marketplace | 发布 Plugin 条目 | `.claude-plugin/marketplace.json` |
| Plugin | 封装一个或多个组件 | Marketplace entry 与 `plugin.json` |
| Skill projection | 可跨 Agent 投影的 Skill 子集 | Skill 发现结果与用户过滤器 |
| Environment | 把锁定 Skill 分配到 Agent 目录 | `.skillsenv` 与 `.skillsenv.lock` |

Marketplace 是上游发布协议；`.skillsenv` 是用户选择协议。二者字段不混用。

## 数据流

显式解析流程：

```text
marketplace registration
  -> marketplace.json validation
  -> plugin source materialization
  -> Skill-only component audit
  -> Skill discovery and filtering
  -> content-addressed cache or verified local path
  -> .skillsenv.lock
  -> complete link preflight
  -> managed state
```

自动激活流程只允许：

```text
nearest .skillsenv
  -> existing lock validation
  -> trust digest validation
  -> existing cache/local digest validation
  -> idempotent link synchronization
```

自动激活不得执行 Marketplace 更新、Git、HTTP、npm 或锁重新解析。

## 写入所有权

- Marketplace 注册、用户清单、信任和托管状态位于 `SKILLSENV_HOME`。
- 项目只写 `.skillsenv`、`.skillsenv.lock` 与 Agent 原生项目 Skill 目录。
- 正确的既有外部链接可以复用，但状态标记为非所有（not owned）。
- `clean` 与 stale-link 清理只删除 owned 且仍指向记录源的链接。
- 普通文件、目录、错误链接或非所有链接的变更默认拒绝。
- `--replace` 先把冲突项移到 Agent 扫描目录之外的备份目录。

同步先完成全部目标预检。清单与锁使用原子替换；链接执行失败时回滚本次链接、
stale-link 删除、备份移动和清单/锁变更。无法完成回滚时错误必须包含恢复失败路径。

## 来源固定

| 来源 | 固定方式 |
| --- | --- |
| Git Marketplace | 注册时的 commit SHA |
| 远程 JSON Marketplace | JSON SHA-256 |
| 本地 Marketplace | Git HEAD 或 manifest SHA-256 |
| Git Plugin | 有效 commit SHA，显式 `sha` 优先于 `ref` |
| npm Plugin | 请求 spec、实际 package version 与 Skill 内容摘要 |
| 本地相对 Plugin | 原始绝对路径与 Skill 内容摘要 |

远程 Skill 复制到内容寻址缓存。本地相对 Plugin 直接链接规范 Skill，以支持即时
开发；源内容改变会使锁摘要验证失败，必须重新锁定并信任。

## 路径不变式

- 相对 Marketplace、Plugin 和 Skill 路径在规范化前后都不得逃逸所属根目录。
- 真实路径和符号链接解析后仍必须位于所属根目录。
- 复制进缓存的 Skill 不接受绝对符号链接或指向 Skill 根外的符号链接。
- 锁中的 `cache_path` 必须位于 Skillsenv Plugin 缓存根内。
- 托管状态中的 destination 必须等于所列 Agent 与 Skill 名推导出的目标路径。

## Plugin 安全边界

Skillsenv 是 Skill-only projection，不是 Claude Code Plugin 执行器。以下 Plugin
组件会导致拒绝：

- commands 与 Plugin agents
- hooks 与 monitors
- MCP 与 LSP servers
- settings、userConfig 与 Plugin dependencies
- output styles、themes 与 channels

Skill 目录内部的附属资源会随 Skill 保留，例如 references、scripts、assets 或
Agent 特定的说明文件；它们属于 Skill 内容，不自动获得 Plugin 生命周期语义。

## 依赖边界

运行时仅直接依赖 `js-yaml`，用途限于 YAML 与 JavaScript 对象转换。Git、HTTP、
文件系统、散列和进程执行使用 Node.js 标准库。npm Plugin 获取同时传递
`--ignore-scripts` 与 `npm_config_ignore_scripts=true`，禁止 lifecycle scripts。

依赖版本精确锁定并提交 `package-lock.json`。升级必须通过自动化测试与
`npm audit --audit-level=moderate`；未使用依赖应立即移除。
