import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DeepseekBalance, DeepseekModel, DeepseekStatus } from '../types'
import { isEffortChord, isSwitchChord } from './chord'

// How often the model and balance are read again, in milliseconds. A turn's
// end refreshes them too, so this only catches top-ups and outside changes.
const REFRESH_MS = 60_000

// The pane the switch chord opens: `shift+\`.
const MODEL_PANE = 'deepseek-models'

// Bump the shape tag when DeepseekStatus changes: a value an earlier version
// stored then reads as absent instead of being drawn.
const status = atom(
  { plugin: 'deepseek-status', key: 'status' } as const,
  {
    isDeepseek: false,
    model: null,
    balances: [],
    isAvailable: true,
    error: null,
    updatedAt: null,
    models: [],
    modelsError: null,
    modelsUpdatedAt: null,
    effort: null,
    isUltra: false,
  } satisfies DeepseekStatus,
  { shape: 'status-4' },
)

// The Ultra character animation's frame: 24 frames at 128 ms, as the engine's
// own effort picker runs it.
const animation = atom(
  { plugin: 'deepseek-status', key: 'animation' } as const,
  0,
)

type BalanceResponse = {
  is_available?: boolean
  balance_infos?: Array<{ currency?: string; total_balance?: string }>
}

type ModelsResponse = {
  data?: Array<{ id?: string; name?: string }>
}

function isDeepseekBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'deepseek.com' || host.endsWith('.deepseek.com')
  } catch {
    return baseUrl.includes('deepseek.com')
  }
}

// `deepseek-flash[1m]` and `deepseek-flash` name the same model, with and
// without a context qualifier.
function baseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '')
}

async function readProvider(
  $: EngineInterface,
): Promise<{ baseUrl: string | null; apiKey: string | null }> {
  let baseUrl = (await $.env.get('ANTHROPIC_BASE_URL')) || null
  let apiKey =
    (await $.env.get('DEEPSEEK_API_KEY')) ||
    (await $.env.get('ANTHROPIC_AUTH_TOKEN')) ||
    (await $.env.get('ANTHROPIC_API_KEY')) ||
    null

  if (baseUrl && apiKey) return { baseUrl, apiKey }

  // The same values, in case settings' `env` block is not in the process
  // environment the hooks worker reads.
  try {
    const settings = (await $.settings.read({ key: 'env' })) as
      | Record<string, string | undefined>
      | undefined
    baseUrl ||= settings?.ANTHROPIC_BASE_URL || null
    apiKey ||=
      settings?.DEEPSEEK_API_KEY ||
      settings?.ANTHROPIC_AUTH_TOKEN ||
      settings?.ANTHROPIC_API_KEY ||
      null
  } catch {
    // Optional: whatever the environment gave above is enough.
  }

  return { baseUrl, apiKey }
}

function providerUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl)
  url.pathname = path
  url.search = ''
  return url.toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

// `CLAUDE_EFFORT` is only in the environment of Bash children, not of the
// hooks worker, so the level is learned from the places that do carry it:
// `/effort`'s output and the classic Stop hook's input.
let effortCache: string | null = null

const EFFORT_LEVEL = /^(low|medium|high|xhigh|max)$/

function effortFromText(text: string): string | null {
  const patterns = [
    /effort(?: level)? (?:set to|to) (xhigh|max|medium|low|high)\b/i,
    /effort set to (xhigh|max|medium|low|high)\b/i,
    /using (xhigh|max|medium|low|high)\b/i,
    /runs at (xhigh|max|medium|low|high)\b/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null && match[1] !== undefined) return match[1].toLowerCase()
  }

  return null
}

// The configured effort, used only as a seed before anything reports a level.
// The env cap wins; the per-model default is what a cleared cap falls back to.
async function readConfiguredEffort(
  $: EngineInterface,
): Promise<string | null> {
  try {
    const level = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
    if (level !== undefined && EFFORT_LEVEL.test(level)) return level
  } catch {
    // Fall through to the model setting.
  }

  try {
    const settings = (await $.settings.read({ key: 'modelSettings' })) as
      | Record<string, { effortLevel?: unknown }>
      | undefined
    const model = await $.session.model().catch(() => null)

    if (model !== null && settings !== undefined) {
      for (const key of [model, baseModelId(model)]) {
        const level = settings[key]?.effortLevel
        if (typeof level === 'string' && EFFORT_LEVEL.test(level)) return level
      }
    }
  } catch {
    // No model setting.
  }

  return null
}

