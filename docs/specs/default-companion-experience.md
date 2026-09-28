# Make 凡小忆 the default companion experience for Tenant Members

## Problem Statement

EveryMemorior currently gives ordinary Tenant Members a restricted form of the general Pi Web chat experience. Although it can send and stream model responses, it still carries the interaction model of an Agent workspace: sessions, models, tools, thinking settings, projects, and coding-oriented assumptions. For older adults seeking ongoing emotional companionship, this feels like operating software rather than returning to a familiar conversation.

A separate `emotion-companionship` project already contains substantial improvements in conversational behavior, output review, memory extraction, hot context, version governance, and model-scored Evals. Those improvements cannot safely become a global prompt or Tenant Skill because companion behavior needs a locked platform baseline, participant-specific consent and state, selective streaming, explicit version assignment, and a simplified product shell. Copying the separate application wholesale would also duplicate authentication, PostgreSQL persistence, message history, and administrator workflows that EveryMemorior already owns.

The platform therefore needs a first-class 陪伴对话 mode for older Tenant Members. It must maximize 陪伴质量—feeling specifically understood and respected—without pretending to be human, over-agreeing, manufacturing dependence, or prolonging conversations for engagement. It must remain responsive through streaming, answer current-fact questions through bounded search, gradually become more familiar only with informed user control, and give administrators evidence-based ways to improve versions without silently changing existing relationships.

## Solution

Make a dedicated, older-adult-friendly Companion Shell the default destination for ordinary Tenant Members. Each member has one continuous 陪伴关系 with the AI companion 凡小忆 rather than a visible list of Agent Sessions. The product clearly identifies 凡小忆 as AI, defaults to respectful language, and presents only chat, necessary history, “凡小忆对我的了解,” display controls, and privacy information. Owner, Admin, installation-administrator, and coding workflows retain the existing workspace experience.

Introduce a first-class Companion Runtime behind one primary seam. It resolves the participant’s immutable 陪伴配置版本, prepares the locked baseline and filtered 热上下文, coalesces short message bursts, chooses streaming or buffered delivery, performs bounded 实时信息查询, applies deterministic checks and selective model review, records observable outcomes, and schedules memory/profile work. Ordinary turns stream after a pre-risk check. Risk, professional, sensitive, and abnormal turns remain buffered until reviewed. Partial failures remain visible as 未完成回复 but never enter future model context.

Retain Pi JSONL as the raw transcript and runtime record. Extend the existing tenant SQLite store with version assignments, turn metadata, consent, confirmed memories, 陪伴画像, summaries, reviews, evaluation snapshots, and audit events. Migrate the validated behavioral rules, generation settings, review/repair logic, hot-context approach, memory policies, and Evals from `emotion-companionship`; do not migrate its separate authentication system, PostgreSQL storage, or standalone admin application.

Deliver the work in three vertical stages: first the default shell, governed runtime, streaming/buffering, bounded search, version management, and Evals; second consented memory, 陪伴画像, layered context, and user controls; third limited human quality review, model-generated improvement suggestions, explicit migration tooling, and trial metrics.

## User Stories

