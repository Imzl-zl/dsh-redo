# dsh-redo

DSH 插件：编辑/重试已发送的用户消息并重新生成。

## 固定事实（无需每次重新交代）

- **DSH 源码**：`D:\sudy\github\deepseek-harness`（monorepo，pnpm workspace）。
- **运行中的 DSH**：打包版 `D:\soft\DeepSeek Harness\resources\app.asar\dsh\`；Web GUI 端口每次启动都会变，
  以运行时给的 URL 为准，不要把端口写死。
- 本仓库是**外挂插件**，不改上游源码；上游只读引用。
- **已发布 npm**：`dsh-redo`（无 scope，公开，账号 `imzl`）。**发版只走 tag 驱动的 CI**，见下文「发版」。
  紧急情况下的手工发布事实（踩过一次，别重复踩）：npm 对新包首发用**暂存发布**，先落 `0.0.0-stage`
  占位、真版本进审核、几分钟后自动成为 `latest`；`npm publish` 要求 2FA 时给的网页链接会被 npm
  打成 `***`，所以只能网页建临时 granular token 并用 `--//registry.npmjs.org/:_authToken=…` 传入
  （`NODE_AUTH_TOKEN` 会被 `~/.npmrc` 的 web token 盖掉），发完**立刻在网页删掉**。
- **测试渠道**：`redo-test` profile 固定走本地 Cherry 免费网关（`http://127.0.0.1:23333/v1`，
  模型 `8497f00c-73d9-4f57-8634-78cb69e0f81a:auto`，key 用凭据里的 `CHERRY_API_KEY`）；测试不要走官方渠道。
- **`redo-test\node_modules\dsh-redo` 必须是指向本仓库的链接**（junction / `link:`），不能是克隆或拷贝：
  宿主只从 profile 的 `node_modules` 解析插件，一份克隆会停在"装的那天"，改完代码也不生效——2026-10-29
  就因为那里是一份 10/26 的克隆，把"改完了"误当成"隔离实例里生效了"。宿主加载的是 `lib/`，所以链接后仍要
  `npm run build`。`desktop` 那份是 npm tarball 拷贝，属于发布形态，不要当开发入口。
- 结论与接入点调研见 [docs/research/2026-10-24-edit-resend-seams.md](docs/research/2026-10-24-edit-resend-seams.md)；
  面向人的设计与验证说明在 [docs/design.md](docs/design.md)，README 只放安装与用法。

## 不可违背的约束（读源码得出，别再试错）

1. 会话是 **append-only 事件日志**：已落盘的 `user/message` 不能改文本，只能追加一次 **surface replace**（`{op:'replace',startSeq,endSeq}`）遮蔽旧区间。
2. `developer/message` / `system/message` **必须落在已打开的 turn+step 内**且 turn/step 精确匹配，否则重启后 JSONL 读取报 `SessionPersistenceCorruptionError`。`user/message` 无此约束。
3. surface 替换的 `sourceEventSeqs` 必须**完整覆盖**被遮蔽的当前 surface 节点。
4. surface 节点 0 若是 `system/message` 则受保护，只能由 `system/message` 单节点改写。
5. **不存在"无输入的 turn"**：loop 只有 claiming 到非空消息才会发起模型请求；空消息批次直接结束 turn 且不调模型。
6. 原生没有"编辑已发送消息"的 RPC；`updateQueue(edit)` 只作用于**未发送**的队列项，`sessions.fork({atSeq})` 是唯一公开的"回到过去"能力。
7. **turn 边界归宿主，插件一律不许自己开 turn**：`turn/start` 只能在**没有未关闭 turn** 时开，且编号必须等于"已关闭
   turn 数 + 1"，否则冷读报 `SessionFormatError: turn/start does not open the expected turn`。loop 的编号来自它自己的
   计数器（`agent-loop/src/agent.ts:329` `phase.turn + 1`），只在创建 agent 时从日志折叠取一次
   （`agent-loop/src/index.ts:569`）——插件插进去的 turn 它看不见，下一次轮次必然复用同一个号并把会话写坏
   （2026-10-29 就这样毁了一份 3700 事件的会话）。撤回只能写在 loop 已打开的 step 里（`agent/request`），
   编号天然一致。

