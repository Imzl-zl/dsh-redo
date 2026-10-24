# dsh-redo

DSH 插件：编辑/重试已发送的用户消息并重新生成。

## 固定事实（无需每次重新交代）

- **DSH 源码**：`D:\sudy\github\deepseek-harness`（monorepo，pnpm workspace）。
- **运行中的 DSH**：打包版 `D:\soft\DeepSeek Harness\resources\app.asar\dsh\`；Web GUI 端口每次启动都会变，
  以运行时给的 URL 为准，不要把端口写死。
- 本仓库是**外挂插件**，不改上游源码；上游只读引用。
- **测试渠道**：`redo-test` profile 固定走本地 Cherry 免费网关（`http://127.0.0.1:23333/v1`，
  模型 `8497f00c-73d9-4f57-8634-78cb69e0f81a:auto`，key 用凭据里的 `CHERRY_API_KEY`）；测试不要走官方渠道。
- 结论与接入点调研见 [docs/research/2026-10-24-edit-resend-seams.md](docs/research/2026-10-24-edit-resend-seams.md)。

## 不可违背的约束（读源码得出，别再试错）

1. 会话是 **append-only 事件日志**：已落盘的 `user/message` 不能改文本，只能追加一次 **surface replace**（`{op:'replace',startSeq,endSeq}`）遮蔽旧区间。
2. `developer/message` / `system/message` **必须落在已打开的 turn+step 内**且 turn/step 精确匹配，否则重启后 JSONL 读取报 `SessionPersistenceCorruptionError`。`user/message` 无此约束。
3. surface 替换的 `sourceEventSeqs` 必须**完整覆盖**被遮蔽的当前 surface 节点。
4. surface 节点 0 若是 `system/message` 则受保护，只能由 `system/message` 单节点改写。
5. **不存在"无输入的 turn"**：loop 只有 claiming 到非空消息才会发起模型请求；空消息批次直接结束 turn 且不调模型。
6. 原生没有"编辑已发送消息"的 RPC；`updateQueue(edit)` 只作用于**未发送**的队列项，`sessions.fork({atSeq})` 是唯一公开的"回到过去"能力。

## 插件协议（已实现并实测）

两条入口，同一个追加：

- **重新生成**：客户端把目标写进 prompt 的 `requestId`：`redo:<targetSeq>:<uuid>`（每击一次必须换 uuid，Host 会按 rpcId 去重）；`agent/pre-step` 从认领到的消息上读回来。
- **编辑重发**：客户端先调宿主命令 `/redo <seq>` **武装**一个目标（`ctx.commands.register`），再回填 composer；
  用户在 composer 发的那条消息铸自己的 uuid，宿主靠 latch 认领。latch 绑定单个 agent、**只被下一条人类消息
  （`source.kind === 'user'` 且带 rpcId）消费**、5 分钟过期即作废，`/redo off` 可撤销，显式 `redo:` id 永远优先。
- 两者都走：`agent/pre-step` 记计划 → `agent/request` 内追加**空 content 的 `system/message`**，`replace target..surface 尾`。
- 不要换成空 `user/message`（会发给 provider）或空 `developer/message`（时间线多一行空上下文）。
- requestId 里的目标必须按**纯数字**解析（`/^(\d+):/`）。用 `Number()` 会把 `redo::uuid` 读成目标 `0`、
  `0x10` 读成 `16`——畸形 id 于是去改写受保护的头节点，从"无操作"变成宿主抛错。`test/redo.test.ts` 锁着这一条。

## 编辑为什么是「消息上的点击 + 输入框里的发送」

- composer 提交时的 requestId 由 `Session.beginSubmission` 内部铸（`randomUUID()`），`BeginSubmissionInput`
  **不接受**外部注入；prompt 复用的就是这个 id，所以提交那一刻没有钩子能把它换成 `redo:`。
- `inputActions.setDraft(text)` / `addAttachments(ids)` 公开；但 `ids` 只能由
  `ctx.conversation.createDrafts(sessionId, files, uploadImages)` 生成——该方法在导出的
  `ConversationController` 上，**不在** `IConversation` 里，所以客户端做了一次结构性窄转换
  （`ConversationDraftsFace`），失败即禁用按钮而不是静默丢图。
- 采用的通道：`ctx.commands`（宿主命令注册）——客户端点一下 = 调 `/redo <seq>` 武装，用户照常发送。
  纯公开扩展点，不需要 RPC，也不需要改 composer。
