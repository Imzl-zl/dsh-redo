/** `redo` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.edit': '编辑重发',
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
  'confirm.title': '确认重新生成',
  'confirm.text': '之后的 {count} 轮对话会从上下文中移除，且无法恢复',
  'confirm.unknown': '这条消息之后的内容会从上下文中移除，且无法恢复',
  'confirm.cancel': '取消',
  'confirm.go': '仍然重新生成',
  'dialog.title': '编辑并重发',
  'dialog.textLabel': '消息内容',
  'dialog.placeholder': '（这条消息没有文字）',
  'dialog.image': '图片',
  'dialog.addImage': '添加图片',
  'dialog.removeImage': '移除这张图片',
  'dialog.hint': '图片会一起重发。Enter 发送，Shift+Enter 换行。',
  'dialog.warning': '重发后，以下 {count} 轮对话将不再进入模型上下文。',
  'dialog.warningUnknown': '重发后，这条消息之后的对话将不再进入模型上下文。',
  'dialog.discardText': '放弃这次修改？已修改的内容不会保存。',
  'dialog.discardKeep': '继续编辑',
  'dialog.discardConfirm': '放弃修改',
  'dialog.cancel': '取消',
  'dialog.send': '重发',
  'dialog.sendDiscard': '重发并丢弃 {count} 轮',
  'dialog.sending': '发送中…',
  'error.notOpen': '会话尚未打开，请稍后重试',
  'error.rejected': '重发失败',
  'error.superseded': '这条消息已被重发替换，无法再次重发',
  'error.running': '回答还在生成，先停止再重发',
  'error.attachment': '图片读取失败，无法重发',
  'error.imageType': '只支持 PNG / JPEG / WebP / GIF 图片',
} satisfies Record<string, string>

/** The redo namespace key union. */
export type RedoKey = keyof typeof zh

/** English dictionary. */
export const en: Record<RedoKey, string> = {
  'action.edit': 'Edit and resend',
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
  'confirm.title': 'Confirm regenerate',
  'confirm.text': '{count} later turns will leave the context and cannot be restored',
  'confirm.unknown': 'Everything after this message will leave the context and cannot be restored',
  'confirm.cancel': 'Cancel',
  'confirm.go': 'Regenerate anyway',
  'dialog.title': 'Edit and resend',
  'dialog.textLabel': 'Message text',
  'dialog.placeholder': '(this message has no text)',
  'dialog.image': 'Image',
  'dialog.addImage': 'Add image',
  'dialog.removeImage': 'Remove this image',
  'dialog.hint': 'Images are carried over. Enter sends, Shift+Enter adds a line.',
  'dialog.warning': 'Resending removes the next {count} turns from the model context.',
  'dialog.warningUnknown': 'Resending removes everything after this message from the model context.',
  'dialog.discardText': 'Discard these edits? Your changes will not be kept.',
  'dialog.discardKeep': 'Keep editing',
  'dialog.discardConfirm': 'Discard',
  'dialog.cancel': 'Cancel',
  'dialog.send': 'Resend',
  'dialog.sendDiscard': 'Resend and drop {count}',
  'dialog.sending': 'Sending…',
  'error.notOpen': 'The session is not open yet; try again in a moment',
  'error.rejected': 'Resend failed',
  'error.superseded': 'This message was already replaced by a resend, so it cannot be resent again',
  'error.running': 'The answer is still generating; stop it before resending',
  'error.attachment': 'An image could not be read back, so nothing was sent',
  'error.imageType': 'Only PNG / JPEG / WebP / GIF images are supported',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the user-message redo actions. */
    redo: RedoKey
  }
}