## 插件协议（已实现并实测）

两条入口，同一个追加，**都不开 turn**：

- **编辑＝登记 + 发送时替换**：客户端调宿主命令 `/redo <seq>`，命令**只登记**目标（一个事件都不写），
  客户端立刻把那条消息从界面隐藏、原文回填 composer。用户发送时，`agent/pre-step` 认领到这条人类消息
  就消费登记（含过期判断），`agent/request` 在 loop 已打开的 step 里写
  `system/message(replace target..surface 尾)`；新的用户消息在这之后落盘，所以不会被遮蔽。
- **重新生成**：客户端把目标写进 prompt 的 `requestId`：`redo:<targetSeq>:<uuid>`（每击一次必须换 uuid，Host 会按 rpcId 去重）；
  `agent/pre-step` 从认领到的消息上读回来，`agent/request` 在已打开的 step 内写同样的替换。
- 替换节点是**空 content 的 `system/message`**，节点 0 之外都能改；不要换成空 `user/message`（`deriveEventMessage`
  对 user 直接返回 `event.data`，空内容照样发给 provider）或空 `developer/message`（时间线多一行空上下文）。
- requestId 里的目标必须按**纯数字**解析（`/^(\d+):/`）。用 `Number()` 会把 `redo::uuid` 读成目标 `0`、
  `0x10` 读成 `16`——畸形 id 于是去改写受保护的头节点，从"无操作"变成宿主抛错。`test/redo.test.ts` 锁着这一条。
- 登记是**有破坏性的状态**：过期的登记不能改写一条无关的消息，所以 `ARM_TTL_MS`（5 分钟）兜底，且**无论是否过期
  都消费掉**。客户端本地隐藏用同一个 TTL；日志里的替换一旦落盘，隐藏改由事件窗口接管。
- 为什么写入点必须是 `agent/request`：它是 step 已打开、而这次发送的用户消息**尚未落盘**的唯一时刻——
  早了没有 step 坐标，晚了新的消息会被一起遮蔽。

## 编辑为什么是「消息上的点击 + 输入框里的发送」

- composer 提交时的 requestId 由 `Session.beginSubmission` 内部铸（`randomUUID()`），`BeginSubmissionInput`
  **不接受**外部注入；prompt 复用的就是这个 id，所以提交那一刻没有钩子能把它换成 `redo:`。
- `inputActions.setDraft(text)` / `addAttachments(ids)` 公开；但 `ids` 只能由
  `ctx.conversation.createDrafts(sessionId, files, uploadImages)` 生成——该方法在导出的
  `ConversationController` 上，**不在** `IConversation` 里，所以客户端做了一次结构性窄转换
  （`ConversationDraftsFace`），失败即禁用按钮而不是静默丢图。
- 采用的通道：`ctx.commands`（宿主命令注册）——客户端点一下 = 调 `/redo <seq>` **登记**，立刻本地隐藏该行、
  把内容回填 composer；替换由 `agent/request` 在发送那一轮里写。纯公开扩展点，不需要 RPC，也不需要改 composer。
- **排除** monkeypatch `beginSubmission`/`prompt`：提交回显 `pendingSubmissions` 是按 requestId 关联退休的，
  换掉 id 会留下永不退休的幽灵气泡。
- **排除** 草稿里埋零宽标记：插件在 composer 序列化路径上没有挂点，标记会原样进 provider。
- 代价（已知、可接受）：撤回时时间线会多一条 `/redo <seq>` 命令记录，替换落盘后它跟着被撤回的那段一起隐藏。

## 交互

- 气泡下的操作行按原生顺序：`时间`、`复制`、`重新生成`（原样重发，一键，不经过输入框）、`编辑重发`（回填输入框）。
- `编辑重发` = **登记 + 回填 + 发送时替换**：先调 `/redo <seq>`（宿主只记下目标，一个事件都不写），客户端立刻把
  该行隐藏，再把文字经 `inputActions.setDraft` 放回 composer、图片经 `readAttachment` → `File` → `createDrafts`
  → `addAttachments` 挂成草稿。用户改完发送的是**普通消息**，替换在发送那一轮里落盘。
  图片仍要在调命令**之前**读回：登记失败就不该动 composer。
