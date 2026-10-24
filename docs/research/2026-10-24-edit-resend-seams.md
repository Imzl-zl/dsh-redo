# DSH 原生接入点调研：编辑/重试已发送的用户消息

日期：2026-10-24
源码：`D:\sudy\github\deepseek-harness`（下文路径均相对于该目录）

## 1. 结论

**原生没有「编辑已发送消息并重发」的接口，但这块地是产品主动空出来的，底层机制齐全。**

- 只支持编辑**还没发出去**的队列项：`SessionCommandController.updateQueue` 的 `edit` 分支
  （`packages/api/session-controller/src/commands.ts:418`、`:467`）。
- 用户气泡上的「编辑」按钮**曾经做过又被删掉**，删的理由写得很明确：
  `.agents/notes/archived/simplification/2026-07-31-drop-user-message-edit-stub.md`
  「Reintroduce the control together with the capability: a client mutation that edits a settled user
  message and the host behavior that decides what the edited message does to the turn that already
  consumed it.」
- 同一位置还留了另一句话（`2026-08-06-user-bubbles-drop-the-branch-action.md`）：
  「re-asking from one's own prompt needs a cut before the message plus composer prefill, a different
  Host operation.」
- 客户端模型里甚至预埋了 `ConversationContextOriginKind = 'compaction' | 'rewind' | 'rewrite'`
  （`packages/client/ui-chat/src/client/model/conversation-context.ts:6`），当前没有生产者使用 `rewind`。

也就是说：**原生缺的是「一个把 rewind 暴露给 UI 的入口」，不是机制。**

## 2. 原生已有的能力清单

| 能力 | 接口 | 位置 | 够不够 |
|---|---|---|---|
| 编辑未发送的队列项 | `updateQueue({action:{kind:'edit'}})` | `packages/api/session-controller/src/commands.ts:418` | 只解决"发早了想改"，不解决已发送 |
| 从任意 seq 分叉出新会话 | `ctx.sessions.fork({sessionId, atSeq})` → `SessionCommandController.fork` | 同上 `:227`；客户端封装 `packages/client/ui-workspace/src/client/navigation.ts:307` | 唯一公开的"回到过去"，但产出**新会话** |
| 改写/截断模型上下文 | `SurfaceOp = {op:'replace', startSeq, endSeq}` | `packages/core/session/src/types.ts:463`；折叠 `packages/core/session/src/surface.ts:594` | **核心机制**，日志级、可持久化、有校验 |
| 从日志重建请求 | `session.deriveMessages()`（每步重算） | `packages/core/session/src/index.ts:984`；loop 调用 `packages/core/agent-loop/src/agent.ts:688` | 替换后下一次请求自动用新上下文 |
| 替换后自动开新序列 | `requestSurfaceGeneration !== surface.contentGeneration` → `request/header(reason:'series')` | `packages/core/agent-loop/src/agent.ts:419`、`:632` | 缓存语义自动处理，不用插件操心 |
| 请求失败重试（同 turn 窗口内） | `agent/request-error` 返回 `{kind:'retry'}` | `packages/core/agent/src/runtime-types.ts:337` | 只在失败未收尾时有效；`turn/end` 之后无入口 |
| 进入模型调用前拦截/改写输入 | `agent/pre-step` waterfall（可 reject / 换 messages） | `packages/core/agent/src/runtime-types.ts:320` | 可改 claimed 消息，也可在此做宿主侧动作 |
| 每步请求前拦截 | `agent/request` waterfall | 同上 `:337`；时机 `packages/core/agent-loop/src/agent.ts:410` | **已经 `step/start` 打开之后**，`buildRequest` 之前 |
| 空闲期串行维护 | `agent.runMaintenance(fn)` | `packages/core/agent/src/runtime-types.ts:202` | compaction 手动路径用它 |
| 客户端 UI 扩展 | slots：`conversation.chat.node`(keyed) / `conversation.chat.user.content` / `conversation.chat.assistant-actions` | `packages/client/ui-chat/src/client/contract/slots.ts:402`、`:374`、`:441` | 用户气泡没有 actions 槽，但可以整体接管 keyed `user` 渲染器并复用 `user.content` 工厂 |
| 客户端会话能力 | `ISession.prompt(content, 'queue', signal, requestId)`、`beginSubmission`、`command(line)`、`updateQueue` | `packages/api/session-controller/src/client/contract/session.ts:87`、`:147` | 发消息 / 调命令都有公开面 |
| 宿主侧 RPC 扩展 | `TypertRemoteService` + `@Remote` | `docs/cookbook/adding-a-remote-api.md` | 需要跑 typert 代码生成，外挂包成本较高 |

