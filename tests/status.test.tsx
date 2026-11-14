import { expect, mock, test } from 'claude-code/testing'

import { isEffortChord, isSwitchChord } from '../hooks/chord'
import { effortFailureMessage } from '../hooks/messages'
import { priceCountdown } from '../hooks/pricing'

const BAND = {
  plugin: 'deepseek-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 7 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'deepseek-status',
  component: 'Pane',
  requestId: 'deepseek-models',
  props: {
    title: '切换模型',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

function balanceResponse(total: string): string {
  return JSON.stringify({
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: total,
        granted_balance: '0.00',
        topped_up_balance: total,
      },
      {
        currency: 'USD',
        total_balance: '0.00',
        granted_balance: '0.00',
        topped_up_balance: '0.00',
      },
    ],
  })
}

function modelsResponse(): string {
  return JSON.stringify({
    object: 'list',
    data: [
      { id: 'deepseek-flash', object: 'model', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', object: 'model', name: 'DeepSeek-V4-Pro' },
    ],
  })
}

function providerMock(on: Parameters<typeof mock.env>[0]) {
  mock.env(on, {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-test',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: e.url.endsWith('/models')
        ? modelsResponse()
        : balanceResponse('24.34'),
    },
  }))
}

test('shows the model, balance and hints, with the model list hidden', async ($, on) => {
  providerMock(on)
  on('session.model', () => ({ value: 'deepseek-flash[1m]' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(
      (await ui.find({ type: 'Text', text: '模型 deepseek-flash[1m]' }))?.text,
    ).toBe('模型 deepseek-flash[1m]')
    expect(
      (await ui.find({ type: 'Text', text: '(按shift+\\切换)' }))?.text,
    ).toContain('(按shift+\\切换)')
    // The zero USD entry is left out.
    expect((await ui.find({ type: 'Text', text: /余额/ }))?.text).toBe(
      '余额 ¥24.34',
    )
    expect((await ui.find({ type: 'Button', key: 'effort' }))?.text).toBe(
      '推理 max',
    )
    // The list lives in the pane now, not in the band.
    expect(
      await ui.find({ type: 'Button', key: 'model-deepseek-v4-pro' }),
    ).toBeUndefined()
    await ui.unmount()
  }
})

test('shows the price countdown next to the balance, to the second', async ($, on) => {
  providerMock(on)
  on('session.model', () => ({ value: 'deepseek-flash[1m]' }))
  // 2026-01-02 00:30 Beijing time: the off-peak window just opened.
  const clock = mock.clock(on, { now: Date.UTC(2026, 0, 1, 16, 30, 0) })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /距峰时/ }))?.text).toBe(
    '谷时 · 距峰时 08:00:00',
  )

  await clock.advance(1000)
  expect((await ui.find({ type: 'Text', text: /距峰时/ }))?.text).toBe(
    '谷时 · 距峰时 07:59:59',
  )
  await ui.unmount()
})

test('counts to the next peak or off-peak change, to the second', () => {
  // Beijing time is UTC+8; these are the two changes, either side.
  expect(priceCountdown(Date.UTC(2026, 0, 1, 16, 29, 59))).toEqual({
    isOffPeak: false,
    text: '峰时 · 距谷时 00:00:01',
  })
  expect(priceCountdown(Date.UTC(2026, 0, 1, 16, 30, 0))).toEqual({
    isOffPeak: true,
    text: '谷时 · 距峰时 08:00:00',
  })
  expect(priceCountdown(Date.UTC(2026, 0, 2, 0, 29, 59))).toEqual({
    isOffPeak: true,
    text: '谷时 · 距峰时 00:00:01',
  })
  expect(priceCountdown(Date.UTC(2026, 0, 2, 0, 30, 0))).toEqual({
    isOffPeak: false,
    text: '峰时 · 距谷时 16:00:00',
  })
})

test('the model pane switches and closes on a press', async ($, on) => {
  providerMock(on)

  let current = 'deepseek-flash[1m]'
  on('session.model', () => ({ value: current }))
  const commands: Array<[string, string]> = []
  on('command.run', (_, e) => {
    commands.push([e.command, e.args])
    if (e.command === 'model') current = e.args
    return { text: '' }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(
    (await ui.find({ type: 'Button', key: 'model-deepseek-flash' }))?.text,
  ).toBe('deepseek-flash ✓')
  expect(
    (await ui.find({ type: 'Button', key: 'model-deepseek-v4-pro' }))?.text,
  ).toBe('deepseek-v4-pro')

  await ui.press({ key: 'model-deepseek-v4-pro' })

  expect(commands).toContainEqual(['model', 'deepseek-v4-pro'])
  expect(current).toBe('deepseek-v4-pro')
  await ui.unmount()
})

test('opens the built-in effort picker from the effort button', async ($, on) => {
  providerMock(on)
  on('session.model', () => ({ value: 'deepseek-flash[1m]' }))

  const commands: string[] = []
  on('command.run', (_, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'effort' })

  expect(commands).toEqual(['effort'])
  await ui.unmount()
})

test('answers the post-Stop refusal in words the person can act on', () => {
  expect(
    effortFailureMessage(
      'deepseek-status: $.command.run: the session was stopped and nobody has sent input since',
    ),
  ).toBe('会话已停止：先发送任意消息，或点击上方「推理」按钮')

  expect(effortFailureMessage('command failed')).toBe(
    '打开推理等级选择失败：command failed',
  )
  expect(effortFailureMessage('x'.repeat(100))).toBe(
    `打开推理等级选择失败：${'x'.repeat(80)}…`,
  )
})

test('colors the max level like the animation at max effort', async ($, on) => {
  providerMock(on)
  on('session.model', () => ({ value: 'deepseek-flash[1m]' }))
  on('command.run', () => ({
    text: 'Ultracode on (this session only): dynamic workflows on every task. Effort stays max.',
  }))
  on('ui.toast', () => ({ value: undefined }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'effort' })
  await clock.settle()

  expect((await ui.find({ type: 'Button', key: 'effort' }))?.text).toBe(
    '推理 max',
  )
  expect((await ui.find({ type: 'Text', text: 'max' }))?.props.color).toBe(
    'rgb(255,252,235)',
  )
  await ui.unmount()
})

test('recognizes shift+backslash and shift+E only at an empty prompt', () => {
  expect(
    isSwitchChord({
      key: { key: '|', shift: true },
      text: '',
      cursor: 0,
      start: 0,
      end: 0,
      inputText: '|',
    }),
  ).toBe(true)
  expect(
    isSwitchChord({
      key: { key: '\\' },
      text: '',
      cursor: 0,
      start: 0,
      end: 0,
      inputText: '\\',
    }),
  ).toBe(false)
  expect(
    isSwitchChord({
      key: { key: '|', shift: true },
      text: 'x',
      cursor: 1,
      start: 1,
      end: 1,
      inputText: '|',
    }),
  ).toBe(false)

  expect(
    isEffortChord({
      key: { key: 'E', shift: true },
      text: '',
      cursor: 0,
      start: 0,
      end: 0,
      inputText: 'E',
    }),
  ).toBe(true)
  expect(
    isEffortChord({
      key: { key: 'e' },
      text: '',
      cursor: 0,
      start: 0,
      end: 0,
      inputText: 'e',
    }),
  ).toBe(false)
  expect(
    isEffortChord({
      text: '',
      cursor: 0,
      start: 0,
      end: 0,
      inputText: 'E',
    }),
  ).toBe(false)
})

test('draws no row when the session is not on DeepSeek', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.env(on, {
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'sk-test',
  })
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /模型/ })).toBeUndefined()
  await ui.unmount()
})
