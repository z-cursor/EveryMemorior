# Biography Skill Docker 集成规范

状态：实施中  
适用范围：Pi Web 中的 `biography-agent-longform` Skill 及其访谈、写作、审核和合稿流程

## 1. 目标

本规范定义 Biography Skill 在 Pi Web 中的运行方式。目标是同时满足：

1. 保留原插件的访谈能力和工作流语义；
2. 将 Python、模型请求和租户 Skill 代码放入隔离运行时；
3. 保证路径、超时、取消、模型路由和检查点可以在 Docker 中稳定工作；
4. 让章节写作性能接近原部署，单章正常目标为 3—4 分钟，复杂章节允许更长；
5. 避免上传扩展代码直接执行在 Pi Web/Next.js 宿主进程中。

本 Skill 的核心价值是访谈引导，而不只是根据问答生成正文。因此，访谈状态机、追问质量和用户选择优先级属于不可破坏的功能契约。

## 2. 原插件行为契约

以下行为必须与原 `extensions/biography-workflow.ts` 保持一致：

- 每轮只围绕当前章节和当前素材目标推进；
- 每次提出一个主题问题组，用户回答后才进入下一步；
- 短回答、含糊回答或缺少关键维度时，围绕原问题追问；
- 追问不占主问题数量，不得用换一种说法重复已跳过的问题；
- 用户说“已经回答过”时，核对已有原话并停止无效重复追问；
- 用户回答当前问题时补充旧问题，必须挂回指定旧问题；
- “跳过”“忘了”“不想回答”只关闭对应问题或小问；
- “今天先停”“暂停”保留 pending 问题，不得误记为跳过；
- 达到门槛后展示写作、继续采访、自由回忆等选择，并等待用户选择；
- 12—14 组素材选择写作时需要一次明确确认；
- 达到 15 组且满足工具规则时可结束采访并登记；
- 自由回忆内容必须原样登记为素材，不能强行改造成新的主问题；
- 采访承接必须贴着用户刚才的具体事实，不能只机械输出下一题；
- 用户未明确批准时，不能把章节称为正式完成；
- 章节流程必须按 Writer → Polisher → Punctuation → Proofreader → Reviewer → 用户批准推进。

访谈工具的 `answer`、`skip`、`supplement`、`free_recall` 只能处理用户实际发送的新消息。调用 `ask` 或 `followup` 后必须等待用户，不得用模型总结、工具结果或内部续行代替用户回答。

## 3. 权威实现与适配边界

原插件源码是行为权威来源，但上传租户包中的 TypeScript 不能直接在宿主进程动态执行。平台采用以下结构：

```text
审核后的原 biography 工作流副本
        ↓
lib/biography-workflow-native.ts
        ↓
lib/biography-workflow-adapter.ts
        ↓ 仅替换 pi.exec、路径和运行时参数
AgentSandbox / Docker
        ↓
pi_bridge.py → biography Skill Python 脚本 → 模型网关
```

规则如下：

- `biography-workflow-native.ts` 必须保持原扩展的工具定义、Prompt Guidelines、事件监听、采访状态、去重判断和用户回复拼接逻辑；
- Adapter 不得重新实现采访状态机；
- Adapter 只能负责固定 argv、容器路径、取消信号、超时和模型路由；
- 租户上传的 `extensions/*.ts` 不得直接 `import` 到 Next.js/Pi Web 进程；
- 如果以后需要运行任意租户扩展，必须另建独立扩展沙箱和 RPC 协议，不能绕过本规范。

## 4. Skill 和资源加载

ZIP 中的 `.codex-plugin/plugin.json` 声明 `skills: "./skills/"`。因此 `skills/` 是权威 Skill 根目录，`.pi/skills/` 只视为历史副本，不得覆盖声明目录。

必须满足：

- `skills/biography-interviewer/SKILL.md` 和其 `chapter_interviewer.py` 与发布包一致；
- Writer、Orchestrator、File Manager、Reviewer 等 Skill 从同一发布版本加载；
- 发布版本必须经过 release digest 校验；
- 资源加载只能读取已发布租户 Skill，不能扫描并执行宿主的任意目录；
- 项目上下文、Prompt Template 和 Theme 是否加载必须由租户资源策略明确决定，不能因 Docker 接入默默丢失并且不记录。

当前 Biography 包的 `skills/` 目录已与部署版本逐文件核对，34 个文件无差异。

