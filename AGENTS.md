# dsh-redo

DSH 插件：编辑/重试已发送的用户消息并重新生成。

## 固定事实（无需每次重新交代）

- **DSH 源码**：`D:\sudy\github\deepseek-harness`（monorepo，pnpm workspace）。
- **运行中的 DSH**：打包版 `D:\soft\DeepSeek Harness\resources\app.asar\dsh\`，Web GUI `http://127.0.0.1:62986`。
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

- 客户端把重发目标写进 prompt 的 `requestId`：`redo:<targetSeq>:<uuid>`（每击一次必须换 uuid，Host 会按 rpcId 去重）。
- 宿主 `agent/pre-step` 认领、`agent/request` 内追加**空 content 的 `system/message`**，`replace target..surface 尾`。
- 不要换成空 `user/message`（会发给 provider）或空 `developer/message`（时间线多一行空上下文）。

## 为什么编辑入口在消息上，不在输入框

- `inputActions.setDraft(text)` 公开；但图片附件要 `inputActions.addAttachments(ids)`，`ids` 只能由
  `ctx.conversation.createDrafts(sessionId, files)` 生成——该方法在导出的 `ConversationController` 上，
  **不在** `IConversation`（`ctx.conversation` 的类型面）里。
- composer 提交链路无插件钩子：`resolveSubmitMode` 只决定 queue/steer，requestId 由 `beginSubmission` 铸。
  内容回到输入框再发送 = 普通新消息，不会触发 rewind。
- 结论：要"撤回输入框"只能强转内部方法 + 草稿里埋不可见标记（或 slash command 武装），默认不做。

## 交互

- 气泡下的操作行按原生顺序：`时间`、`复制`、`重新生成`（原样重发，成功消息也可用）、`编辑重发`（文字 + 图片增删后重发）。
- 中段重发先在行内确认「之后的 N 轮对话会移除」，最新一条直接重发；失效消息由客户端 `[target, replacement)` 区间注册表降级并禁用，不再触发宿主抛错。
- 生成期间重发/编辑置灰：不走 queue，避免重发出现在输入框上方的「排队消息」里。
- 图片：存的图走 `session.readAttachment`，新选的图在浏览器 FileReader 编码；文件块仍不可重发。

## 命令

```sh
npm install
npm run build       # lib/index.js + lib/client.js
npm run typecheck
node scripts/dump-session.mjs <session.v4.jsonl.zstd>   # 解码会话日志
```

上游源码仍**未安装依赖**；需要跑上游测试时才 `pnpm install`。

## 已验证

packaged 0.2.1-rc.2 GUI：编辑重发后模型上下文只剩编辑后文本（模型自述"2 条消息"），JSONL 事件形态正确，
重启冷读无 `SessionPersistenceCorruptionError`。详见 README「已验证」。
