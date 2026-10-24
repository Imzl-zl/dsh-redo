<div align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="dsh-redo logo">
  <h1>dsh-redo</h1>
  <p>编辑或重试已经发出去的用户消息，并原地重新生成——不新建会话、不重开对话。</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3da639?style=flat-square" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/DSH-0.2.x-4D6BFE?style=flat-square" alt="DeepSeek Harness 0.2.x">
    <img src="https://img.shields.io/badge/platform-web-6B7280?style=flat-square" alt="Platform: web">
    <img src="https://img.shields.io/badge/plugin-cordis-8B5CF6?style=flat-square" alt="Plugin: cordis">
    <a href="https://github.com/Imzl-zl/dsh-redo/actions/workflows/ci.yml"><img src="https://github.com/Imzl-zl/dsh-redo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  </p>
</div>

---

## 这是什么

DSH（DeepSeek Harness）是一个 append-only 的会话系统：消息一旦发出去，原生没有"改一下再发"的入口。
**dsh-redo** 把这件事补上——选中任意一条自己发过的消息，改文字、删图、加图，或者原样再来一次，
模型上下文会**原地回到那条消息之前**并重新生成，而不是开一个新会话。

适合这些场景：

- 消息发错了（错字、贴错内容、图配错）→ 改完重发。
- 回答不满意 / 渠道抽风 → 原样重发，不必等失败才能点。
- 想换一个问法继续同一段对话 → 从任意一条消息重写，后面的内容作废。

## 功能

- **重新生成**：任意一条用户消息都能重发，不限于失败的消息——一键，不经过输入框。
- **编辑重发＝撤回输入框**：点一下，文字和图片原样回到**底部输入框**，改完正常按发送就重写这段对话。
  用的就是原生 composer，不是插件自己的弹窗。
- **图片跟着走**：存的图读回字节、重新挂成草稿，发送时一起上送；文件附件除外（见下）。
- **旧内容真正离开上下文**：被重写的区间由 `surface replace` 遮蔽，旧消息和它之后的回答不再进入模型请求。
- **旧消息视觉降级**：变暗、标「已被替换」、按钮禁用；新消息标「已重发」，一眼看出哪条还活着。
- **原生操作行**：时间、复制、重新生成、编辑重发排在一起，尺寸、圆角、间距、悬停行为对齐原生。
- **破坏性操作有确认**：重写中段消息前会提示「之后的 N 轮对话会离开上下文」；输入框里本来有内容时再问一句是否替换。
- **不会误触发**：武装只对「下一条你发的消息」生效，5 分钟自动作废，`/redo off` 可手动撤销。
- **生成中禁用**：回答还在生成时两个按钮置灰，先停止再重发——不会把重发塞进输入框的排队区。

### 不支持

- **文件附件**：prompt 的文件通道只接受本次会话上传换来的 receipt，客户端没有"按引用读取旧文件"的 RPC，
  所以带文件的消息两个按钮置灰，而不是静默丢内容。
- **视觉删除旧消息**：会话是 append-only，旧消息只会离开上下文并变暗，不会从时间线消失。
- **武装期间的可见记录**：`/redo <seq>` 会在时间线留一条命令记录；这是「不碰内部方法」的代价。
- **刷新后的变暗标记**：区间表在内存里，刷新后只有 `redo:` 形态的重写还认得出来，composer 路径的
  旧消息会恢复成普通外观（模型上下文仍是正确的——变暗只是视觉）。

## 安装

需要 DSH `>= 0.2.0-rc.1 < 0.3.0`，并在 Web GUI 中使用。

```sh
git clone https://github.com/Imzl-zl/dsh-redo.git
cd dsh-redo
npm install
npm run build

dsh plugin --profile <profile> add <本仓库绝对路径>
dsh --profile <profile> --dump-config | grep redo   # 应看到 "== dsh-redo" 层
dsh --profile <profile>
```

装完重启 GUI。想先拿独立 profile 试，可以用：

```sh
dsh --profile redo-test --from-default-profile web --dump-config
dsh plugin --profile redo-test add <本仓库绝对路径>
dsh --profile redo-test --no-open --port 3111
```

## 使用

1. 鼠标移到任意一条**自己发的消息**上，气泡下方出现操作行。
2. 点「重新生成」原样重发：一键，不经过输入框。
3. 点「编辑重发」：文字和图片回到**底部输入框**。重写中段消息前会确认「之后的 N 轮对话会离开上下文」；
   输入框本来不是空的，会再问一句是否替换。
4. 在输入框里改完（增删图片、改文字都行），正常按发送——这一次发送就是在重写那段对话。
   旧消息变暗并标「已被替换」，新消息标「已重发」。

编辑不弹插件自己的对话框：内容进的是原生 composer，`@` 引用、斜杠命令、图片预览、Esc 撤销全是原生行为。
代价是**武装**这一步会在时间线留下一条 `/redo <seq>` 命令记录（成功、无输出），这是这条机制的可见成本。

带**文件**（非图片）的消息两个按钮置灰，因为客户端没有按引用读回旧文件的 RPC。

## 工作原理

两个半区，各干一件小事。插件**不改上游源码**，只使用公开扩展点。

**宿主半**（`src/index.ts`，约 200 行）

两条入口，同一个追加：

