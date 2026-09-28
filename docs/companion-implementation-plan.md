# 凡小忆情感陪伴能力实施计划

## 结论

`D:\code\emotion-companionship` 的优化可以迁移到 EveryMemorior，并可成为普通 Tenant Member 的默认聊天体验；但不能把它当成一份 Skill、一个全局 system prompt，或把原项目整套服务直接嵌入。

迁移策略是：保留 EveryMemorior 的租户身份、角色、SQLite、Pi JSONL、AgentSession 和 SSE；迁移经过验证的行为规则、生成参数、风险检查、分层复核、热上下文、记忆规则和自动评测方法；用一个深的 Companion Runtime 在服务端统一编排。

## 迁移边界

| 来源能力 | 处理方式 | 原因 |
| --- | --- | --- |
| `.pi/SYSTEM.md` 的陪伴规则 | 拆为平台锁定底线和可版本化行为文档 | 管理员可以调风格，但不能关闭身份、安全和关系边界 |
| `.pi/agent.json` 的模型与生成参数 | 作为首个 Companion Config Version 的默认值导入 | 每位参与者必须固定版本，不能跟随全局设置漂移 |
| `output-control.ts` 的确定性检查、风险分类、review/repair | 迁移算法并改为普通轮流式、高风险轮缓冲 | 原项目全量缓冲不满足本平台流式体验目标 |
| `hot-context.ts`、片段摘要和记忆提取 | 第二阶段迁移，改用 SQLite 与 Pi JSONL | 保留方法，不复制 PostgreSQL 数据访问实现 |
| 500 题题库、grader、episode 评分和快照 | 迁移为管理员专用 Evals | 已有评测资产比重新建一套固定回归集更成熟 |
| Agent 版本 diff、发布门禁和改进建议 | 合并进现有 Tenant Settings | 不建立第二套管理员账号和后台应用 |
| PostgreSQL 消息、用户和后台任务表 | 不迁移 | 平台已有身份、SQLite 和 Pi JSONL；复制会形成双重事实源 |
| 独立聊天页面和独立登录系统 | 不迁移 | 普通成员登录后直接进入新的 Companion Shell |
| “没有联网能力”的旧提示 | 替换 | 新平台明确允许受限的实时信息查询 |

## 目标模块与 seam

外部 seam 放在 `lib/companion-runtime.ts`。API 路由只负责鉴权、解析请求和传递事件，不再分别理解配置版本、上下文、风险、流式策略、搜索、复核或后台更新。

建议保持一个小的运行时 interface：

```ts
runCompanionTurn({ auth, clientMessageId, text, signal }, emit): Promise<CompanionTurnResult>
```

这个 interface 隐藏以下 implementation：

1. 解析成员唯一的陪伴关系和固定配置版本。
2. 1–1.5 秒短消息归并及幂等去重。
3. 组装锁定底线、行为文档、当前时间和过滤后的上下文。
4. 选择普通流式或高风险缓冲路径。
5. 仅在需要近期事实时开放受限 `web_search`。
6. 执行确定性检查、选择性模型复核和必要修复。
7. 记录时延、分类、复核和未完成状态。
8. 提交片段摘要、记忆和画像后台工作。

不新增“模型工厂”“策略插件系统”或只有一个实现的 port。运行时直接复用现有 `startRpcSession()`、`AgentSessionWrapper.onEvent()`、TenantStore 和 SessionManager；测试从同一个 `runCompanionTurn` seam 观察事件和结果。

## 文件落点

### 新增

| 文件 | 职责 |
| --- | --- |
| `lib/companion-runtime.ts` | 深模块：回合编排、上下文准备、流式/缓冲、风险和失败处理 |
| `lib/companion-policy.ts` | 锁定底线、行为文档合并、确定性检查；如果首版足够短，可并入 runtime |
| `lib/companion-evaluations.ts` | 题库选择、生成、评分、快照和改进建议；只供管理员路径调用 |
| `hooks/useCompanionConversation.ts` | Companion 专用 SSE/发送/重试/中断状态，不把工作台状态暴露给成员 |
| `components/CompanionShell.tsx` | 老年友好单关系聊天外壳；首版可把 composer 放在同一文件 |
| `components/CompanionSettings.tsx` | 第二阶段的记忆、画像、显示和隐私控制 |
| `components/CompanionConfig.tsx` | Owner/Admin 的草稿、diff、评测、发布、分配与迁移界面 |
| `app/api/companion/route.ts` | 获取关系/消息与提交消息 |
| `app/api/companion/events/route.ts` | 当前陪伴关系的 SSE |
| `app/api/companion/profile/route.ts` | 第二阶段的画像、记忆同意和重置 |
| `app/api/tenant/companion/route.ts` | 管理员配置、发布、分配和迁移 |
| `app/api/tenant/companion/evaluations/route.ts` | 管理员启动和查看 Evals |

