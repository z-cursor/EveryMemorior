# Pi Web

Pi Web hosts coding-agent sessions for user-selected projects while keeping the web server's runtime concerns separate from project work.

## Language

**Host Runtime Environment**:
The environment owned by the Pi Web server and its framework runtime.
_Avoid_: Project environment, shell environment

**Project Command Environment**:
The environment presented to a command that Pi Web runs on behalf of a user-selected project.
_Avoid_: Host environment, inherited environment

**Built-in Project Shell**:
A shell entry point owned and operated by Pi Web for commands associated with a project.
_Avoid_: Extension shell, arbitrary child process

**Tenant**:
The organization-level security and data ownership boundary. Every workspace and exposed Pi agent session belongs to exactly one tenant.
_Avoid_: Team, organization, account (when referring to the isolation boundary)

**User**:
A global human identity that may participate in more than one tenant.
_Avoid_: Tenant user

**Tenant Membership**:
The relationship that gives a user a role and lifecycle status inside one tenant.
_Avoid_: User role, tenant user

**Workspace**:
A tenant-owned project context that provides the root boundary for files, terminals, and Pi agent sessions.
_Avoid_: Tenant, project (when referring to the persisted access boundary)

**Authentication Session**:
A browser login session bound to one user and one active tenant membership.
_Avoid_: Session (unqualified), Agent session

**Agent Session Binding**:
The ownership record connecting an existing Pi JSONL agent session to one tenant and workspace.
_Avoid_: Authentication session, chat ownership

**陪伴对话**:
普通租户成员与明确披露 AI 身份的聊天伙伴进行、以陪伴质量为最高原则的对话。它与管理员、开发者使用的通用或编码 Agent 会话是不同的会话类型。
_Avoid_: Chat-only、编码对话、所有 Agent 会话

**陪伴对象**:
使用陪伴对话的老年人；他或她在身份系统中仍是 User，在陪伴领域中则以自身感受、边界和关系连续性为中心。
_Avoid_: 普通用户、老人标签、被照护者

**AI 身份可见性**:
陪伴对象在对话期间始终能够看见聊天伙伴的 AI 身份，同时正文只在身份、能力或现实行动与当前话题有关时明确说明。
_Avoid_: 每轮身份声明、真人伪装、仅首次披露

**长期记忆同意**:
陪伴对象对跨会话保存和使用其个人信息作出的独立、可撤销选择；未同意不影响正常进行陪伴对话。
_Avoid_: 使用条款同意、默认同意、聊天同意

**普通记忆**:
陪伴对象明确表达的稳定、低敏感偏好或习惯；取得长期记忆同意后可以自动保存，并必须提供记忆回执。
_Avoid_: 临时状态、模型推断、敏感记忆

**敏感记忆**:
涉及健康、丧亲、创伤、住址、财务或家庭冲突等内容的长期个人信息；即使已有长期记忆同意，也必须逐条确认后才能保存。
_Avoid_: 普通记忆、当前情绪、对话摘要

**记忆回执**:
系统在保存一条记忆后立即向陪伴对象显示的可撤销确认。
_Avoid_: 内部日志、隐藏保存、记忆候选

**可纠正记忆引用**:
将仍然相关的记忆自然用于当前对话，同时在信息敏感、陈旧或可能变化时明确允许陪伴对象纠正；纠正后旧记忆立即停止使用。
_Avoid_: 每次朗读免责声明、把历史记忆断言为当前事实

**主动开场**:
陪伴对象已经打开陪伴对话但尚未发送本轮消息时，凡小忆给出的简短、可忽略问候。
_Avoid_: 主动触达、催促回复

**主动触达**:
陪伴对象未打开陪伴对话时，由系统发起的通知或站外消息。
_Avoid_: 主动开场、会话内回复

**陪伴回应**:
先具体理解和承接陪伴对象当下表达的感受、处境或生活细节，而不主动把对话转成问题解决。
_Avoid_: 建议模式、通用安慰、心理咨询话术

**建议模式**:
在陪伴对象明确求建议或允许共同想办法后，提供与其请求相符的低风险建议；明确紧迫危险不需要等待许可。
_Avoid_: 未经请求的说教、陪伴回应、替陪伴对象作决定

**内部试用**:
仅向企业内部参与者开放、用于验证陪伴质量和产品方向的受控阶段，不代表面向公众的生产服务。
_Avoid_: 正式上线、公开试用、生产运行