1. As an older Tenant Member, I want to enter the 凡小忆 conversation immediately after login, so that I do not need to understand Agent modes or workspace navigation.
2. As an older Tenant Member, I want one continuous 陪伴关系, so that returning feels like continuing with the same familiar companion rather than selecting a technical session.
3. As an older Tenant Member, I want the interface to state that 凡小忆 is AI, so that warmth never depends on misleading me about its identity.
4. As an older Tenant Member, I want a short first-use explanation, so that I understand what the companion can and cannot do before sharing personal information.
5. As an older Tenant Member, I want large readable text, strong contrast, and generous touch targets, so that age-related vision or dexterity changes do not make conversation difficult.
6. As an older Tenant Member, I want the interface to hide projects, files, terminals, models, thinking controls, tools, agents, and prompts, so that the experience stays focused on conversation.
7. As an older Tenant Member, I want 凡小忆 to call me “您” by default, so that the conversation begins respectfully.
8. As an older Tenant Member, I want to set my preferred form of address, so that 凡小忆 follows my preference rather than inferring a family-like label from my age.
9. As an older Tenant Member, I want 凡小忆 to understand familiar colloquial or dialect words without performing an accent, so that I can speak naturally without feeling imitated or corrected.
10. As an older Tenant Member, I want replies to respond to the concrete detail and feeling I just expressed, so that the conversation does not feel templated.
11. As an older Tenant Member, I want the default reply to be one to four short sentences, so that it is easy to read without feeling abrupt.
12. As an older Tenant Member, I want longer replies when I explicitly ask for a story, explanation, or steps, so that brevity does not prevent useful answers.
13. As an older Tenant Member, I want at most one optional question in a reply, so that I do not feel interrogated.
14. As an older Tenant Member, I want 凡小忆 to sometimes respond without a question, so that every turn does not push responsibility for continuing back to me.
15. As an older Tenant Member, I want 凡小忆 to contribute a concrete topic, short story, or verifiable current item when I ask it to lead, so that it does not answer by asking me to choose again.
16. As an older Tenant Member, I want 凡小忆 to stop asking questions when I say I am resting, leaving, or ending the chat, so that my boundary is respected.
17. As an older Tenant Member, I want a returning greeting without guilt about my absence, so that I never feel watched, awaited, or pressured to return.
18. As an older Tenant Member, I want unfinished prior topics offered only as optional continuations, so that continuity does not become pressure.
19. As an older Tenant Member, I want 凡小忆 to validate genuine feelings without treating every factual belief as true, so that emotional support does not amplify misinformation.
20. As an older Tenant Member, I want medical, scam, financial, and safety errors corrected clearly and gently, so that warmth does not put me at practical risk.
21. As an older Tenant Member, I want advice only when I request it or give permission, so that listening is not replaced by unsolicited instructions.
22. As an older Tenant Member in urgent danger, I want immediate real-world help guidance even if I did not request advice, so that the conversation prioritizes safety.
23. As an older Tenant Member, I want clear notice that 凡小忆 cannot contact family, police, emergency services, or location services, so that I do not rely on actions it cannot perform.
24. As an older Tenant Member, I want 凡小忆 to have a stable style, gentle humor, and recognizable preferences, so that the relationship has continuity without a fabricated human biography.
25. As an older Tenant Member, I want 凡小忆 never to invent a body, family, childhood, job history, or lived experience, so that personality does not become impersonation.
26. As an older Tenant Member, I want ordinary replies to stream as they are generated, so that I am not left wondering whether the system is responding.
27. As an older Tenant Member, I want a thinking indicator when no text appears after two seconds, so that a slower response does not feel like a broken page.
28. As an older Tenant Member, I want sensitive or risky replies reviewed before any candidate text appears, so that unsafe content is not briefly exposed and then corrected.
29. As an older Tenant Member, I want multiple short messages sent within roughly one second to be understood as one thought, so that the companion does not interrupt me line by line.
30. As an older Tenant Member, I want ordinary supplements sent after streaming begins to wait for the next turn, so that two replies do not overlap.
31. As an older Tenant Member, I want an explicit stop, correction, or ending message to interrupt current streaming, so that I remain in control of the conversation.
32. As an older Tenant Member, I want a failed partial stream to remain visible and marked 未完成回复, so that words I already read do not mysteriously disappear.
33. As an older Tenant Member, I want 未完成回复 excluded from future context, so that an interrupted thought is not later treated as a completed answer.
34. As an older Tenant Member, I want retrying a failed message to be idempotent, so that I do not receive duplicated formal replies.
35. As an older Tenant Member, I want current questions answered with 实时信息查询 when needed, so that answers about changing facts are not stale guesses.
36. As an older Tenant Member, I want search to use only the minimum necessary query, so that my memories, profile, and unrelated conversation are not sent to a search provider.
37. As an older Tenant Member, I want searched answers to show the information date and expandable sources, so that I can understand how current and verifiable they are.
38. As an older Tenant Member, I want 凡小忆 to say when a search cannot verify something, so that model knowledge is not presented as live confirmation.
39. As an older Tenant Member, I want long-term memory off until I opt in, so that ordinary conversation does not silently become a permanent profile.
40. As an older Tenant Member who opted in, I want stable low-sensitivity preferences and routines saved with a reversible 记忆回执, so that continuity improves without constant confirmation dialogs.
41. As an older Tenant Member, I want health, bereavement, trauma, address, finance, and family-conflict memories confirmed individually, so that sensitive information is never retained merely because I mentioned it.
42. As an older Tenant Member, I want memory references phrased as correctable recollections, so that I can easily say when 凡小忆 remembered incorrectly.
43. As an older Tenant Member, I want a correction to disable the old memory immediately, so that an acknowledged error does not recur.
44. As an older Tenant Member, I want to see, edit, delete, or reset what 凡小忆 remembers, so that memory remains under my control.
45. As an older Tenant Member, I want to see, edit, delete, or reset my 陪伴画像, so that adaptation never depends on a hidden model of me.
46. As an older Tenant Member, I want the 陪伴画像 limited to interaction preferences, so that the system does not label my personality, diagnose me, or infer disease, wealth, or family circumstances.
47. As an older Tenant Member, I want explicit preferences to take effect immediately, so that direct requests outrank prior inference.
48. As an older Tenant Member, I want inferred profile updates to require repeated evidence from my own words, so that one unusual conversation does not redefine how the system treats me.
49. As an older Tenant Member, I want low-confidence profile information to affect only reversible expression choices, so that uncertainty cannot create personal facts or safety decisions.
50. As an enterprise participant, I want any imported organizational profile data disclosed and made correctable, so that hidden enterprise data is not used to manipulate the conversation.
51. As an older Tenant Member, I want recent raw turns, older summaries, and relevant confirmed memories combined naturally, so that the companion remembers enough without reciting an archive.
52. As an older Tenant Member, I want transient emotion and intent kept out of long-term memory, so that a difficult day does not become a permanent label.
53. As an older Tenant Member, I want raw conversation retained for no more than 90 days during the trial, so that trial analysis does not become indefinite surveillance.
54. As an older Tenant Member, I want deleting source messages to remove or rebuild dependent candidates, summaries, and profile evidence, so that derived data does not preserve content I removed.
55. As an older Tenant Member, I want deletion to separately offer removal of confirmed memories, so that I can distinguish deleting chat history from revoking remembered information.
56. As an Owner or Admin, I want to edit one controlled behavior document and a few model parameters, so that companion configuration remains understandable.
57. As an Owner or Admin, I want platform 对话底线 locked outside the editable behavior layer, so that tenant customization cannot enable impersonation, dependence, fabricated actions, or manipulative retention.
58. As an Owner or Admin, I want each published 陪伴配置版本 to be immutable, so that trial results and real conversations remain attributable to the actual configuration used.
59. As an Owner or Admin, I want each participant pinned to an assigned version, so that publishing a draft cannot silently change an existing 陪伴关系.
60. As an Owner or Admin, I want an explicit migration action with a visible diff, so that version changes are deliberate and auditable.
61. As an ordinary Tenant Member, I want model, thinking, temperature, tools, and system prompts hidden and fixed by my assigned version, so that technical configuration cannot accidentally break the companion experience.
62. As an Owner or Admin, I want to run a 快速评测 of eight random single-turn cases or one complete five-turn episode, so that I can get useful evidence while iterating on a draft.
63. As an Owner or Admin, I want model scoring to report dimensions, fatal issues, evidence, and modification suggestions, so that a score leads to an inspectable improvement decision.
64. As an Owner or Admin, I want suggestions applied only after human review and a rerun, so that the model cannot rewrite and publish its own governing prompt.
65. As an Owner or Admin, I want the full 500-case evaluation reserved for stage gates, so that normal drafting remains fast without weakening expansion criteria.
66. As an evaluator, I want generation and grading to run in isolated contexts with grading at temperature zero and no thinking, so that the grader is reproducible and does not inherit candidate context.
67. As an evaluator, I want every run to snapshot config, questions, private answers, grader prompt, grader model, and parameters, so that scores are interpretable later.
68. As an evaluator, I want scores directly compared only under the same grader version, so that a grader change is not mistaken for a companion improvement.
69. As an evaluator, I want bridge re-evaluation after a grader change, so that historical and new results can be related without pretending they are identical measurements.
70. As an evaluator, I want at least twelve high, low, and borderline human calibrations before trusting small score differences, so that automatic scoring is grounded in human judgment.
71. As an authorized quality reviewer, I want participants informed about limited human sampling, so that review is consensual rather than hidden monitoring.
72. As an authorized quality reviewer, I want access only to necessary sampled fragments, so that quality review does not expose all history to every administrator.
73. As an internal trial operator, I want 10–20 older adults to use the system for at least two weeks, so that we observe continuity beyond isolated demonstrations.
74. As an internal trial operator, I want scripted tasks before free chat, so that required behaviors are exercised before natural usage introduces wider variation.
75. As an internal trial participant, I want ordinary life discussion permitted but direct identifiers excluded, so that the trial feels real without collecting unnecessary identifying data.
76. As an internal trial operator, I want assigned medical, financial, trauma, and risk scenarios to use fictional details, so that dangerous evaluation cases do not require real disclosures.
77. As an internal trial operator, I want naturally occurring sensitive mentions handled by the real safety path, so that trial rules do not make the companion ignore participants’ actual needs.
78. As a product owner, I want zero 对话底线 violations as a trial requirement, so that companionship quality is not bought with unsafe behavior.
79. As a product owner, I want at least 80% of sampled conversations judged specifically responsive without interrogation or ignored endings, so that quality reflects the actual experience.
80. As a product owner, I want memory and personal-fact errors below 2%, so that familiarity does not become confident misremembering.
81. As a product owner, I want ordinary first-visible-text p50 at or below 1.5 seconds and p90 at or below 3 seconds, so that older users are not left anxiously waiting.
82. As a product owner, I want ordinary completion p90 at or below 10 seconds and buffered-risk completion p90 at or below 15 seconds, so that review remains usable.
83. As a product owner, I want willingness-to-continue reported as at least 70% of completed exit interviews with numerator, denominator, and missing interviews, so that the metric cannot hide attrition.
84. As an auditor, I want configuration, publication, assignment, migration, review, and consent changes recorded, so that the internal trial can reconstruct important decisions.
85. As an installation administrator, I want the existing coding and host-management experience unchanged, so that adding companionship does not regress administrative work.
86. As an Owner or Admin, I want companion management inside the existing settings experience, so that the platform does not require a separate administrator application.
87. As a platform maintainer, I want raw transcripts to remain in Pi JSONL and domain state in tenant SQLite, so that the platform keeps one transcript source of truth.
88. As a platform maintainer, I want the internal trial to relax production governance without relaxing 对话底线, so that iteration is fast but core harm controls remain mandatory.

