<div align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="dsh-redo logo">
  <h1>dsh-redo</h1>
  <p>编辑或重试已经发出去的用户消息，并原地重新生成——不新建会话、不重开对话。</p>
  <p>
    <a href="https://www.npmjs.com/package/dsh-redo"><img src="https://img.shields.io/npm/v/dsh-redo?style=flat-square&color=CB3837" alt="npm version"></a>
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
- **编辑重发＝点一下就地撤回**：那条消息连同它的回答立刻从对话里消失，不再回来；文字和图片原样回到
  **底部输入框**，改完正常按发送就开始新的问答。用的就是原生 composer，不是插件自己的弹窗。
- **图片跟着走**：存的图读回字节、重新挂成草稿，发送时一起上送；文件附件除外（见下）。
- **旧内容真正离开上下文**：被重写的区间由 `surface replace` 遮蔽，旧消息和它之后的回答不再进入模型请求。
- **整轮从时间线撤掉**：被重写的那一轮——你的消息、回答、工具卡、用量行——当场消失，新消息落在同一个位置，
  看起来就像这条消息原地重新生成。`/redo` 命令卡也一起隐藏。刷新后依然如此：区间是从会话日志的
  `surface replace` 读回来的，不靠内存。
- **原生操作行**：时间、复制、重新生成、编辑重发排在一起，尺寸、圆角、间距、悬停行为对齐原生。
- **破坏性操作有确认**：撤回中段消息前会提示「之后的 N 轮对话会离开上下文」；输入框里本来有内容时再问一句是否替换。
- **不会误触发**：撤回只影响你点的那条消息及其之后；其余会话、其余窗口不受影响。
- **生成中禁用**：回答还在生成时两个按钮置灰，先停止再重发——不会把重发塞进输入框的排队区。

### 不支持

- **文件附件**：prompt 的文件通道只接受本次会话上传换来的 receipt，客户端没有"按引用读取旧文件"的 RPC，
  所以带文件的消息两个按钮置灰，而不是静默丢内容。
- **太久以前的撤回不留痕**：区间是从事先加载的会话窗口里读的。一次重写如果发生在很早以前、已经落到
  窗口之外，刷新后那批旧消息会重新出现——模型上下文仍然是对的，丢的只是界面上的「撤掉」。
- **命令行手动输入 `/redo` 也会被藏**：命令卡按「它撤回的目标是否已被遮蔽」判断，插件发起的和你手敲的
  记录长得一样，所以一起隐藏。
- **账本里仍留着原文**：会话日志是只追加的，撤回追加一条 `replace`，不删原来那行。对模型和界面都已生效，
  但 `dump-session` 或任何回放仍能看到你撤回掉的那条文本。

## 安装

需要 DSH `>= 0.2.0-rc.1 < 0.3.0`，并在 Web GUI 中使用。

从 npm 装（发布物已含构建好的 `lib/`，无需自己 build）：

```sh
dsh plugin --profile <profile> add dsh-redo
dsh --profile <profile> --dump-config | grep redo   # 应看到 "== dsh-redo" 层
dsh --profile <profile>
```

或者从源码装（改代码、跟进未发布提交时用）：