// The Bash tool's environment carries `CLAUDE_EFFORT` — the level the session
// really runs at, after any downgrade — which the hooks worker's own
// environment does not. One tiny read-only command reads it.
async function readLiveEffort($: EngineInterface): Promise<string | null> {
  try {
    const result = await $.tool.call({
      tool: 'Bash',
      command: 'printf %s "$CLAUDE_EFFORT"',
    })

    if ('deny' in result) return null
    if (!('result' in result) || result.result === undefined) return null

    const output = result.result as { stdout?: unknown }
    const level =
      typeof output.stdout === 'string' ? output.stdout.trim() : ''

    return EFFORT_LEVEL.test(level) ? level : null
  } catch {
    return null
  }
}

async function rememberEffort(
  $: EngineInterface,
  level: string | null,
): Promise<void> {
  if (level === null || level === effortCache) return

  effortCache = level
  ensureAnimationTimer($)
  await update($, status, value => ({ ...value, effort: level }))
}

// Ultracode ("Ultra") is a session toggle beside the effort level. The hook
// API does not expose it, so it is read off `/effort`'s output: "Set effort
// level to …" turns it off, "Ultracode on/off" says what it is.
let isUltraCache = false
let animationTimer: Timer | null = null

function ultraFromText(text: string): boolean | null {
  if (/ultracode (?:is )?on\b/i.test(text)) return true
  if (/ultracode (?:is )?off\b/i.test(text)) return false
  if (/effort(?: level)? (?:set to|to) /i.test(text)) return false
  return null
}

function isUltraConfigured(level: string | undefined): boolean {
  return level === 'ultracode' || level === 'ultra'
}

// The mascot's frames: the engine's own 128 ms, 24-frame cycle. It runs at the
// top effort level, and for ultracode at any level.
function ensureAnimationTimer($: EngineInterface): void {
  const shouldAnimate = isUltraCache || effortCache === 'max'

  if (shouldAnimate && animationTimer === null) {
    animationTimer = $.clock.every(128, () => {
      void update($, animation, frame => (frame + 1) % 24)
    })
  } else if (!shouldAnimate && animationTimer !== null) {
    animationTimer.cancel()
    animationTimer = null
  }
}

async function rememberUltra(
  $: EngineInterface,
  isUltra: boolean,
): Promise<void> {
  isUltraCache = isUltra
  ensureAnimationTimer($)

  await update($, status, value =>
    value.isUltra === isUltra ? value : { ...value, isUltra },
  )
}

type Rgb = readonly [number, number, number]

// The engine's own palette for the wand and the flame it holds.
const WOOD: Rgb = [208, 162, 100]
const WOOD_LIT: Rgb = [255, 240, 184]
const EMBER: Rgb = [240, 128, 72]
const GOLD: Rgb = [255, 204, 104]
const BRIGHT: Rgb = [255, 236, 160]
const FLARE: Rgb = [255, 252, 235]

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  const amount = Math.max(0, Math.min(1, t))
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ]
}

function css(color: Rgb): string {
  return `rgb(${color[0]},${color[1]},${color[2]})`
}

function ultraColors(frame: number): {
  wand: string
  flame: string
  isFlaring: boolean
} {
  const phase = frame % 24
  let wand: Rgb = WOOD
  let flame: Rgb = EMBER
  let isFlaring = false

  if (phase < 2) {
    // The flare at the top of the cycle.
    wand = WOOD_LIT
    flame = FLARE
    isFlaring = true
  } else if (phase < 5) {
    const t = (phase - 2 + 1) / 3
    wand = mix(WOOD_LIT, WOOD, t)
    flame = mix(BRIGHT, GOLD, t)
  } else if (phase >= 20) {
    const t = (phase - 20 + 1) / 4
    wand = mix(WOOD, WOOD_LIT, t / 2)
    flame = mix(GOLD, BRIGHT, t)
  } else {
    const shimmer =
      Math.abs(Math.sin(frame * 12.9898) * 43758.5453) % 1
    flame = mix(EMBER, GOLD, shimmer)
  }

  return { wand: css(wand), flame: css(flame), isFlaring }
}

async function refreshBalance(
  $: EngineInterface,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  try {
    const response = await $.http.fetch(providerUrl(baseUrl, '/user/balance'), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      await update($, status, value => ({
        ...value,
        error: `HTTP ${response.status}`,
      }))
      return
    }

    const payload = JSON.parse(response.text) as BalanceResponse
    const balances: DeepseekBalance[] = (payload.balance_infos ?? [])
      .filter(
        info =>
          typeof info.currency === 'string' &&
          typeof info.total_balance === 'string',
      )
      .map(info => ({
        currency: info.currency as string,
        total: info.total_balance as string,
      }))
    const updatedAt = await $.clock.now()

    await update($, status, value => ({
      ...value,
      balances,
      isAvailable: payload.is_available !== false,
      error: null,
      updatedAt,
    }))
  } catch {
    await update($, status, value => ({ ...value, error: '刷新失败' }))
  }
}