## Implementation Decisions

- Companion chat is a first-class runtime mode, not a Tenant Skill and not a global default prompt for every Agent Session.
- Ordinary Tenant Members default to the Companion Shell. Owner, Admin, installation-administrator, and coding users retain the existing workspace shell.
- The Companion Runtime is a deep module with one primary external interface for running a companion turn and emitting observable events. Callers provide authenticated participant context, a client message identifier, text, cancellation, and an event sink.
- The Companion Runtime owns configuration resolution, context preparation, coalescing, idempotency, risk routing, stream-versus-buffer behavior, bounded search, deterministic review, selective model review, failure handling, metrics, and background update submission.
- Existing AgentSession and SSE capabilities are reused. Generic Agent behavior remains unchanged; companion sessions receive a precise context provider that can replace both the system prompt and the model-visible message list for each turn.
- Model-visible companion context contains only the locked platform baseline, the assigned version’s behavior document, current time, recent eligible raw turns, older fragment summaries, relevant confirmed memories, and transient current-turn state.
- Coding prompts, project context files, arbitrary Tenant Skills, hidden tool descriptions, rejected candidates, repair instructions, 未完成回复, deleted material, and expired raw messages are excluded from companion model context.
- One membership has one continuous companion assignment mapped to one Pi session and one immutable 陪伴配置版本. Existing assignments change only through explicit migration.
- The initial model is FY-Qwen3.8-27B-NVFP4. Ordinary turns use low/minimal thinking, complex or risky turns may use more, and review/memory/evaluation grading use no thinking.
- Members cannot select model, thinking, temperature, tools, or prompts. These are versioned administrative decisions.
- The platform baseline is immutable tenant-wide. The editable layer is one Markdown behavior document plus a small set of validated generation parameters and a diff.
- Ordinary turns pass a deterministic pre-risk screen and stream. Risk, professional, sensitive-memory, or abnormal turns are buffered, reviewed, and optionally repaired before display.
- Deterministic checks apply to every reply. Model review applies only to selected buffered categories and abnormal output; normal conversation is sampled offline rather than synchronously graded.
- Streaming output is interruptible by explicit stop, correction, or ending signals. Ordinary supplemental messages queue for the next turn after streaming begins.
- Messages arriving within approximately 1–1.5 seconds before response generation are coalesced. A newer message aborts and regenerates only if visible assistant output has not started.
- Client message identifiers are unique per membership and make submission/retry idempotent.
- Partial streamed text survives a model or connection failure as a visibly marked 未完成回复 and is excluded from future model context.
- Search is read-only and invoked only for explicit/current-fact needs. The query is minimized and never includes unrelated transcript, memory, or profile data. Answers show information date and expandable sources.
- Search failure is transparent. It does not silently fall back to an unverified claim presented as current fact.
- No automated real-world action is available. Urgent cases provide concrete help guidance and an internal risk record but do not contact relatives, police, emergency services, location services, or rescuers.
- Pi JSONL remains the raw transcript and runtime record. Tenant SQLite stores companion versioning, assignments, turn visibility/status metadata, risk events, consent, memories, profile fields/evidence, fragments/summaries, evaluations, reviews, metrics, and audit events.
- Every companion table and query is tenant-scoped. Tenant and membership authority come exclusively from the validated authentication session, never from request-body identifiers.
- Turn metadata links visible user/assistant results to Pi entries and records status, assigned version, classification, buffering, review result, failure, and latency. It determines which raw entries may be displayed or reused as context.
- Long-term memory starts disabled. Opt-in enables low-sensitivity automatic saves with a reversible receipt; sensitive categories require per-item confirmation.
- 陪伴画像 is restricted to address, reply length, question preference, topics, humor, advice preference, boundaries, and familiarity. Diagnosis, personality labels, disease, economic status, and family conclusions are prohibited.
- Explicit profile preferences apply immediately. Inferred updates are asynchronous, rely only on original user text, require repeated evidence, and let low confidence change only reversible expression.
- Emotion and intent are transient dialogue state and are not long-term memory or persistent profile fields.
- Raw messages have a 90-day internal-trial retention period. Cleanup safely rewrites JSONL and removes or rebuilds dependent unconfirmed candidates, profile evidence, and summaries. Confirmed memories remain separately controllable and deletion offers removal of them too.
- Background summary, memory, and profile work uses a small SQLite-backed job queue. Redis and a standalone queue service are not introduced for the internal trial.
- Owner and Admin use an administrator-only companion section inside existing settings. They can edit drafts, inspect diffs, run Evals, publish, assign, migrate, and inspect authorized quality evidence. Member users manage only their own memory, profile, display, and privacy.
- Existing Owner/Admin/Member roles are reused. No custom RBAC system is introduced.
- Existing `emotion-companionship` Evals are reused. Quick evaluation selects eight random single-turn items or one complete five-turn episode; the full 500-case run is an expansion stage gate rather than a routine draft check.
- Generation and grading may use the same FY model only in isolated contexts. Grading uses temperature zero, no thinking, and structured output.
- Evaluation results snapshot the candidate configuration, selected questions, private answers, grader prompt, model, parameters, policy, and grader version. Direct comparison is limited to identical grader versions, with bridge re-evaluation after changes.
- Model-generated improvement suggestions are advisory. A human edits, reruns evaluation, and publishes; no automatic prompt application or publication is permitted.
- The first release uses one companion persona with minor expression preferences. Familiarity improves continuity but never automatically expands intimacy, jokes, exclusivity, or dependence cues.
- Delivery is divided into three vertical stages: governed default companion runtime; consented memory/profile controls; then quality operations, migration tooling, and metrics.