现成的同类实现可当模板：

- 原位改单个节点：`packages/core/agent-loop/src/runtime-context.ts:105`
  （`{op:'replace', startSeq: seq, endSeq: seq}` + `sourceEventSeqs:[seq]`）。
- 区域替换（把一段历史换成一个节点）：`packages/compaction/compaction-basic/src/region.ts:507`。
- pre-step 里改写即将进入 step 的消息：`packages/context/session-reference/src/index.ts:138`。
- 命令注册：`packages/compaction/command-compact/src/index.ts:101`。

## 3. 三条可行路线

### 路线 A：纯客户端 + fork（不碰宿主，零代码生成）

1. 用户在用户气泡上点「编辑重发」，客户端拿到该 `user` 节点 `data.seq`（`ChatNodeOwnerProps.forkAt(seq)` 已证明节点带 seq）。
2. `ctx.sessions.fork({ sessionId, atSeq: seq - 1 })` —— 现有 API，`packages/client/ui-chat/src/client/apply.ts:285` 就是这么用的。
3. `ctx.uiWorkspace.openSession(childId)` 打开子会话。
4. `inputActions.setDraft(原文)` 预填输入框（`packages/client/ui-conversation/src/client/contract/input.ts:186`、`:258`）。
5. 用户改完手动发送（或插件直接 `prompt`）。

优点：零宿主改动、零持久化风险、与现有 branch 交互一致。
缺点：**新会话**；父会话里旧消息和旧回答原样留着；切在 turn 前会得到一个被 `{kind:'forked'}` 收尾的空 turn；不合"原地重发"的心理预期。

### 路线 B：原位 rewind（推荐）——`agent/pre-step` + `agent/request` 两段式

目标模型上下文：`[… target 之前的历史 …] + [编辑后的文本]`，旧尾巴从 surface 上被遮蔽掉，日志仍保留全部原件。

关键难点与解法（都已从源码验证）：

1. **必须让 loop 发一次模型请求**，而 loop 只在 claim 到**非空**消息时才进入 step
   （`agent.ts:326`：`phase.step === 0 && decision.messages.length === 0` 直接结束 turn）。
   → 所以编辑后的文本必须走正常 prompt（被 loop 以 `surfaceOp:'append'` 落盘），不能"只靠替换节点当输入"。
2. **必须有一个"不产生任何模型消息"的替换节点**来吃掉被截断的整段尾巴。
   `deriveEventMessage`（`surface.ts:138`）对**空 content 的 `developer/message` / `system/message`** 返回 `null`；`user/message` 无条件投影，所以不能用空的 user 消息（会向 provider 发空消息）。
3. **空 `developer/message` 必须写在已打开的 step 内**：
   `STEP_EVENT_TYPES`（`packages/session/session-format-v3-to-v4/src/relationships.ts:8`）+ `requireStep`（`:85`）；
   `packages/session/session-persistence-jsonl/tests/native-developer-admission.spec.ts:102` 明确证明
   **step 不匹配 → 重启读取 → `SessionPersistenceCorruptionError`**。
   → 因此不能在 `turn/end` 和下一个 `turn/start` 之间的空闲期写（`user/message` 可以，`developer/system` 不行）。
4. **`agent/request` 是唯一"step 已打开、请求尚未构建"的公开钩子**：
   `agent.ts:331` 先 `step/start`，`:410` 才走 `prepareRequest`（`agent/request` waterfall 在这里面），
   `:416` 提交 system 节点，`:434` 落 claimed 消息，`:688` 才 `deriveMessages()`。
   在 `agent/request` 里写空 developer 替换节点，坐标用 payload 里的 `{turn, step}`，天然合法。

于是两段式：