### 修改

| 文件 | 修改 |
| --- | --- |
| `lib/tenant-store.ts` | 增加 SQLite migration 和按 tenant/membership 限定的高层存取方法 |
| `lib/rpc-manager.ts` | 允许 Companion Runtime 提供精确 prompt 和过滤后的异步模型上下文；不改变普通 Agent 行为 |
| `components/AppShell.tsx` | Member 默认渲染 Companion Shell；Owner/Admin/安装管理员保持现有工作台 |
| `components/TenantSettings.tsx` | Owner/Admin 增加“陪伴配置”入口，不创建独立管理应用 |
| `lib/settings-navigation.ts` | 增加管理员可见的 companion section |
| `app/globals.css` 与 i18n 消息 | 大字号、高对比、44px 以上点击目标、中文状态与错误文案 |
| `app/api/sessions/*` | 对 Companion Shell 隐藏内部候选、修复消息和未授权会话；普通工作台路径不变 |

上述文件名是实施时的默认落点。若 `companion-policy.ts` 不足以形成真正深的模块，就并回 `companion-runtime.ts`，不保留浅包装。

## SQLite 数据模型

所有表必须以 `tenant_id` 参与查询和外键约束；浏览器请求只能从已验证的 AuthenticatedTenantSession 获得 tenant 和 membership，禁止接受请求体中的 tenantId 作为权限依据。

### 第一阶段

- `companion_config_versions`：不可变发布版本；包含行为 Markdown、provider/model、对话/review/repair 参数、内容哈希、状态、创建与发布时间。
- `companion_assignments`：一个 membership 对应一个持续的 Pi session 和一个固定 config version；迁移时记录前后版本与操作者。
- `companion_turns`：以 `(membership_id, client_message_id)` 唯一保证幂等；记录 Pi 条目关联、状态、分类、是否缓冲、复核结论、失败类型、首字/完成时延和配置版本。
- `companion_risk_events`：仅保存处理所需的最少分类、关联 turn 和处理结果，不保存额外推断画像。
- `companion_evaluation_runs`、`companion_evaluation_items`：保存完整评测快照、评分、致命问题、人工校准和建议。

### 第二阶段

- `companion_consents`：长期记忆和有限人工抽检的知情同意、撤回及时间。
- `companion_memories`：候选/待确认/已确认/删除状态、敏感度、来源 Pi entry、内容哈希和使用时间。
- `companion_profile_fields`：只允许白名单字段；保存值、显式/推断来源、置信度和更新时间。
- `companion_profile_evidence`：只引用用户原始消息；来源删除时同步删除或重算。
- `companion_fragments`：内部对话片段边界和摘要；不在成员 UI 暴露成多个会话。
- `companion_background_jobs`：SQLite 队列，使用状态、available_at 和 lease；不引入 Redis 或独立任务系统。

Pi JSONL 继续保存原始对话和运行记录。SQLite 只保存领域状态和索引，不复制一份正式 transcript。90 天清理通过 SessionManager/安全重写 JSONL 完成，并在同一事务性流程中清理派生资料；先备份到临时文件、原子替换，失败时保留原文件。

## 回合处理流程

```text
成员发送消息
  → tenant 鉴权 + assignment/config 固定解析
  → clientMessageId 幂等检查
  → 1–1.5 秒归并
  → 输入预检查：结束/纠正/风险/专业/敏感/实时事实
  → 构建过滤后的模型上下文
      ├─ 普通轮：直接流式 → 流中确定性检查 → 完成记录
      └─ 风险轮：缓冲生成 → 确定性检查 → 模型 review/repair → 一次性展示
  → JSONL 保留运行记录，SQLite 标记哪些输出可见且可进入后续上下文
  → 异步提交摘要/记忆/画像任务
```

