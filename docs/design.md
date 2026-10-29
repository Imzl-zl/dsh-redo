# dsh-redo 设计与实现

面向要改这个插件的人。用户文档见 [README](../README.md)。

## 约束

会话是**只追加**的事件日志：已落盘的消息不能改，只能追加一条 `surfaceOp: { op: 'replace', startSeq, endSeq }`
遮蔽旧区间。替换节点必须是消息事件，而消息事件要么带 `turn`/`step`（`system/message`、`developer/message`、
`assistant/message`、`tool/result`），要么会投影成一条模型消息（`user/message`），所以替换总得住在某一轮里。

**轮（turn）由宿主独占**：loop 的编号来自它自己的计数器（`agent-loop/src/agent.ts` `phase.turn + 1`），
只在创建 agent 时从日志折叠取一次（`agent-loop/src/index.ts`）。插件自己写 `turn/start` 不会推进那个计数器，
loop 的下一次轮次会复用同一个号，冷读直接报 `turn/start does not open the expected turn` —— 2026-10-29
就是这样毁掉一份 3700 事件的会话。**因此插件不开任何 turn。**

## 宿主半（`src/index.ts`）

两条入口，同一个追加：

1. **编辑 = 登记**：`/redo <seq>` 只校验目标并记下它（`armed`），**一个事件都不写**。TTL 5 分钟。
2. **发送 = 替换**：`agent/pre-step` 认领到一条人类消息时消费登记（无论是否过期都消费，过期的直接丢弃），
   `agent/request` 在 loop 已打开的 step 里写 `system/message`（空 content，`replace target..surface 尾`）。

`agent/request` 是唯一合法的写入点：step 已打开（坐标齐全），而这次发送的用户消息**尚未落盘**——
替换的 `endSeq` 只覆盖旧内容，新消息随后追加并成为新的表面头。

重试走同一条通道，只是目标来自 prompt 的 `requestId`：`redo:<seq>:<uuid>`（每次必须换 uuid，Host 按 rpcId 去重）。
requestId 里的目标按纯数字解析（`/^(\d+):/`）；`Number()` 会把 `redo::uuid` 读成 0（受保护的头节点）。

替换节点必须是**空 `system/message`**：唯一同时满足「不产生模型消息」和「时间线不渲染」的类型。空 `user/message`
会被 `deriveEventMessage` 原样投影给 provider；空 `developer/message` 会多一行空上下文。

`sourceEventSeqs` 必须覆盖每一个被遮蔽的 surface 节点，否则上游校验器拒绝整份会话。

## 浏览器半（`src/client/index.tsx`）

- 接管 keyed `conversation.chat.node` 的 `user` 单元；气泡本体仍用官方 `conversation.chat.user.content` 工厂。
- 点击编辑：调 `/redo`（读 `commands.execute` 的完整结果，`result.kind === 'error'` 就报错、不回填）→
  `setDraft(text)` → 图片经 `readAttachment` → `File` → `createDrafts` → `addAttachments`。
- **本地隐藏**：替换要到发送才落盘，所以点击后先把目标记进 `PENDING`（TTL 5 分钟）并通知行重渲染；
  事件窗口一旦出现覆盖它的 `replace`，本地标记删除、隐藏交给日志（刷新后依然隐藏）。
  过期未发送则标记失效，消息重新出现。
- 隐藏的是**整轮**：插件只接管 `user` 单元，回答/工具卡/用量行由官方 cell 渲染，所以被遮蔽的行挂载后
  会把所在 Turn 的容器行（`data-chat-turn`）一并隐藏，`MutationObserver` 补上晚到的行。
- 区间不靠客户端记账：从会话自己的事件窗口（`binding.eventSource`）读 `surface replace` 反推
  （`src/client/intervals.ts`，纯函数，`test/intervals.test.ts` 锁它）。

## 验证

**自动化**：`npm test`（30 项，直接跑 TS 源码）。

- `test/redo.test.ts`（15 项）：命令只登记、不写事件；替换落在 loop 的 turn/step；`sourceEventSeqs` 全覆盖；
  登记只驱动一次发送、过期不生效、`off`/销毁清空、注入 context 不消费；重试压过登记、畸形 id 不重写、
  plan 按 step 作用域只消费一次；各类拒绝不碰日志；整条日志交上游 `assertReleasedV4Relationships` 冷读。
- `test/intervals.test.ts`（9 项）：区间推导与「只有 replace 没有 user 的 turn」识别。
- `test/command-run.test.ts`（6 项）：命令结果 → 是否回填的映射，其中两项驱动真实 `/redo` handler。

变异检验（每一种都会让测试变红）：TTL 永不失效、去掉 step 作用域、`sourceEventSeqs` 少一个节点、
把 handler 的 `error` 当成功。

**手工**（packaged GUI + `redo-test` profile + 本地 Cherry 网关）：

- 点击「编辑重发」：消息立刻消失、composer 拿到原文，日志只有 `command/run` + `command/done`。
- 发送：日志是 `turn/start`(loop) → `step/start` → `replace a..b` → 新 `user/message` → 回答；
  画面只剩一条消息，刷新后仍是这一条。

## 排障

```sh
node scripts/dump-session.mjs <session.v4.jsonl.zstd>   # 解码一份会话
node scripts/check-sessions.mjs <目录或文件>             # 用上游 V4 校验器逐份冷读，报第一处坏事件
```