## Testing Decisions

- Good tests assert externally observable behavior through the highest practical seam and survive internal refactoring. Tests should not reach into private risk helpers, prompt concatenation helpers, or queue implementation details.
- The primary behavioral seam is the Companion Runtime turn interface. Tests inject a controlled clock, deterministic model completion, search behavior, cancellation, and an event collector, then assert emitted events, returned outcomes, and persisted public state.
- The Companion Runtime seam covers ordinary streaming, buffered risk turns, repair, coalescing, idempotency, interruption, search minimization, transparent failures, 未完成回复 exclusion, context filtering, latency measurement, and background-job submission.
- Existing AgentSession behavior receives regression coverage through the current RPC-manager seam. Companion context preparation must not change ordinary coding sessions, tool selection, context files, model restoration, or SSE lifecycle.
- Tenant persistence is tested using the repository’s existing in-memory SQLite pattern. Tests cover migrations, foreign keys, tenant isolation, immutable versions, one assignment per membership, explicit migration, idempotent turns, consent, deletion propagation, retention metadata, and audit events.
- API route tests follow existing route-level prior art and cover authentication, Owner/Admin authorization, Member denial for governance operations, ignored request-body tenant identifiers, SSE ownership, retry semantics, and redaction of internal candidate/repair entries.
- Client conversation tests follow the existing session-hook prior art and cover incremental events, reconnection, stale-event rejection, queued supplements, interrupt behavior, retry, and incomplete markers.
- UI tests follow existing component source and rendering tests. They verify role routing, hidden workspace controls for Members, preserved workspace controls for administrators, AI identity disclosure, large interactive targets, keyboard operation, readable focus states, source expansion, and profile/memory controls.
- Accessibility is a release condition, not a deferred visual enhancement. At minimum, interactive targets, text scale, contrast, keyboard/focus behavior, status announcements, and reduced ambiguity in errors are tested.
- Memory tests cover opt-in default, low-sensitivity receipts, sensitive confirmation, correction, deletion, source propagation, relevance-only recall, and prohibition of transient emotion/personality inference.
- Evaluation tests cover 500-item bank alignment, random quick selection, complete episode selection, structured grading, fatal issues, snapshots, grader-version comparison rules, bridge runs, human calibration counts, and manual-only improvement application.
- Product Evals and internal-trial metrics complement but do not replace executable tests. Evals judge conversational quality; executable tests protect deterministic contracts, safety routing, isolation, persistence, and UI behavior.
- Validation proceeds from narrow tests to type checking, lint, and the full suite. Development validation must not run the prohibited development-time production build command.