async function refreshModels(
  $: EngineInterface,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  try {
    const response = await $.http.fetch(providerUrl(baseUrl, '/models'), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      await update($, status, value => ({
        ...value,
        modelsError: `HTTP ${response.status}`,
      }))
      return
    }

    const payload = JSON.parse(response.text) as ModelsResponse
    const models: DeepseekModel[] = (payload.data ?? [])
      .filter(entry => typeof entry.id === 'string')
      .map(entry => ({
        id: entry.id as string,
        name: typeof entry.name === 'string' ? entry.name : null,
      }))
    const modelsUpdatedAt = await $.clock.now()

    await update($, status, value => ({
      ...value,
      models,
      modelsError: null,
      modelsUpdatedAt,
    }))
  } catch {
    await update($, status, value => ({ ...value, modelsError: '刷新失败' }))
  }
}

// Reads the model, the balance and the provider's model list into `status`.
// Never rejects: a failure is shown in the band.
async function refresh($: EngineInterface): Promise<void> {
  let model: string | null = null
  try {
    model = await $.session.model()
  } catch {
    // Keep the model the band last showed.
  }

  try {
    const { baseUrl, apiKey } = await readProvider($)

    if (!baseUrl || !isDeepseekBase(baseUrl)) {
      await update($, status, value => ({
        ...value,
        isDeepseek: false,
        model: model ?? value.model,
        error: null,
      }))
      return
    }

    await update($, status, value => ({
      ...value,
      isDeepseek: true,
      model: model ?? value.model,
    }))

    if (!apiKey) {
      await update($, status, value => ({
        ...value,
        error: '未找到 API Key',
        modelsError: '未找到 API Key',
      }))
      return
    }

    await Promise.all([
      refreshBalance($, baseUrl, apiKey),
      refreshModels($, baseUrl, apiKey),
    ])
  } catch {
    try {
      await update($, status, value => ({
        ...value,
        model: model ?? value.model,
        error: '刷新失败',
      }))
    } catch {
      // Nothing left to say; the band keeps what it last showed.
    }
  }
}

// Switches the session's model and updates the setting. A listed id equal to
// the current model's base keeps the current spelling, so `deepseek-flash[1m]`
// stays 1M when reselected.
async function switchModel($: EngineInterface, id: string): Promise<void> {
  const value = await read($, status)
  const target =
    value.model !== null && baseModelId(value.model) === baseModelId(id)
      ? value.model
      : id

  let detail = ''
  let ran = true

  try {
    const result = await $.command.run({ command: 'model', args: target })
    detail = result.text ?? ''
  } catch {
    ran = false
  }

  if (!ran) {
    try {
      const result = await $.config.set({ key: 'model', value: target })
      if (result.deny !== undefined) {
        $.ui.toast(`切换模型失败：${firstLine(result.deny)}`)
        return
      }
    } catch (error) {
      $.ui.toast(`切换模型失败：${firstLine(errorMessage(error))}`)
      return
    }
  }

  const model = await $.session.model().catch(() => target)
  await update($, status, current => ({ ...current, model }))

  if (baseModelId(model) !== baseModelId(target)) {
    $.ui.toast(`切换模型失败${detail ? `：${firstLine(detail)}` : ''}`)
    return
  }

  $.ui.toast(`已切换到 ${model}`)
}

// Opens Claude Code's own effort picker. The command resolves once the picker
// closed, so the level it settled on is read right after.
async function openEffort($: EngineInterface): Promise<void> {
  let text = ''

  try {
    const result = await $.command.run({ command: 'effort' })
    text = result.text ?? ''
  } catch (error) {
    $.ui.toast(`打开推理等级选择失败：${firstLine(errorMessage(error))}`)
    return
  }

  const level = effortFromText(text)
  if (level !== null) await rememberEffort($, level)

  const ultra = ultraFromText(text)
  if (ultra !== null) await rememberUltra($, ultra)
}

// Opens the model list as a focused pane, or closes it when it is open.
async function toggleModelPane($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === MODEL_PANE)) {
    await $.ui.close({ id: MODEL_PANE })
    return
  }

  await $.ui.open({
    id: MODEL_PANE,
    title: '切换模型',
    focus: true,
    closeOnEscape: true,
    rows: 3,
  })
}

// Hides the list first, then switches: the text is gone as the model changes.
async function chooseModel($: EngineInterface, id: string): Promise<void> {
  try {
    await $.ui.close({ id: MODEL_PANE })
  } catch {
    // Already closed; nothing to hide.
  }

  await switchModel($, id)
}

function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return `${currency} `
}