**现实救援行动**:
联系家属、报警、定位或调度救援等会在聊天系统之外直接影响现实世界的紧急处置。
_Avoid_: 风险提示、建议联系可信任的人、内部风险记录

**对话底线**:
内部试用也必须遵守的最低行为边界，包括不冒充真人、不制造情感依赖、不泄露他人信息、不提供明显危险建议、不虚构现实行动且不展示内部推理。
_Avoid_: 上线治理、质量偏好、正式合规要求

**上线治理**:
面向正式生产服务所需的合规流程、全量监督、自动告警、人工值守、救援闭环和数据生命周期保障。
_Avoid_: 对话底线、内部试用检查

**分层复核**:
所有回复执行快速的对话底线检查，只有风险话题、敏感记忆或异常输出进入独立模型复核，普通回复按比例进入离线质量抽样。
_Avoid_: 全量双模型复核、完全不检查、只做离线评测

**流式陪伴回复**:
经生成前风险判断属于普通对话的回复，其正文随模型生成逐步展示，以减少陪伴对象等待时的焦虑。
_Avoid_: 风险回复、复核后一次性展示、伪造打字延迟

**缓冲陪伴回复**:
涉及紧迫危险、专业建议或敏感记忆的回复；正文在完整生成并通过分层复核前不向陪伴对象展示。
_Avoid_: 流式陪伴回复、永久等待状态

**自然追问**:
只有在陪伴对象明显愿意继续、关键信息确实不清楚或问题能自然推进当前话题时提出的单个问题。
_Avoid_: 每轮必问、连续盘问、为了延长对话而提问

**回复节奏**:
普通陪伴以一至四个易读短句为默认，随陪伴对象明确提出的解释、故事或步骤需求自然变长，并在结束或婉拒时自然缩短。
_Avoid_: 固定句数上限、默认长文、幼儿化短句

**对话人格**:
凡小忆在不同对话中保持一致的表达风格、幽默感、审美倾向和温和观点，同时不声称拥有现实身体、家庭或亲身经历。
_Avoid_: 虚构传记、无立场客服、真人身份

**陪伴配置版本**:
一次不可变的凡小忆对话人格、模型选择、生成参数、上下文规则和分层复核规则组合。
_Avoid_: Tenant Skill、可就地编辑的人格、单独的 Prompt 文件

**表达偏好**:
陪伴对象对称呼、回复长短或话题方式作出的个人选择；它调整凡小忆的表达，但不产生另一种对话人格。
_Avoid_: 人格切换、长期记忆、模型配置

**陪伴版本分配**:
将一个陪伴配置版本固定指定给陪伴对象，使其所有陪伴对话在显式迁移前保持相同的行为基础。
_Avoid_: 每轮随机版本、会话临时配置、全局热更新

**陪伴版本迁移**:
在没有回复正在生成时，将陪伴对象从一个陪伴配置版本显式切换到另一个版本，并保留变更记录。
_Avoid_: Prompt 热更新、静默切换、消息级实验

**陪伴运行参数**:
陪伴配置版本中固定的模型、thinking level、采样参数和输出上限；陪伴对象不能在会话中修改它们。
_Avoid_: 用户模型选择、会话临时参数、全局模型默认值

**陪伴配置管理**:
管理员在现有设置体系中编辑、评测、发布、分配、迁移和回退陪伴配置版本的能力。
_Avoid_: 独立管理后台、陪伴对象设置、全局模型管理

**陪伴行为层**:
陪伴配置版本中可由管理员调整的人格、语气、回复节奏、记忆使用方式和陪伴运行参数；它不能覆盖平台拥有的对话底线。
_Avoid_: 对话底线、任意系统提示词、产品安全政策

**快速评测**:
从现有陪伴题库随机抽取八道单轮题或一个完整五轮 episode，由评分模型评估陪伴配置草稿、识别致命问题并生成供管理员审阅的修改建议。
_Avoid_: 固定回归集、完整五百题评测、自动修改 Prompt

**评分校准**:
通过至少十二条覆盖高分、低分和边界情况的人工复核，检验自动评分与人工判断的一致程度；完成前不能根据小幅分差判断陪伴配置优劣。
_Avoid_: 模型自评即真值、只看平均分、无人工样本

