/** `redo` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.edit': '编辑重发',
  'action.editHint': '点一下就把这条消息撤回输入框；发送后按改后的内容重新回答',
  'action.retry': '重新生成',
  'action.retryHint': '撤掉这条消息和它之后的对话，用同样的内容重新回答',
  'action.unsupported': '带文件的消息暂不支持编辑或重试',
  'action.running': '回答生成中，先停止再重发',
  'action.copy': '复制',
  'action.copied': '已复制',
  'action.copyEmpty': '这条消息没有可复制的文字',
  'confirm.title': '确认重发',
  'confirm.text': '这条消息之后的 {count} 轮会被撤掉，界面上也会消失，且无法恢复',
  'confirm.unknown': '这条消息之后的内容会被撤掉，界面上也会消失，且无法恢复',
  'confirm.edit': '内容会放回输入框，这条消息立刻从对话里撤掉',
  'confirm.editText': '内容会放回输入框，这条消息立刻撤掉；之后的 {count} 轮会在发送后离开',
  'confirm.editUnknown': '内容会放回输入框，这条消息立刻撤掉；之后的内容会在发送后离开',
  'confirm.editReplace': '输入框里现有的内容会被替换',
  'confirm.cancel': '取消',
  'confirm.go': '仍然重新生成',
  'confirm.goEdit': '撤回并放回输入框',
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
  'action.editHint': 'Retract this message into the composer in one click; sending it answers the edited text',
  'action.retry': 'Regenerate',
  'action.retryHint': 'Drop this message and everything after it, then answer the same text again',
  'action.unsupported': 'Messages with file attachments cannot be edited or retried yet',
  'action.running': 'Generating — stop the answer before resending',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.copyEmpty': 'This message has no text to copy',
  'confirm.title': 'Confirm resend',
  'confirm.text': 'The {count} turns after this message will be dropped and leave the transcript, with no way back',
  'confirm.unknown': 'Everything after this message will be dropped and leave the transcript, with no way back',
  'confirm.edit': 'The content moves to the composer and this message leaves the conversation right away',
  'confirm.editText': 'The content moves to the composer and this message leaves right away; the {count} turns after it leave when you send',
  'confirm.editUnknown': 'The content moves to the composer and this message leaves right away; everything after it leaves when you send',
  'confirm.editReplace': 'What is already in the composer will be replaced',
  'confirm.cancel': 'Cancel',
  'confirm.go': 'Regenerate anyway',
  'confirm.goEdit': 'Retract to composer',
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
