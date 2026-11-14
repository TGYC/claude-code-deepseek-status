// The key chords the mod answers at an empty prompt, kept pure so they can be
// tested without the editor.
export type ChordEdit = {
  key?: { key: string; shift?: true }
  text: string
  cursor: number
  start: number
  end: number
  inputText: string
}

function isAtEmptyPrompt(e: ChordEdit): boolean {
  return e.text === '' && e.cursor === 0 && e.start === 0 && e.end === 0
}

// Shift+backslash: `|` on the usual layouts, `\` with shift reported on some.
export function isSwitchChord(e: ChordEdit): boolean {
  if (!isAtEmptyPrompt(e) || e.key === undefined) return false

  const typed = e.inputText
  const isBackslash =
    typed === '|' ||
    typed === '\\' ||
    e.key.key === '|' ||
    e.key.key === '\\'

  return isBackslash && (e.key.shift === true || typed === '|')
}

// Shift+E: an uppercase `E` typed into an empty prompt.
export function isEffortChord(e: ChordEdit): boolean {
  if (!isAtEmptyPrompt(e) || e.key === undefined) return false

  return e.key.key === 'E' || e.inputText === 'E'
}