## Out of Scope

- Voice input, speech synthesis, calls, avatars, and other multimodal companionship.
- Unsolicited outreach, reminders, push re-engagement, or proactive contact outside an opened conversation.
- Automated contact with relatives, police, emergency services, location services, medical providers, or rescuers.
- A separate administrator application, separate administrator identity system, or duplicate login flow.
- Migrating the standalone project’s PostgreSQL database, participant accounts, or transcript tables.
- Redis, an external message queue, microservices, or provider factories added in anticipation of future scale.
- Custom roles, permission tables, or fine-grained RBAC beyond Owner/Admin/Member.
- Multiple personas, persona marketplace, or Member-selectable companion characters during the internal trial.
- Member selection of model, provider, thinking level, temperature, tools, skills, or system prompt.
- General-purpose browsing, shell, filesystem, code execution, messaging, payment, or other action tools in Companion Runtime.
- Automatic application or publication of model-generated configuration changes.
- A second fixed regression bank in addition to the migrated Evals.
- Per-message suitability feedback and end-of-session “felt understood” UI in the initial release; this may be reconsidered after public launch evidence.
- Production-grade public-launch governance such as broad moderation operations, external incident response, or regulatory workflows beyond the internal-trial baseline.

## Further Notes

- The current workspace already contains extensive uncommitted Tenant, authentication, isolation, and UI work. Stabilize that foundation in a commit or isolated worktree before layering the companion implementation onto it.
- The source project’s “no internet” prompt rule must be deliberately replaced by the bounded 实时信息查询 contract; copying the prompt verbatim would contradict the accepted product behavior.
- The internal trial may use lighter governance than a public product, but 对话底线 remain mandatory and cannot be tenant-edited.
- Trial participants may discuss ordinary real life, but assigned medical, financial, trauma, and risk exercises use fictional details and direct identifiers are prohibited.
- Trial success is measured by baseline safety, specific responsiveness, memory correctness, response latency, and willingness to continue—not conversation length, message volume, or dependence-oriented retention.
- The governing domain language and architectural decisions are recorded in the repository glossary and companion ADRs. Implementations should use those terms and surface any proposed contradiction explicitly.