function balanceLine(value: DeepseekStatus): string {
  if (value.error !== null) return `余额 获取失败（${value.error}）`
  if (value.updatedAt === null) return '余额 加载中…'

  // Zero-valued currencies only add noise; show them only when all are zero.
  const nonzero = value.balances.filter(balance => Number(balance.total) !== 0)
  const shown = nonzero.length > 0 ? nonzero : value.balances
  const total = shown
    .map(balance => `${currencySymbol(balance.currency)}${balance.total}`)
    .join(' · ')

  return `余额 ${total || '未知'}${value.isAvailable ? '' : '（不可用）'}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const current = await read($, status)
    effortCache = current.effort
    isUltraCache = current.isUltra

    if (current.effort === null) {
      const level = await readConfiguredEffort($)
      if (level !== null) await rememberEffort($, level)
    }

    // The configured level is a guess; the Bash tool knows the real one.
    void (async () => {
      const live = await readLiveEffort($)
      if (live !== null) await rememberEffort($, live)
    })()

    if (!current.isUltra) {
      try {
        const level = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
        if (isUltraConfigured(level)) await rememberUltra($, true)
      } catch {
        // No configured level.
      }
    }

    ensureAnimationTimer($)
    void refresh($)
    $.clock.every(REFRESH_MS, () => {
      void refresh($)
    })

    return next(e)
  })

  // `/model` can change between turns: read it as each main turn begins.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const model = await $.session.model().catch(() => null)
      await update($, status, value => ({
        ...value,
        model: model ?? value.model,
      }))
    }

    return next(e)
  })

  // Spending changes the balance, and a model may have been switched, so read
  // both again after each main turn.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void refresh($)

    return result
  })

  // Any model switch, the person's `/model` included, updates the band.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, status, value => ({ ...value, model: e.to_model }))

    return next(e)
  })

  // A tool-use hook carries the effort the turn really ran at.
  on('classic.Stop', async ($, e, next) => {
    const level = e.effort?.level
    if (typeof level === 'string' && level.length > 0) {
      await rememberEffort($, level)
    }

    return next(e)
  })

  // `/effort` says what happened: a level or the ultracode toggle.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const text = result?.text ?? ''

    const ultra = ultraFromText(text)
    if (ultra !== null) await rememberUltra($, ultra)

    // Sync the level right after the adjustment, from the session's own env.
    const live = await readLiveEffort($)
    const level = live ?? effortFromText(text)
    if (level !== null) await rememberEffort($, level)

    return result
  })

  // Shift+\ opens or closes the model list, Shift+E opens the effort picker.
  // Both only answer an empty prompt, so typing a normal instruction is never
  // intercepted.
  on('prompt.edit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)

    const switchesModel = isSwitchChord(e)
    const switchesEffort = isEffortChord(e)
    if (!switchesModel && !switchesEffort) return next(e)

    const value = await read($, status)
    if (!value.isDeepseek) return next(e)

    if (switchesModel) {
      await toggleModelPane($)
    } else {
      void openEffort($)
    }

    return { text: e.text, cursor: e.cursor }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const value = await read($, status)
    if (!value.isDeepseek || e.props.hasSurvey) return next(e)

    const isAnimated = value.isUltra || value.effort === 'max'
    const frame = isAnimated ? await read($, animation) : 0
    const colors = isAnimated ? ultraColors(frame) : null
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="suggestion">模型 {value.model ?? '…'}</Text>
        <Text dimColor> (按shift+\切换)</Text>
        <Text dimColor> · </Text>
        <Text
          color={
            value.error !== null
              ? 'error'
              : value.isAvailable
                ? 'success'
                : 'warning'
          }
        >
          {balanceLine(value)}
        </Text>
        <Text dimColor> · </Text>
        <Button
          key="effort"
          plain
          onPress={() => {
            void openEffort($)
          }}
        >
          {'推理 '}
          <Text color={colors?.flame}>{value.effort ?? '—'}</Text>
        </Button>
        <Text dimColor> (shift+e)</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MODEL_PANE }, async ($, e, next) => {
    const value = await read($, status)
    if (!value.isDeepseek) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const currentBase = value.model === null ? null : baseModelId(value.model)
    const currentIndex = value.models.findIndex(
      model => baseModelId(model.id) === currentBase,
    )

    return (
      <Box flexDirection="column">
        {value.models.length > 0 ? (
          <Box gap={2}>
            {value.models.map((model, index) => {
              const isCurrent = index === currentIndex

              return (
                <Button
                  key={`model-${model.id}`}
                  label={`${model.id}${isCurrent ? ' ✓' : ''}`}
                  variant={isCurrent ? 'primary' : 'secondary'}
                  autoFocus={
                    index === (currentIndex >= 0 ? currentIndex : 0)
                      ? true
                      : undefined
                  }
                  onPress={() => {
                    void chooseModel($, model.id)
                  }}
                />
              )
            })}
          </Box>
        ) : (
          <Text dimColor>
            {value.modelsError !== null
              ? `模型列表获取失败（${value.modelsError}）`
              : '正在加载模型列表…'}
          </Text>
        )}
        <Text dimColor>←/→ 选择 · Enter 确认 · Esc 取消</Text>
      </Box>
    )
  })
}