- `agent/pre-step`：认出"这是一次 rewind 请求"（见下文标记通道），把目标 seq + turn/step 记到插件私有 Map，
  并返回 `{kind:'enter', messages: 清洗后的消息}`（把客户端标记从 durability 里抹掉）。
- `agent/request`：命中同一 turn/step 时，取一次（一次性）执行：
  ```ts
  const nodes = [...agent.session.surface.nodes]
  const start = nodes.indexOf(SessionSeq(target))
  const shadowed = nodes.slice(start)                       // target..surface 尾
  agent.session.append('developer/message', {
    turn, step,
    message: createDeveloperMessage({ content: [], source: { kind: 'redo' } }),
  } as never, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0]!, endSeq: shadowed.at(-1)! },
    sourceEventSeqs: shadowed,                              // 必须覆盖全部被遮蔽节点
  })
  ```
  之后 loop 自己会：`startsSeries=true` → 写 `request/header(reason:'series')` → `deriveMessages()` 得到
  `[… target 之前 …, 编辑后的文本]` → 发请求。**插件不需要动 loop、不需要 runMaintenance、不需要新 RPC。**

标记通道（客户端 → 宿主）不用生成 typert 代码：

- 客户端 `session.prompt(content, 'queue', signal, requestId)` 的 `requestId` 是**不透明 branded string**
  （`packages/api/session-controller/src/types.ts:409`；客户端只在缺失时 `randomUUID()`
  `packages/api/session-controller/src/client/sessions/session.ts:272`）。
- 客户端传 `redo:<targetSeq>:<uuid>`；宿主 `prompt` 把它原样记进 `source: {kind:'user', rpcId}`
  （`commands.ts:319`），`agent/pre-step` 读得到，清洗后落盘的就是干净消息。
- 注意：这条路要直接用 `prompt()`，不要走 `beginSubmission()`（它自造 requestId）。

客户端 UI 侧：

- 用户气泡没有 actions 槽（`MessageIconActions` 只给 copy/branch/clock，`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:91`）。
  → 注册 keyed `conversation.chat.node` 的 `user` 单元整体接管，内部用 `renderFactorySlot('conversation.chat.user.content', …)`
  复用官方气泡（`MessageItem.tsx:203` 就是同样调用），只是多一个「编辑重发」按钮。
- 宿主写的空 developer 标记在 `chat` 视图会被官方 `developerMessageDefinition` 认领成一条空 context 行
  （`packages/client/ui-chat/src/client/conversation-nodes/message.ts:134`）。
  → 插件注册自己的 definition，`match` 只命中 `source.kind === 'redo'` 并返回 `exclusive: true`；
  排他声明会让非排他的官方 definition 跳过该事件（`assembler.ts:519`、`:542`），
  再把这个 kind 注册成"无渲染器"或渲染成一条「已按此消息重发」分隔条。

优点：真·原地重发，旧消息与旧回答仍在（append-only 语义诚实呈现），支持"渠道失败后改一句再发"。
缺点：要写双半（host + client）插件；两段式要处理一次性状态与异常清理（turn 没走到 `agent/request` 时清 stash）。

### 路线 C：宿主 `@Remote` 端点

新建 `TypertRemoteService`，暴露 `redo(sessionId, targetSeq, text)`，客户端 `ctx.remote.redo.redo(...)`。
契约最干净，但要走 `@Remote` + typert 代码生成（`docs/cookbook/adding-a-remote-api.md` 第 3 步），
外挂包比路线 B 多一层构建复杂度；而且**操作本身仍然要在 `agent/request` 里落节点**（因为约束 3/4），
并不能省掉路线 B 的核心难点。

## 4. 硬约束速查（踩了就是数据损坏）

1. append-only：已发送消息的"编辑"只能是「追加替换 + 追加新消息」，UI 上表现为旧消息留痕、新消息在下。
2. `developer/message`、`system/message` 必须 turn+step 精确匹配当前打开的 step；否则重启后该会话读不出来。
   空 content 的 `developer/message` 是目前唯一"合法且不投影"的遮蔽节点。