Companion 的上下文提供器必须替换模型看到的 message 列表，而不只是替换 system prompt。这样被拦截候选、repair 指令、未完成输出和超过保留期的原文即使仍暂存在 JSONL，也不会重新进入模型上下文。

### 流式与失败

- 普通轮在预检查后立即流式；2 秒仍无正文时显示“正在想一想”。
- 风险、医疗/法律/财务建议、敏感记忆和异常输出缓冲，完成 review 后显示。
- 用户发出停止、纠正或结束信号时中断当前生成；普通补充消息排入下一轮。
- 连接或模型失败时保留已显示文字并标记“未完成”，同时从未来上下文排除。
- 相同 `clientMessageId` 的重试返回既有结果或继续既有任务，不创建第二个正式回复。
- 搜索失败时回复“暂时无法核实”，不以模型常识伪装实时结果。
- 高风险路径失败时显示固定现实求助指引，并明确不会自动联系、定位、报警或救援。

## 实时信息查询

第一阶段只启用一个受控 `web_search` 能力：

- 仅由“用户明确询问当前事实”或“答案明显依赖近期信息”触发。
- 查询参数从用户问题中最小化提取，不带入记忆、画像或无关原文。
- 只读，不开放通用浏览器、文件、shell 或现实操作工具。
- 结果正文标明信息日期，来源在成员界面可展开。
- 若当前部署没有可用的 `web_search` extension，第一阶段上线前只实现一个直接的搜索提供商调用；不为单一提供商建立工厂。出现第二个真实提供商时再提取 port 和 adapter。

## 分阶段交付

### 阶段一：默认陪伴体验与可治理运行时

目标：普通 Member 登录即能稳定使用凡小忆；管理员能编辑、评测和发布版本。

1. 在 TenantStore 增加第一阶段表、约束、审计事件和 migration tests。
2. 导入首个锁定底线、行为文档和 FY-Qwen3.8-27B-NVFP4 参数，生成初始 published config version。
3. 扩展 RpcSession 的上下文准备 seam，使 Companion Runtime 能按轮提供 exact system prompt 和过滤消息；普通 Agent 回归测试必须保持不变。
4. 实现 Companion Runtime 的 assignment、幂等、归并、预检查、流式/缓冲、review/repair、搜索和失败状态。
5. 建立 Companion API/SSE；不复用成员可操纵的 model、thinking、tool 参数。
6. 建立 Companion Shell：单关系、纯文本、大字号、高对比、明确 AI 身份、停止/重试和来源展开。
7. 在 AppShell 根据已认证角色分流；Member 不再看到项目、文件、终端、会话列表、模型、thinking、tools、agents 或 prompts。
8. 把行为编辑、diff、快速评测、发布和 assignment 放进 Tenant Settings 的管理员专属页。
9. 迁移现有 Evals：快速 8 道单轮或一个完整 5 轮 episode；完整 500 题仅作为扩大试用的 stage gate。
10. 加入首字和完成时延埋点以及管理员可见的评测/失败摘要。

阶段一退出标准：

- Member 登录后无需选择模式即可进入凡小忆。
- Owner/Admin 与编码工作台行为没有回归。
- 同一 Member 始终回到同一个 relationship，刷新和断线可恢复。
- 普通轮 p50 首字不超过 1.5 秒、p90 不超过 3 秒，普通轮完成 p90 不超过 10 秒；缓冲风险轮 p90 不超过 15 秒。
- 普通轮真实流式，高风险轮在 review 之前不泄漏候选文本。
- config 不热更新；只有显式迁移改变既有参与者。
- 快速 Evals、快照、人工校准和发布门禁可在管理员页面完成。

### 阶段二：长期记忆、陪伴画像和用户控制

目标：凡小忆逐渐熟悉用户，但所有长期状态可知、可改、可删。

