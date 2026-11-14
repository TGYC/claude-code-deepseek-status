// The words the mod shows, kept pure so tests can check them without the
// engine.

export function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

// After a Stop, Claude Code refuses commands a plugin issues until a new user
// message or a press on the plugin's own UI clears the hold. Its message is
// long and firstLine would cut it mid-word, so answer it in words the person
// can act on; any other failure keeps the engine's own message.
const STOPPED_REFUSAL =
  'the session was stopped and nobody has sent input since'

export function effortFailureMessage(message: string): string {
  return message.includes(STOPPED_REFUSAL)
    ? '会话已停止：先发送任意消息，或点击上方「推理」按钮'
    : `打开推理等级选择失败：${firstLine(message)}`
}
