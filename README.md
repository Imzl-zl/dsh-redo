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

- **重新生成**：任意一条用户消息都能重发，不限于失败的消息。
- **编辑重发**：文字可改，图片可删可加，文字和图片可以一起改。
- **旧内容真正离开上下文**：被重写的区间由 `surface replace` 遮蔽，旧消息和它之后的回答不再进入模型请求。
- **旧消息视觉降级**：变暗、标「已被替换」、按钮禁用；新消息标「已重发」，一眼看出哪条还活着。
- **原生操作行**：时间、复制、重新生成、编辑重发排在一起，尺寸、圆角、间距、悬停行为对齐原生。
- **破坏性操作有确认**：重写中段消息前会提示「之后的 N 轮对话会移除」，只统计仍在上下文里的消息。
- **键盘与输入法安全**：回车只在文本框里发送；输入法组词期间的回车不会提交；改过草稿按 Esc 会先问是否放弃。
- **生成中禁用**：回答还在生成时两个按钮置灰，先停止再重发——不会把重发塞进输入框的排队区。

### 不支持

- **文件附件**：prompt 的文件通道只接受本次会话上传换来的 receipt，客户端没有"按引用读取旧文件"的 RPC，
  所以带文件的消息两个按钮置灰，而不是静默丢内容。
- **视觉删除旧消息**：会话是 append-only，旧消息只会离开上下文并变暗，不会从时间线消失。

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
2. 点「重新生成」原样重发；点「编辑重发」改文字 / 增删图片。
3. 更早的消息会先确认「之后的 N 轮对话会从上下文中移除」；最新一条直接发。
4. 新消息带「已重发」标记，旧消息变暗并标「已被替换」。

## 工作原理

两个半区，各干一件小事。插件**不改上游源码**，只使用公开扩展点。

**宿主半**（`src/index.ts`，约 100 行）

1. `agent/pre-step`：从消息的 `source.rpcId` 认出这次 prompt 是「第 N 条的重发」。
2. `agent/request`：在已打开的 step 内追加一个空 content 的 `system/message`，用
   `surfaceOp: { op: 'replace', startSeq, endSeq }` 遮蔽 `target .. 当前 surface 尾`。
3. loop 随后追加编辑后的文本、重建请求——模型看到的就是「目标消息之前的历史 + 编辑后的文本」。

为什么必须是空 `system/message`：它是唯一同时满足「不产生模型消息」和「Chat 时间线不渲染」的节点类型；
空 `user/message` 会给 provider 发空消息，空 `developer/message` 会多一行空上下文。

**浏览器半**（`src/client/index.tsx`）

- 接管 keyed `conversation.chat.node` 的 `user` 单元，气泡本体仍走官方 `conversation.chat.user.content` 工厂。
- 操作行走原生 `MessageIconActions` 的度量与 token，自己补回时间与复制。
- 客户端维护 `[target, replacement)` 区间注册表，用来降级旧消息、拦截失效消息、统计会丢弃的轮数。
- 发送后的编辑弹窗 portal 到 `body`，背景 `inert`、锁滚动、Tab 焦点只在弹窗内循环。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH | `>= 0.2.0-rc.1 < 0.3.0`，实测 `0.2.1-rc.2` |
| 平台 | Web GUI（浏览器半使用 `react-dom` portal） |
| 扩展点 | keyed slot `conversation.chat.node`、`agent/pre-step`、`agent/request` |

## 开发

```sh
npm install
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