```sh
git clone https://github.com/Imzl-zl/dsh-redo.git
cd dsh-redo
npm install
npm run build

dsh plugin --profile <profile> add <本仓库绝对路径>
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
3. 点「编辑重发」：这条消息**立刻从对话里撤掉**，文字和图片回到**底部输入框**。该问的会先问
   （中段消息说明之后还有几轮会跟着离开；输入框本来不是空的问是否替换）。
4. 在输入框里改完（增删图片、改文字都行），正常按发送——这一次发送就是在重写那段对话，新的那条落在
   被撤掉的位置。撤掉这件事不设期限，草稿留着多久都行。

编辑不弹插件自己的对话框：内容进的是原生 composer，`@` 引用、斜杠命令、图片预览、Esc 撤销全是原生行为。
**武装**这一步仍然会往时间线写一条 `/redo <seq>` 命令记录（成功、无输出），但发送完成、区间落定后，
这张卡和它所在的那段对话会一起被撤掉，所以正常使用时看不到它。

带**文件**（非图片）的消息两个按钮置灰，因为客户端没有按引用读回旧文件的 RPC。

## 工作原理

两个半区，各干一件小事。插件**不改上游源码**，只使用公开扩展点。

**宿主半**（`src/index.ts`）

两条入口，同一个追加：

1. **撤回（编辑）**：客户端调 `/redo <seq>`（`ctx.commands.register` 注册的宿主命令），命令**当场**写五个事件
   ——`turn/start` → `step/start` → 空 content 的 `system/message`（`surfaceOp: replace target..surface 尾`）
   → `step/end` → `turn/end`。没有消息进 inbox，这个 turn 不会被请求模型；日志坐标精确，冷读不会报错。
   点一下，消息就从上下文里消失了。
2. **重新生成**：客户端发送的 prompt 把目标写进 `requestId`（`redo:<seq>:<uuid>`），`agent/pre-step`
   从认领到的消息上读回来，`agent/request` 在**已经打开的 step** 里写同样的替换。

为什么撤回要绕一道命令：composer 提交时的 requestId 由 `beginSubmission` 内部铸（`randomUUID()`），
`BeginSubmissionInput` 不接受外部注入，所以没有钩子能在提交那一刻插手。命令是客户端唯一能主动让宿主「现在就把这段删掉」的公开通道。

为什么命令要自己开一个 turn：`system/message` 只能落在已打开的 turn+step 内，而点击发生在 turn 之外。

为什么必须是空 `system/message`：它是唯一同时满足「不产生模型消息」和「Chat 时间线不渲染」的节点类型；
空 `user/message` 会被 `deriveEventMessage` 原样投影给 provider，空 `developer/message` 会多一行空上下文。

**浏览器半**（`src/client/index.tsx`）

- 接管 keyed `conversation.chat.node` 的 `user` 单元，气泡本体仍走官方 `conversation.chat.user.content` 工厂。
- 操作行走原生 `MessageIconActions` 的度量与 token，自己补回时间与复制。
- 回填：先调命令撤回，再 `inputActions.setDraft(text)` 写文字；存的图在**调命令之前**用 `session.readAttachment`
  读回字节、包成 `File`、经 `conversation.createDrafts` 挂成草稿，最后由 `inputActions.addAttachments(ids)`
  加进输入框——顺序反过来的话，读图失败会连消息一起丢。
- 区间不靠客户端记账：每次撤回都是一条 `surfaceOp: { op: 'replace', startSeq, endSeq }` 追加，插件直接
  从会话自己的事件窗口（`binding.eventSource`）把区间读回来（`src/client/intervals.ts`）。刷新后依然生效。
- 撤掉的是**整轮**，不只是气泡：插件只接管了 `user` 单元，回答、工具卡、过程行、用量行都由官方 cell 渲染，
  所以被遮蔽的那一行挂载后，会把它所在 Turn 的容器行（`data-chat-turn`）一并隐藏，`MutationObserver` 补上
  晚到的行。插件为撤回开的那个空 turn 也会留下「已完成」和用量行，`deriveRetractionTurns` 按「有 replace、
  没有 user 消息」把它认出来一起隐藏。`/redo` 命令卡不在任何 Turn 里，按「它撤回的目标是否已被遮蔽」识别。
  都只作用在同一个 Chat flow 内，分屏不会串号。
- `intervals.ts` 是纯函数：区间推导 + 撤回 turn 推导 + 判定，`test/intervals.test.ts` 直接锁它。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH | `>= 0.2.0-rc.1 < 0.3.0`，实测 `0.2.1-rc.2` |
| 平台 | Web GUI（浏览器半只要求 shell 模块表里的 `react`） |
| 扩展点 | keyed slot `conversation.chat.node`、`agent/pre-step`、`agent/request`、`ctx.commands` |
| 测试 | Node 24（`node --test` 直接跑 TypeScript 源码，不走构建） |

## 已验证

**自动化**（`npm test`，24 项，跑在 `src/` 上，不需要构建）：宿主半锁「撤回命令写出的五个事件」顺序与坐标
（turn/step 精确、turn 号跟着日志走、不留 open step）、`sourceEventSeqs` 完整覆盖被遮蔽的 surface 尾、
受保护的节点 0 拒绝改写、替换必须是空 system 而非 user、非法参数/越界目标/非人类消息全被拒且不碰日志；
重试路线覆盖 plan 只消费一次、step 作用域、畸形 requestId 不重写。客户端半锁区间推导与「撤回 turn」识别。
CI 依次跑 `typecheck` → `test` → `build`。

变异检验过两次：把 `endSeq` 收窄 / 让 `sourceEventSeqs` 少一个节点、以及去掉过期判断（旧版）都会立刻有测试变红。

**手工**（packaged `0.2.1-rc.2` GUI，`redo-test` profile + 本地 Cherry 网关）：

- 20:1x 三条路径：文字编辑重发（模型上下文只剩改后文本，追问「能看到几条用户消息」答 2 而非 4）、图片编辑
  重发（粘贴的图回填成草稿再发，模型仍能读到图）、一键重新生成。
- 22:0x 整轮撤掉：重试最后一条 / 编辑 / 中段重试，被重写的那一轮（消息、回答、过程行、用量行）连同
  `redo` 命令卡一起消失，新的一轮落在同一位置。
- 22:5x **点击即撤回**：点「编辑重发」后 1.8 秒内时间线只剩 0 行，composer 拿到原文；日志里是
  `turn/start` → `step/start` → `replace 8..18` → `step/end` → `turn/end`。重启实例冷读该会话正常，
  **无 `SessionPersistenceCorruptionError`**，接着发消息正常开下一个 turn。

排查现场用：

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
`react`，运行时不会装出第二份框架实例。

问题与建议欢迎开 issue / PR。

## 变更记录与发版

每个版本都记在 [CHANGELOG.md](CHANGELOG.md)，并标注它是针对哪个 DSH 版本构建的。

发版是 **tag 驱动**的，不需要任何人手上有 token：

```sh
npm version patch        # 先跑 typecheck + 测试，再改版本号并打 tag
# 把 CHANGELOG 的 Unreleased 段落改成这个版本号
git push --follow-tags
```

`.github/workflows/release.yml` 会核验 tag 与 `package.json` 一致，然后通过 **npm trusted publishing
（OIDC）** 发布并附 provenance。这个工作流文件被 npm 侧的 trusted publisher 配置按路径绑定，重命名或挪位置
会让发布在 403 上失败——改路径时要去 npmjs.com 同步改一次。

## 友链

<a href="https://linux.do"><img src="assets/linuxdo.png" width="24" height="24" alt="Linux.do" align="absmiddle"> <strong>Linux.do</strong></a>

## License

[MIT](LICENSE)