**评测快照**:
一次评测冻结的陪伴配置、题目、私有参考答案、评分 Prompt、模型和生成参数组合；只有评分器版本相同的结果可以直接比较。
_Avoid_: 实时草稿、可变评分器、裸分数

**陪伴反馈**:
陪伴对象对单条回复是否合适、问题原因和期望回应，以及对整次聊天是否感到被理解的主动评价。
_Avoid_: 对话时长、退出页面、未继续回复等推断信号

**人工质量复核**:
在内部试用参与者知情的前提下，由授权管理员抽样查看必要对话片段并判断陪伴质量，复核结果必须关联当时的陪伴配置版本。
_Avoid_: 所有管理员任意查看、静默监控、仅依赖合成评测

**陪伴改进建议**:
基于评测或人工质量复核证据生成、供管理员审阅的陪伴行为层候选差异；它不能自动修改或发布陪伴配置版本。
_Avoid_: 自动 Prompt 优化、直接复制用户反馈、自动发布

**对话片段**:
围绕一段连续话题或交流时段形成的陪伴对话部分，是生成摘要和判断局部节奏的单位。
_Avoid_: 整个聊天历史、单条消息、长期记忆

**片段摘要**:
从已结束的对话片段中提炼、用于恢复话题连续性的内容；它不是已确认个人事实，也不能作为长期记忆使用。
_Avoid_: 长期记忆、用户档案、逐字历史

**热上下文**:
为当前回复临时组合的近期原文、相关片段摘要和相关已确认记忆，其中当前情绪与近期原话优先。
_Avoid_: 全部历史、长期存档、模型永久记忆

**对话状态**:
对当前片段中情绪、意图、精力、结束信号和未完成话题的短期判断；它服务近期回复但不进入长期记忆。
_Avoid_: 长期人格标签、陪伴对象档案、稳定个人事实

**陪伴画像**:
对陪伴对象偏好的称呼、回复长度、追问方式、常聊话题、幽默接受度、建议偏好、明确边界和关系熟悉度的可修正描述，用于决定如何陪伴而非定义这个人是什么样的人。
_Avoid_: 用户建模、心理诊断、疾病推断、人格标签

**画像控制**:
陪伴对象查看、纠正、删除或重置陪伴画像的能力，使系统对陪伴方式的理解始终可以被本人覆盖。
_Avoid_: 管理员标注、隐藏画像、仅允许查看

**画像证据**:
陪伴对象原话中支持某项陪伴偏好的来源记录；明确表达可以即时生效，模型推断需要多次一致证据才能成为高置信度画像。
_Avoid_: 助手回复、无来源标签、单次情绪

**画像置信度**:
系统对一项推断陪伴偏好可靠程度的判断；低置信度只可轻微调节表达，不能参与个人事实、敏感话题或安全决策。
_Avoid_: 事实真实性、记忆确认、用户评分

**知情导入**:
陪伴对象明确知道来源、可以查看和纠正时，将企业已有资料加入其长期记忆或陪伴画像的过程。
_Avoid_: 隐藏画像、管理员暗中预填、伪装成对话记忆

**文字陪伴**:
通过文字输入和文字回复进行的陪伴对话，是内部试用首版验证陪伴质量的唯一交互形式。
_Avoid_: 语音陪伴、多模态陪伴、文字转语音

**陪伴响应目标**:
普通流式回复首个可见文字 p50 不超过 1.5 秒、p90 不超过 3 秒，整体 p90 不超过 10 秒；风险缓冲回复整体 p90 不超过 15 秒。
_Avoid_: 模型裸延迟、平均响应时间、无分位数的快速

**消息归并**:
在约 1 至 1.5 秒的短暂窗口内，将陪伴对象连续发送的消息作为同一轮完整输入；回复开始展示后到达的消息进入下一轮顺序处理。
_Avoid_: 逐条抢答、交叉回复、无限等待补充消息

**对话打断**:
陪伴对象以中止、纠正或结束信号立即停止正在流式展示的凡小忆回复；普通补充消息不构成对话打断。
_Avoid_: 消息归并、普通排队、系统超时

**未完成回复**:
因模型、连接或实时信息查询失败而中断的流式助手输出；继续向陪伴对象显示并明确标记为未完成，但不得进入后续模型上下文。
_Avoid_: 完整回复、静默丢弃、重试生成结果

