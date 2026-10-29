<div align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="dsh-redo logo">
  <h1>dsh-redo</h1>
  <p>编辑或重试已经发出去的用户消息，并原地重新生成——不新建会话、不重开对话。</p>
  <p>
    <a href="https://www.npmjs.com/package/dsh-redo"><img src="https://img.shields.io/npm/v/dsh-redo?style=flat-square&color=CB3837" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/dsh-redo"><img src="https://img.shields.io/npm/dm/dsh-redo?style=flat-square" alt="npm downloads"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3da639?style=flat-square" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/DSH-0.2.x-4D6BFE?style=flat-square" alt="DeepSeek Harness 0.2.x">
    <img src="https://img.shields.io/badge/platform-web-6B7280?style=flat-square" alt="Platform: web">
    <img src="https://img.shields.io/badge/plugin-cordis-8B5CF6?style=flat-square" alt="Plugin: cordis">
    <a href="https://github.com/Imzl-zl/dsh-redo/actions/workflows/ci.yml"><img src="https://github.com/Imzl-zl/dsh-redo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  </p>
</div>

---

## 这是什么

DSH 的会话是只追加的日志，消息发出去就没有"改一下再发"的入口。**dsh-redo** 把这件事补上：选中任意一条
自己发过的消息，改文字、换图片，或者原样再来一次，模型上下文会**原地回到那条消息之前**并重新生成。

- 消息发错了（错字、贴错内容、图配错）→ 改完重发。
- 回答不满意或渠道抽风 → 原样重发，不用等它失败。
- 想换个问法继续同一段对话 → 从任意一条消息重写，后面的内容作废。

## 功能

- **重新生成**：任意一条用户消息都能重发，一键，不经过输入框。
- **编辑重发**：消息连同它的回答立刻从对话里消失，文字和图片回到**底部输入框**；改完按发送，旧的那段被替换，
  新的内容落在原位——不会多出一条。
- **图片跟着走**：存的图读回字节、重新挂成草稿，发送时一起上送。
- **破坏性操作有确认**：撤回中段消息前会说明之后有几轮离开上下文；输入框本来有内容时再问一句是否替换。
- **生成中禁用**：回答还在生成时按钮置灰，先把当前回答处理掉。

## 安装

需要 DSH `>= 0.2.0-rc.1 < 0.3.0`，在 Web GUI 里使用。发布物已含构建好的 `lib/`，不需要自己 build。

```sh
dsh plugin --profile <profile> add dsh-redo
dsh --profile <profile>
```

从源码装（改代码时用）：

```sh
git clone https://github.com/Imzl-zl/dsh-redo.git && cd dsh-redo
npm install && npm run build
dsh plugin --profile <profile> add <本仓库绝对路径>
```

## 使用

1. 鼠标移到任意一条**自己发的消息**上，气泡下方出现操作行。
2. **重新生成**：原样重发，一键完成。
3. **编辑重发**：这条消息立刻从对话里消失，内容回到输入框。中段消息会先确认；输入框非空时会问是否替换。
4. 改完按发送——这一次发送就是在重写那段对话。

编辑用的是原生 composer，`@` 引用、斜杠命令、图片预览、Esc 撤销都是原生行为。

## 限制

- **点了不发会还原**：登记的有效期是 5 分钟，过期或刷新后那条消息重新出现——因为它确实还没被撤回。
- **文件附件不支持**：带文件的消息两个按钮置灰，避免静默丢内容；图片不受影响。
- **日志里仍留着原文**：会话是只追加的，撤回是追加一条遮蔽记录，不是删除。模型和界面都已生效，
  但用脚本回放日志仍能看到被撤回的那条文本。
- **很久以前的重写可能不再隐藏**：界面上的隐藏依赖已加载的会话窗口；一次很早的替换若已落到窗口之外，
  刷新后旧消息会重新显示（模型上下文仍然正确）。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH | `>= 0.2.0-rc.1 < 0.3.0`，实测 `0.2.1-rc.2` / `0.2.1-rc.3` |
| 平台 | Web GUI |
| 扩展点 | keyed slot `conversation.chat.node`、`agent/pre-step`、`agent/request`、`ctx.commands` |

## 开发

```sh
npm install
npm test            # node --test，直接跑 TypeScript 源码
npm run typecheck
npm run build       # 产物 lib/ 不入库
```

设计与实现细节见 [docs/design.md](docs/design.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 友链

<a href="https://linux.do"><img src="assets/linuxdo.png" width="24" height="24" alt="Linux.do" align="absmiddle"> <strong>Linux.do</strong></a>

## License

[MIT](LICENSE)