1. **重新生成**：客户端发送的 prompt 把目标写进 `requestId`（`redo:<seq>:<uuid>`），`agent/pre-step`
   从认领到的消息上读回来。
2. **编辑重发**：客户端先调 `/redo <seq>`（`ctx.commands.register` 注册的宿主命令）**武装**一个目标；
   用户在 composer 里改完按发送，那次发送铸的是它自己的 requestId，宿主靠这条 latch 认领。
   latch 绑定单个 agent、只被**下一条人类消息**消费、5 分钟过期即作废，`redo:` 请求 id 永远优先。
3. `agent/request`：在已打开的 step 内追加一个空 content 的 `system/message`，用
   `surfaceOp: { op: 'replace', startSeq, endSeq }` 遮蔽 `target .. 当前 surface 尾`。
4. loop 随后追加你这次发送的文本、重建请求——模型看到的就是「目标消息之前的历史 + 你改后的文本」。

为什么「编辑」要绕一道命令：composer 提交时的 requestId 由 `beginSubmission` 内部铸（`randomUUID()`），
`BeginSubmissionInput` 不接受外部注入，所以没有钩子能在提交那一刻把它换掉。命令是客户端唯一能主动
「告诉宿主下一次发送意味着什么」的公开通道。

为什么必须是空 `system/message`：它是唯一同时满足「不产生模型消息」和「Chat 时间线不渲染」的节点类型；
空 `user/message` 会给 provider 发空消息，空 `developer/message` 会多一行空上下文。

**浏览器半**（`src/client/index.tsx`）

- 接管 keyed `conversation.chat.node` 的 `user` 单元，气泡本体仍走官方 `conversation.chat.user.content` 工厂。
- 操作行走原生 `MessageIconActions` 的度量与 token，自己补回时间与复制。
- 回填：`inputActions.setDraft(text)` 写文字；存的图用 `session.readAttachment` 读回字节、包成 `File`、
  经 `conversation.createDrafts` 挂成草稿，再由 `inputActions.addAttachments(ids)` 加进输入框。
- 客户端维护 `[target, replacement)` 区间注册表，用来降级旧消息、拦截失效消息、统计会丢弃的轮数。
  composer 发送带不了 `redo:` 标记（id 由它自己铸），所以靠「武装之后第一条更新的消息就是替换者」
  这条与宿主完全一致的规则补登区间；这张表只在内存里，刷新后仅 `redo:` 形态的重写还保留变暗与「已重发」。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH | `>= 0.2.0-rc.1 < 0.3.0`，实测 `0.2.1-rc.2` |
| 平台 | Web GUI（浏览器半只要求 shell 模块表里的 `react`） |
| 扩展点 | keyed slot `conversation.chat.node`、`agent/pre-step`、`agent/request`、`ctx.commands` |
| 测试 | Node 24（`node --test` 直接跑 TypeScript 源码，不走构建） |

## 已验证

**自动化**（`npm test`，18 项，跑在 `src/` 上，不需要构建）：锁定宿主半的不变式——替换必须落在
已打开的 turn+step 内且坐标精确、`sourceEventSeqs` 完整覆盖被遮蔽的 surface 尾、受保护的节点 0 拒绝改写、
一次重写只消费一次计划、畸形 requestId 不触发重写、非用户消息与已失效消息直接报错；命令路线则覆盖
「武装后下一条人类消息触发重写」「武装只被消费一次」「工具步不消费武装」「5 分钟过期即作废」
「`/redo off` 撤销」「显式重发清掉武装」「非法参数与非法目标被拒」。CI 依次跑 `typecheck` → `test` → `build`。

变异检验过两次：把 `endSeq` 收窄 / 让 `sourceEventSeqs` 少一个节点、以及去掉武装的过期判断，
都会立刻有测试变红。

**手工**（packaged `0.2.1-rc.2` GUI，`redo-test` profile + 本地 Cherry 网关）：三条路径实测通过——
文字编辑重发（模型上下文只剩改后文本，追问"能看到几条用户消息"答 2 而非 4）、图片编辑重发（粘贴的图
回填成草稿再发，模型仍能读到图）、以及一键重新生成。JSONL 里能看到 `system/message replace target..尾`
紧跟新的 `user/message`，重启实例冷读该会话无 `SessionPersistenceCorruptionError`。
时间线会多一张 `/redo` 命令卡（预期内）；刷新后 composer 路径的变暗标记会消失（视觉层，上下文正确）。排查现场用：

```sh
node scripts/dump-session.mjs <session.v4.jsonl.zstd>
```

## 开发

```sh
npm install
npm test            # node --test，直接跑 TypeScript 源码
npm run build       # lib/index.js + lib/client.js
npm run typecheck
node scripts/dump-session.mjs <session.v4.jsonl.zstd>   # 解码会话日志排查
```

产物 `lib/` 不入库，克隆后需要先构建。宿主半只依赖 `node:crypto`；浏览器半只要求 shell 模块表里的
`react` / `react-dom`，运行时不会装出第二份框架实例。

问题与建议欢迎开 issue / PR。

## 友链

<a href="https://linux.do"><img src="assets/linuxdo.png" width="24" height="24" alt="Linux.do" align="absmiddle"> <strong>Linux.do</strong></a>

## License

[MIT](LICENSE)