3. `sourceEventSeqs` 必须完整包含被遮蔽的当前 surface 节点（`surface.ts:330`、`:361`）。
4. surface 节点 0 是 system 时受保护，只能用 `system/message` 单节点改写（`surface.ts:493`）——rewind 起点必须 ≥ 第一条用户消息。
5. 没有"无输入 turn"：不能靠"替换成编辑后的消息 + 空唤醒"来省掉一次 prompt。
6. 同一 `requestId` 会被 `hasPromptRequest` 去重（`commands.ts:584`），每次点击要用新 id。

## 5. 实测结论（0.2.1-rc.2 打包版 GUI，2026-10-24）

已按路线 B 做成插件并跑通，实测证据：

1. 发「记住暗号：GAMMA」→ OK；用插件编辑重发为「DELTA」。
2. 追问「一共发过几条用户消息？逐条列出」→ 模型只列出 **2 条**（DELTA + 追问），GAMMA 已离开上下文。
3. 会话 JSONL 实际事件：
   ```
   27 system/message  replace 8..20  src=[8..12,20]  content=0
   28 user/message    append   source.rpcId = redo:8:…
   30 request/header  reason=series
   ```
   注意持久化层会把 `sourceEventSeqs` 压成区间形式（`[[8,12],20]`），读回时展开。
4. 杀掉服务端重启 → 冷读该会话正常打开，无 `SessionPersistenceCorruptionError`。

补充事实：
- 带 workspace 的会话才落 JSONL；无 workspace 的新会话是内存态（测试时踩过）。
- 空 `system/message` 在 `chat` 视图不渲染：`systemMessageDefinition.buildViewNode` 对 `surfaceOp !== 'append'` 直接返回 null。
- `ui-slots` 的 keyed 单元同 key 同 priority 会冲突，替换内置渲染器要显式给更低 priority（本插件用 -10）。
- 外挂包 `@deepseek-ai/*` 运行时零 import 是可行的：宿主半手搓消息对象，类型只用 `import type`；浏览器半只 `require` react。
  这样 profile 里不会出现第二份 `dsh-session` 实例。

## 6. 推荐

先按**路线 B** 做主路径（真正的原地编辑重发），**路线 A** 作为兜底/降级（宿主半未加载时按钮改为"分叉并预填"）。
不建议为这个功能去改上游源码：产品注记已经把座位留好了，缺的只是这个插件。

## 7. 补记（2026-10-24 晚）：路线 B 落地后又加了一条「命令武装」

路线 B 的编辑入口原来是一个插件自己的模态弹窗。想让它变成 Codex 那种「内容回到输入框」时，撞上两条硬事实：

1. composer 提交时的 `requestId` 由 `Session.beginSubmission` 内部 `randomUUID()` 铸
   （`packages/api/session-controller/src/client/sessions/session.ts:229`），`BeginSubmissionInput` 没有
   requestId 字段，prompt 复用的就是这个 id —— 提交那一刻没有钩子能把 id 换成 `redo:`。
2. `CommandResult` 只有 `success` / `error`（`packages/interaction/commands/src/types.ts:34`），
   命令处理器不能替用户发 prompt。

同时确认了两条排除项：

- `agent/pre-step` 允许返回 `{kind:'enter', messages}` 替换认领到的消息（`packages/core/agent-loop/src/agent.ts:289`），
  理论上可以改写 `source.rpcId` 给 composer 的发送盖上 `redo:`——但提交回显
  `pendingSubmissions` 是按 requestId 关联退休的，换掉 id 就留下永不退休的幽灵气泡，**不做**。
- 零宽标记：插件在 composer 序列化路径上没有挂点，标记会原样进 provider，**不做**。

最终采用 **`ctx.commands` 武装**：客户端点「编辑重发」→ `session.command('/redo <seq>')` 让宿主记一个
latch（绑 agent、只被下一条人类消息消费、5 分钟 TTL、`/redo off` 撤销、显式 `redo:` 优先）→ 再
`setDraft` + `createDrafts`/`addAttachments` 回填 composer → 用户正常发送，宿主在 `agent/pre-step` 消费 latch。
纯公开扩展点，不需要 RPC，不改上游。代价是时间线留一条命令记录，且 composer 路径的变暗区间靠客户端
「武装后第一条更新的用户消息」补登（刷新后丢失，视觉层面）。
