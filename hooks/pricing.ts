// DeepSeek's off-peak discount runs 00:30–08:30 Beijing time (UTC+8); the
// rest of the day is peak. Kept pure so tests can check the boundaries, and
// in one place so a schedule change is a two-number edit.

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

const OFFPEAK_START_MINUTES = 30
const OFFPEAK_END_MINUTES = 8 * 60 + 30

export type PriceCountdown = {
  /** True inside DeepSeek's discounted window. */
  isOffPeak: boolean
  /** The phase and the time left before the next change, as drawn. */
  text: string
}

function secondsUntilNextChange(atMs: number): {
  isOffPeak: boolean
  seconds: number
} {
  const beijingMs = atMs + BEIJING_OFFSET_MS
  const dayStartMs = Math.floor(beijingMs / DAY_MS) * DAY_MS
  const minuteOfDay = (beijingMs - dayStartMs) / MINUTE_MS
  const isOffPeak =
    minuteOfDay >= OFFPEAK_START_MINUTES &&
    minuteOfDay < OFFPEAK_END_MINUTES

  // Peak evenings run past midnight: 00:00–00:30 is still the same peak,
  // whose change comes at 00:30 today; a peak after 08:30 waits for tomorrow.
  const boundaryMinute = isOffPeak
    ? OFFPEAK_END_MINUTES
    : minuteOfDay < OFFPEAK_START_MINUTES
      ? OFFPEAK_START_MINUTES
      : OFFPEAK_START_MINUTES + 24 * 60
  const boundaryMs = dayStartMs + boundaryMinute * MINUTE_MS

  return {
    isOffPeak,
    seconds: Math.max(0, Math.ceil((boundaryMs - beijingMs) / 1000)),
  }
}

function formatCountdown(totalSeconds: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function priceCountdown(atMs: number): PriceCountdown {
  const { isOffPeak, seconds } = secondsUntilNextChange(atMs)

  return {
    isOffPeak,
    text: `${isOffPeak ? '谷时' : '峰时'} · 距${isOffPeak ? '峰' : '谷'}时 ${formatCountdown(seconds)}`,
  }
}