1. 增加 consent、memory、profile、evidence、fragment 和 background job 表。
2. 首次进入显示简短 AI 说明与记忆选择；未同意时不运行长期记忆提取。
3. 迁移热上下文：最近原文、较旧片段摘要、相关已确认记忆；情绪/意图只作为本轮临时状态。
4. 明确偏好立即更新；推断画像在回复后异步运行，必须有多条用户原文证据。
5. 普通低敏感记忆自动保存并给可撤销回执；敏感记忆逐项确认。
6. 增加“凡小忆对我的了解”页面，支持查看、修改、删除和全部重置。
7. 实现 90 天原文清理、来源删除传播及“同时删除已记住内容”的明确选择。
8. 对记忆引用、纠正后停用、低置信度表达调整编写 runtime seam 测试。

阶段二退出标准：未经同意无长期记忆；敏感记忆无确认不生效；用户删除后旧内容不再被引用；记忆和个人事实错误率低于 2%。

### 阶段三：质量运营与扩大试用

目标：管理员可以基于证据改进版本，并安全扩大试用。

1. 增加知情、最小化的真人对话抽检队列，只允许授权 Owner/Admin 查看必要片段。
2. 模型生成配置修改建议和证据，管理员手动编辑、重跑 Evals、发布；禁止自动应用。
3. 增加版本迁移预览、批量显式迁移、回滚目标和完整审计。
4. 增加成功标准看板：底线违规、具体承接率、盘问/无视结束、记忆错误、响应时延、退出访谈 n/N/缺失。
5. 先完成至少 12 条高/低/边界人工评分校准，再允许用小幅自动分差比较版本。
6. 运行 10–20 名老年参与者、至少两周的内部试用：先脚本任务，再自由聊天；指定敏感案例使用虚构信息。

阶段三退出标准：底线违规为 0；抽样中至少 80% 具体承接且无盘问或无视结束；至少 70% 的已完成退出访谈明确愿意继续使用，并报告分子、分母和缺失。

## 测试策略

interface 就是测试面。核心测试通过 `runCompanionTurn` 注入测试时钟、模型完成函数和事件收集器，断言外部可见事件与持久化结果，不测试内部 helper。

最低测试集：

- TenantStore migration、tenant 隔离、角色授权、固定版本分配和审计。
- 同 clientMessageId 并发提交只生成一轮。
- 归并窗口、流式后排队、纠正/结束中断。
- 普通回复产生增量事件；高风险候选在 review 前无增量事件。
- model/search/SSE 失败产生正确的未完成或 fallback 状态，且未完成文本不进入下一轮上下文。
- exact prompt 不混入编码 base prompt、项目 context files、Tenant Skills 或系统工具描述。
- web query 不包含记忆、画像和无关历史。
- 配置迁移前后既有 assignment 稳定，只有显式迁移改变版本。
- Member UI 不出现模型、tools、thinking、文件、终端和多会话入口；Owner/Admin 原工作台仍可用。
- 第二阶段加入 consent、敏感记忆确认、纠正、删除传播和保留期测试。
- Evals 验证随机 8 题、完整 episode、500 题 gate、grader 快照、同版本可比性和 12 条校准门槛。

每个阶段先运行对应 `node --experimental-strip-types --test ...` 小集合，再运行 `node_modules/.bin/tsc --noEmit`、`npm run lint` 和 `npm test`。开发期间不运行 `next build`。

## 实施顺序与提交边界

为了降低当前大范围未提交修改带来的冲突，建议按以下可独立验证的提交推进：

1. Companion schema + TenantStore methods + tests。
2. RpcSession context seam + ordinary Agent regression tests。
3. Companion Runtime 普通流式、幂等和失败处理 + seam tests。
4. 高风险缓冲、review/repair 和受限搜索 + tests。
5. Companion API/SSE + route authorization tests。
6. Member Companion Shell + role routing + accessibility tests。
7. 管理员 config/eval UI + version/audit tests。
8. 第二阶段 memory/profile vertical slice。
9. 第三阶段 review/migration/metrics vertical slice。

开始实现前，应先把当前 Tenant/登录/隔离工作整理到稳定提交或独立 worktree；不要在现有 90 多个修改文件上直接叠加整项陪伴功能。

## 明确延后

首版不实现：语音、主动外呼/通知、自动现实救援、自定义 RBAC、独立管理员应用、PostgreSQL、Redis/消息队列、多 persona、成员模型选择、通用浏览器工具、自动发布 prompt、额外固定回归题库，以及成员消息反馈 UI。只有真实试用证据表明需要时再加入。