## 5. Docker 运行时要求

每个租户 Agent 会话使用绑定的 AgentSandbox。容器必须：

- 使用预加载且可校验 digest 的镜像；
- `--network none`；
- `--cap-drop ALL` 和 `no-new-privileges`；
- 根文件系统只读；
- 只读挂载已发布 Skill；
- 将租户工作区挂载为 `/workspace`；
- 使用固定 argv 调用 Python bridge，不把用户输入拼入 shell；
- 对内存、CPU、PID、输入、输出和执行时间设置上限；
- 以非 root UID/GID 运行；
- 容器内不保存模型密钥。

当前默认值：

| 项目 | 默认值 |
|---|---:|
| 单次 LLM 请求超时 | 600 秒 |
| 单阶段超时 | 600 秒 |
| 整次 Bridge 执行超时 | 2400 秒 |
| 容器内存 | 4 GiB |
| 容器 CPU | 2 |

单次 LLM 请求超时、单阶段超时和整章执行超时必须是三个独立配置，不能复用同一个环境变量。

## 6. 路径转换规则

- 宿主工作区映射为容器 `/workspace`；
- 原扩展生成的 `--workspace-root` 在容器内固定为 `/workspace`；
- `--source-path` 必须位于工作区内，越界路径直接拒绝；
- `--session-case-hint` 保留为已校验的案例 ID，不把宿主绝对路径带入容器；
- 容器输出中的 `/workspace/...` 可转换为 Pi Web 可打开的宿主路径；
- 路径转换不得修改问答文本、问题、回答、追问或选择值。

## 7. 模型网关

模型请求必须从容器经 Unix Socket 转发到宿主网关：

- 容器只获得 provider/model 标识，不获得密钥和真实 API 地址；
- 网关必须校验请求 provider/model 与当前会话路由完全一致；
- 当前支持 `openai-completions` 兼容接口；
- 非该 API 的模型必须明确报错，不能静默切换备用模型；
- 网关负责单次请求超时和响应大小限制；
- 模型请求失败必须回传原始错误状态，不能被普通回复覆盖成成功。

## 8. 不得发生的退化

以下实现均不符合本规范：

- 用一个简化 Adapter 替代原访谈状态机；
- 删除或缩短原扩展的采访 Prompt Guidelines；
- 在没有用户回答时由模型自动生成回答或自动关闭 pending 问题；
- 把 `skip`、`pause`、`choice` 当作普通传记事实；
- 因 Docker 路径问题丢弃 `remaining_subquestions` 或 `resolved_subquestions`；
- 因超时自动重置采访状态或清除检查点；
- 让章节 Writer 代替采访工具直接生成问答；
- 让容器通过宿主 shell 执行租户提供的任意命令；
- 因资源隔离默默丢弃采访 Skill、章节合同或素材目标；
- 以机器 Reviewer 通过替代用户批准。

## 9. 验收测试

发布前必须通过以下端到端测试：

1. 首次提问后停止，等待用户回答；
2. 一句短回答触发同一问题的针对性追问；
3. 用户声明“我已经回答过”后不再重复询问；
4. 用户跳过当前题后不重问同一主题；
5. 用户暂停后恢复时保留 pending 问题；
6. 12 组后出现三项选择并等待选择；
7. 12—14 组选择写作时只提醒一次并等待确认；
8. 15 组后按规则登记并进入同章 Writer；
9. 用户补充旧问题时正确回挂；
10. 自由回忆内容原样登记且不增加主问题编号；
11. 断开模型或超时后保留检查点，恢复不会重复登记回答；
12. 章节全链路仍按 Writer、Polisher、Punctuation、Proofreader、Reviewer 和用户批准顺序执行。

每项测试都必须检查：用户可见回复、工具调用参数、采访文件、状态 JSON、pending 状态和下一步动作。

## 10. 当前实现的已知边界

当前静态代码对照确认原采访逻辑已保留，但此前验证主要覆盖工具注册、参数转发和章节写作。完整的上述访谈回归测试仍是上线前必须补齐的验收项。

此外，Docker 的无网络、只读根文件系统、固定模型 API 和资源上限属于明确运行边界。如果未来采访需要外部资料检索、宿主全局文件或非 OpenAI-compatible 模型，必须扩展运行时契约并重新评估安全边界，不能直接放开容器权限。