- **本地隐藏有到期时间**：登记 5 分钟不用就作废，客户端本地隐藏跟着失效、消息重新出现——因为日志里确实还没撤。
  替换落盘后，隐藏改由事件窗口（`surface replace`）接管，刷新也不会回来。
- 中段撤回先在行内确认（「之后的 N 轮对话会离开上下文」）；**输入框本来非空时再问一句是否替换**。
- **被撤回的那一轮整轮从时间线撤掉**，不是变暗：消息、回答、工具卡、过程行、用量行一起消失。只变暗会让它
  读起来像「又发了一遍」，正是插件要避免的效果。
- 撤掉靠两层：插件自己的 `user` cell（被遮蔽就渲染空 div），加上挂载后按 `data-chat-turn` 隐藏**整个 Turn**
  ——回答/工具卡/用量行是官方 cell 渲染的，插件碰不到它们的组件。`MutationObserver` 负责补上晚到的行
  （撤回 turn 的用量行在 turn 关闭后才渲染）。
- **撤回自己也要藏（旧版遗留）**：0.3.x 的命令会自己开一个只装替换的 turn，flow 会给它渲染一行空的「已完成」，
  所以有了 `deriveRetractionTurns`。0.4 起插件不再开 turn，这个派生**恒为空**；保留它是为了任何以后在 turn 里
  写替换的路径，并在测试里锁住「只有 replace 没有 user 的 turn」这条识别规则。
- 区间和撤回 turn **都不靠客户端记账**：都用会话自己的事件窗口（`binding.eventSource`）里的
  `surfaceOp: replace` 与 turn 边界反推（`src/client/intervals.ts`）。刷新后依然撤掉，没有 localStorage。
- 命令卡是 log-only 事件，seq 落在 replace 区间的**外面**（区间端点是 surface 节点的 seq），所以不能用
  seq 判断，只能看它撤回的目标。
- 生成期间重发/编辑置灰：不走 queue，避免重发出现在输入框上方的「排队消息」里。
- 图片：存的图走 `session.readAttachment` 重新挂成草稿，不再由插件前端弹窗自己编码；文件块仍不可重发。
- 已知缺口：`InputActions` 上没有 `focus()`（只在 `SessionInput` 上），回填后不会自动把焦点交给 composer。

## 命令

```sh
npm install
npm test            # node --test：宿主半不变式，直接跑 TS 源码，不需要构建
npm run build       # lib/index.js + lib/client.js
npm run typecheck
node scripts/dump-session.mjs <session.v4.jsonl.zstd>            # 解码会话日志
node scripts/check-sessions.mjs <会话目录或文件>                  # 用上游 V4 校验器逐份冷读，报第一处坏事件
```

上游源码仍**未安装依赖**；需要跑上游测试时才 `pnpm install`。

## 发版（规范化流程，别再用临时 token）

1. 改 `CHANGELOG.md`：把 `## [Unreleased]` 里的内容整理好（Keep a Changelog 格式，**每个版本标注对应的
   DSH 版本**，因为本插件没有兼容垫片）。
2. `npm version patch|minor|major` —— `preversion` 会先跑 `typecheck + test`，然后改版本号并打 `vX.Y.Z` tag。
3. 把 CHANGELOG 的 `Unreleased` 段落改成刚发布的版本号（连同底部的 compare 链接），提交。
4. `git push --follow-tags`。
5. `.github/workflows/release.yml` 用 **npm trusted publishing（OIDC）** 发布并附 provenance：
   它先核对 tag 与 `package.json` 一致、`npm pack --dry-run` 看产物，再 `npm publish --provenance`。
   仓库里**不存任何 token**。

**这个工作流文件被 npm 侧的 trusted publisher 按路径绑定**（org `Imzl-zl`、repo `dsh-redo`、
workflow `release.yml`）。重命名/移动它必须在 npmjs.com 的包设置里同步改，否则发布 403。
首次配置那一次需要网页端 2FA，属于一次性的。

## 已验证

自动化 `npm test` 30 项（宿主 15 / 区间推导 9 / 回填判定 6），跑在 TS 源码上，不需要构建；
CI 依次跑 `typecheck` → `test` → `build`。变异检验与手工验证记录见
[docs/design.md](docs/design.md#验证)。