- **排除** monkeypatch `beginSubmission`/`prompt`：提交回显 `pendingSubmissions` 是按 requestId 关联退休的，
  换掉 id 会留下永不退休的幽灵气泡。
- **排除** 草稿里埋零宽标记：插件在 composer 序列化路径上没有挂点，标记会原样进 provider。
- 代价（已知、可接受）：时间线会留一条 `/redo <seq>` 命令记录；latch 过期/被别的消息消费是设计内的行为。

## 交互

- 气泡下的操作行按原生顺序：`时间`、`复制`、`重新生成`（原样重发，一键，不经过输入框）、`编辑重发`（回填输入框）。
- `编辑重发` = **武装（`/redo <seq>`）+ 回填**：`inputActions.setDraft(文字)`，图片经 `readAttachment` 读回
  字节 → `File` → `createDrafts` → `addAttachments`。用户在原生 composer 里改完发送即重写。
- 中段重写先在行内确认（「之后的 N 轮对话会离开上下文」）；**输入框本来非空时再问一句是否替换**。
  失效消息由客户端 `[target, replacement)` 区间注册表降级并禁用，不再触发宿主抛错。
- composer 发送带不了 `redo:` 标记，所以区间靠「武装后第一条更新的用户消息就是替换者」补登（与宿主同规则）；
  这张表只在内存里，刷新后 composer 路径的变暗丢失，`redo:` 路径的仍保留。
- 生成期间重发/编辑置灰：不走 queue，避免重发出现在输入框上方的「排队消息」里。
- 图片：存的图走 `session.readAttachment` 重新挂成草稿，不再由插件前端弹窗自己编码；文件块仍不可重发。
- 已知缺口：`InputActions` 上没有 `focus()`（只在 `SessionInput` 上），回填后不会自动把焦点交给 composer。

## 命令

```sh
npm install
npm test            # node --test：宿主半不变式，直接跑 TS 源码，不需要构建
npm run build       # lib/index.js + lib/client.js
npm run typecheck
node scripts/dump-session.mjs <session.v4.jsonl.zstd>   # 解码会话日志
```

上游源码仍**未安装依赖**；需要跑上游测试时才 `pnpm install`。

## 已验证

**自动化**：`npm test`（18 项，`test/redo.test.ts`）锁着宿主半的不变式——turn+step 精确、`sourceEventSeqs`
全覆盖被遮蔽的 surface 尾、节点 0 拒改、计划只消费一次、非用户/失效消息报错、畸形 requestId 不重写；
命令路线覆盖武装→下一条人类消息重写、只消费一次、工具步不消费、TTL 过期作废、`/redo off`、显式重发优先、
非法参数/目标被拒。改 `src/index.ts` 前先跑它。变异检验两次（收窄 `endSeq` / 少一个 `sourceEventSeqs` 节点 /
去掉 TTL 判断）都能立刻变红。

**手工（composer 路径已真机验证）**：packaged 0.2.1-rc.2 GUI + `redo-test` profile + 本地 Cherry 网关，
2026-10-24 20:1x 实测三条路径：

| 路径 | GUI 表现 | JSONL 证据 |
| --- | --- | --- |
| 编辑重发（文字） | 确认行「内容会放回输入框；发送后，之后的 1 轮对话会离开上下文」→ composer 出现原文 → 改后发送 → 旧两条变暗标「已被替换」、新条标「已重发」 | `system/message replace 8..26 src=[8,12,18,25,26] content=0` 紧跟 `user/message append` |
| 编辑重发（图片） | 粘贴红图发送 → 模型答「红色」；点编辑重发 → composer 同时回填文字 + 图片草稿；改文字再发 → 变暗/已重发正确，模型答「红」 | `replace 57..59 src=[57,59] content=0` + 新 `user/message` 带 `<image>` |
| 重新生成 | 一键重发，不经输入框 | `replace 69..71` + 新 `user/message` `rpc=redo:69:…` |

上下文确实被重写：重写后追问「你现在能看到的用户消息一共几条」，模型答 **2**（不是 4），并确认看不到被丢弃的那条。
时间线出现一张 `redo 已完成` 命令卡（预期内）。重启实例后冷读该会话正常，**无 `SessionPersistenceCorruptionError`**，
4 轮全部渲染——同时也确认了文档里那条限制：刷新后 composer 路径的变暗标记消失（`redo:` 路径的保留）。

`/redo off` 只在单测里覆盖，GUI 里没有入口（没有取消按钮），符合当前设计。