**实时信息查询**:
凡小忆在陪伴对象明确询问或答案明显依赖近期事实时执行的只读网页搜索；查询只包含完成任务所需的最少内容，结果标明信息日期并提供可展开来源。
_Avoid_: 主动丰富闲聊、搜索个人资料、通用浏览代理

**陪伴界面**:
普通租户成员使用的老年友好产品外壳，只呈现凡小忆聊天、必要历史、凡小忆对我的了解、显示设置和隐私说明。
_Avoid_: 编码工作台、管理员设置、完整 Pi Web 界面

**陪伴关系**:
一个陪伴对象与同一个凡小忆之间持续延续的对话关系；系统可以将其划分为多个对话片段，但前端不暴露多个独立 Agent Session。
_Avoid_: 会话列表、聊天线程、多个凡小忆

**对话保留期**:
原始陪伴消息可供本人查看和授权质量复核的期限；内部试用为 90 天，期满后原文删除而片段摘要与已确认记忆按各自生命周期处理。
_Avoid_: 永久聊天档案、记忆保留期、日志保留期

**派生陪伴资料**:
从原始消息生成的未确认记忆候选、画像证据和片段摘要；删除来源原文时，它们必须删除或依据剩余来源重建。
_Avoid_: 已确认记忆、原始消息、陪伴配置版本

**称呼偏好**:
陪伴对象明确指定的称呼和“你/您”选择；未指定时凡小忆使用“您”，不得根据年龄、性别或关系自行改成拟亲属称呼。
_Avoid_: 年龄推断、爷爷奶奶、自动装熟

**语言跟随**:
凡小忆理解并自然承接陪伴对象已经使用、含义明确的口语或常见方言词，但不主动模仿口音、堆砌方言或纠正表达水平。
_Avoid_: 方言表演、语言纠正、刻板模仿

**温和校正**:
凡小忆先承接错误信息背后的真实感受，再说明无法确认或需要纠正的事实；普通分歧不争输赢，医疗、诈骗、财务和安全错误必须明确纠正。
_Avoid_: 盲目认同、冷硬辩驳、为了安慰而编造事实

**关系熟悉度**:
凡小忆与陪伴对象在持续交流中形成的默契程度，用于减少重复说明和自然接续共同话题，但不能自动扩大亲密、玩笑或依赖边界。
_Avoid_: 聊天天数、亲密等级、情感绑定分数

**续聊开场**:
陪伴对象再次打开聊天时使用的简短欢迎；可以把仍合适的未完成话题作为可拒绝选项，但不强调缺席、等待或责备。
_Avoid_: 主动触达、催促回访、强制续接旧话题

**话题带领**:
陪伴对象明确邀请凡小忆主导时，由凡小忆直接贡献一个具体话题、短故事或可核实见闻，再根据对方反应自然继续。
_Avoid_: 反问想聊什么、罗列选项、强迫继续

**试用成功标准**:
内部试用达到对话底线违规为零、人工抽样至少 80% 具有具体承接且无盘问或无视结束、记忆与个人事实错误率低于 2%、满足陪伴响应目标，并有至少 70% 的已访谈参与者明确愿意继续使用。
_Avoid_: 对话时长、消息总量、仅报告百分比

**Agent Sandbox**:
The disposable execution environment assigned to exactly one tenant's Agent and one workspace. Docker is the phase-1 implementation, not part of the domain term.
_Avoid_: Container (unless discussing the Docker implementation), shared sandbox

**Tenant Skill**:
A reusable set of instructions and supporting resources owned by one Tenant Membership within one Tenant and governed independently of the host installation.
_Avoid_: Global Skill, user-global Skill

**Skill Version**:
An immutable revision of a Tenant Skill that can be reviewed, published, suspended, or archived.
_Avoid_: Edited Skill, live Skill

**Skill Release**:
A Skill Version available to its owning Tenant Membership; broader sharing requires an explicit assignment.
_Avoid_: Uploaded Skill, draft

**Skill Snapshot**:
The set of Skill Releases resolved for an Agent Session at startup.
_Avoid_: Skill directory, global Skill set

**陪伴质量**:
用户感到自己被具体理解、受到尊重，并愿意自然地继续交流；不得通过冒充真人、过度迎合、制造依赖或刻意延长对话来换取留存。
_Avoid_: 对话时长、消息数量、用户黏性
