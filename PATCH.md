# dsh-redo（内部 fork：增加「取消重写」）

上游：`dsh-redo@0.4.1`（作者 Imzl-zl，MIT）。本目录是在 VM 里维护的**内部 fork**，
不改上游、不提 PR，只用于我们自己的 profile。

## 我们加的 4 处改动（全部在 `lib/client.js`）

1. **armed 外部 store**：`ARMED` / `ARMED_REVISION` / `ARMED_LISTENERS` + `armedGet/armedSet/armedSubscribe`，
   记录「哪个会话的哪条消息当前处于重写待发状态」。
2. **`arm()` 不再把该行隐藏**：去掉 `rangeFeed(sessionId).markPending(target)`，
   改为 `armedSet(sessionId, target)`。行保持可见，用户不会「消息一撤就找不着北」。
3. **行内取消控件**：在该消息的动作行末尾按条件渲染一个 `取消重写` 按钮
   （`aria-label="取消重写"`），点击 = 发宿主命令 `/redo off` + `armedSet(sessionId, undefined)` + `inputActions.setDraft("")`。
4. **locale**：`action.cancel`（取消重写 / Cancel rewrite）、`retract.pending`（撤回提示文案）。

宿主侧**未改动**：`lib/index.js` 本来就支持 `/redo <seq>|off`（`off` 即解除武装）。

## 为什么这样改（踩过的坑）

- 最初的做法是：点 ✎ 后把该行替换成一个「已撤回…取消重写」的窄条。
  但插件会给被撤回的行打 `data-dsh-redo-hidden` → **整行 display:none**，
  窄条跟着一起被隐藏；`position:fixed` 也不行（祖先有隐藏/裁剪）。用户看到的现象就是
  「消息消失了，也没地方点取消」。
- 结论：**取消控件必须挂在仍然可见的节点上**，所以改成「行不隐藏 + 行内按钮」。

## 验证方式（VM，61311）

`drive-cancel3.cjs`（CDP 驱动）：

1. 清空输入框 → 点最后一条用户消息的 ✎；
2. 断言：`.dsh-redo-action[aria-label="取消重写"]` 出现 1 个，`.dsh-redo-row` 仍 6 行，草稿长度 96；
3. 点取消 → 断言：取消按钮 0 个、行数仍 6、草稿长度 0（没有发出任何消息）。

实测输出：
```
staged {"cancelButtons":1,"rows":6,"draftLen":96}
cancel clicked
after  {"cancelButtons":0,"rows":6,"draftLen":0}
```

## 已知限制

- 输入框里已有草稿、或该消息之后还有轮次时，点 ✎ 仍会先弹上游自带的「确认重发」对话框；
  确认后才进入 armed 状态（此时才有「取消重写」）。
- 「取消重写」只清掉武装与输入框，不会把已经被上一条重发覆盖的内容找回来（那是 superseded 语义）。
