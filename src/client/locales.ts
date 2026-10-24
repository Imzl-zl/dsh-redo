/** `redo` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.edit': '编辑重发',
  'action.editHint': '把这条消息的文字和图片放回输入框；改完发送就重写这段对话',
  'action.retry': '重新生成',
  'action.retryHint': '用同样内容重新生成这条消息之后的回答；后面的对话会从上下文移除',
  'action.unsupported': '带文件的消息暂不支持编辑或重试',
  'action.superseded': '这条消息已被重发替换，不能再编辑或重新生成',
  'action.running': '回答生成中，先停止再重发',
  'action.copy': '复制',
  'action.copied': '已复制',
  'action.copyEmpty': '这条消息没有可复制的文字',
  'badge.replaced': '已重发',
  'badge.replacedHint': '这条消息是对更早一条消息的编辑重发',
  'badge.superseded': '已被替换',
  'badge.supersededHint': '这条消息及其后的回答已不在模型上下文中',
  'confirm.title': '确认重发',
  'confirm.text': '之后的 {count} 轮对话会从上下文中移除，且无法恢复',
  'confirm.unknown': '这条消息之后的内容会从上下文中移除，且无法恢复',
  'confirm.edit': '内容会放回输入框，发送时重写这条消息',
  'confirm.editText': '内容会放回输入框；发送后，之后的 {count} 轮对话会离开上下文',
  'confirm.editUnknown': '内容会放回输入框；发送后，这条消息之后的内容会离开上下文',
  'confirm.editReplace': '输入框里现有的内容会被替换',
  'confirm.cancel': '取消',
  'confirm.go': '仍然重新生成',
  'confirm.goEdit': '放回输入框',
  'error.notOpen': '会话尚未打开，请稍后重试',
  'error.rejected': '重发失败',
  'error.command': '宿主没有挂载重写命令，请确认插件在宿主侧已加载',
  'error.superseded': '这条消息已被重发替换，无法再次重发',
  'error.running': '回答还在生成，先停止再重发',
  'error.attachment': '图片读取失败，无法重发',
} satisfies Record<string, string>

/** The redo namespace key union. */
export type RedoKey = keyof typeof zh

/** English dictionary. */
export const en: Record<RedoKey, string> = {
  'action.edit': 'Edit and resend',
  'action.editHint': 'Put this message back in the composer; sending it rewrites the conversation from here',
  'action.retry': 'Regenerate',
  'action.retryHint': 'Regenerate the answer after this message; later turns leave the context',
  'action.unsupported': 'Messages with file attachments cannot be edited or retried yet',
  'action.superseded': 'This message was replaced by a resend and can no longer be edited or retried',
  'action.running': 'Generating — stop the answer before resending',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.copyEmpty': 'This message has no text to copy',
  'badge.replaced': 'Resent',
  'badge.replacedHint': 'This message is an edited resend of an earlier one',
  'badge.superseded': 'Replaced',
  'badge.supersededHint': 'This message and its answer are no longer in the model context',
  'confirm.title': 'Confirm resend',
  'confirm.text': '{count} later turns will leave the context and cannot be restored',
  'confirm.unknown': 'Everything after this message will leave the context and cannot be restored',
  'confirm.edit': 'The content moves to the composer; sending it rewrites this message',
  'confirm.editText': 'The content moves to the composer; sending it drops the next {count} turns from the context',
  'confirm.editUnknown': 'The content moves to the composer; sending it drops everything after this message from the context',
  'confirm.editReplace': 'What is already in the composer will be replaced',
  'confirm.cancel': 'Cancel',
  'confirm.go': 'Regenerate anyway',
  'confirm.goEdit': 'Move to composer',
  'error.notOpen': 'The session is not open yet; try again in a moment',
  'error.rejected': 'Resend failed',
  'error.command': 'The host did not register the rewrite command; check that the plugin is loaded host-side',
  'error.superseded': 'This message was already replaced by a resend, so it cannot be resent again',
  'error.running': 'The answer is still generating; stop it before resending',
  'error.attachment': 'An image could not be read back, so nothing was sent',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the user-message redo actions. */
    redo: RedoKey
  }
}
