import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } as any,
} as const

test('engine limits show exact reset times, context, model and cost on one line', async ($, on) => {
  const in2h = new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString()
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 82000, window: 200000, percent: 41 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 27, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        { kind: 'five_hour', percentUsed: 58, resetsAt: in2h },
      ],
      cost: { usd: 2.14 },
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.render', () => null as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^5h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^58%$/ })).toBeDefined()
    // The 5-hour reset shows as a clock time, exact (no "~") when the engine gives it.
    const fiveHourTime = new Date(in2h).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const resets = (await ui.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)
    expect(resets.some(t => t.endsWith(fiveHourTime) && !t.includes('~'))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^Week$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^82k \/ 200k$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Opus 5\.5 · \$2\.14$/ })).toBeDefined()
    // A divider between each of the three figures and before the model and cost.
    expect((await ui.findAll({ type: 'Text', text: /^│$/ })).length).toBe(3)
    await ui.unmount()
  }
})

test('falls back to the app usage file and estimates reset times', async ($, on) => {
  const now = Date.now()
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 141000, window: 1000000, percent: 14 }, rateLimits: [] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\\AppData' }))
  on('fs.read', () => ({
    value: JSON.stringify({
      version: 2,
      samples: [
        { t: now - 40 * 60_000, u: { fh: 0, sd: 45 } }, // window starts here
        { t: now - 30 * 60_000, u: { fh: 4, sd: 45 } },
        { t: now - 2 * 60_000, u: { fh: 7, sd: 46 } },
      ],
    }),
  }))
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^7%$/ })).toBeDefined()
  // Window started 40 minutes ago, so it resets 4h 20m from now, marked as an estimate.
  const fiveHourTime = new Date(now - 40 * 60_000 + 5 * 3_600_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const resets = (await ui.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)
  expect(resets.some(t => t.startsWith('resets ~') && t.endsWith(fiveHourTime))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^46%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^141k \/ 1M$/ })).toBeDefined()
  await ui.unmount()
})

test('an expired 5-hour window reads 0% and waits for the next message', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\\AppData' }))
  on('fs.read', () => ({
    value: JSON.stringify({ version: 2, samples: [{ t: Date.now() - 6 * 3_600_000, u: { fh: 30, sd: 10 } }] }),
  }))
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^0%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /starts on your next message/ })).toBeDefined()
  await ui.unmount()
})

test('desktop draws SVG rings, the terminal draws pie glyphs', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 160000, window: 1000000, percent: 16 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 46, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.render', () => null as any)

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' } as any)).toBeDefined()
  await desk.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /^◑$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^◔$/ })).toBeDefined()
  await term.unmount()
})

test('finds the app usage file on macOS', async ($, on) => {
  // Paths come back in the host's own form, so compare them with forward slashes.
  const isMac = (p: string) => p.split('\\').join('/').endsWith('/Users/k/Library/Application Support/Claude/plan-usage-history.json')
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? '/Users/k' : undefined }) as any)
  on('fs.exists', (_$, e: any) => ({ value: isMac(e.path) }) as any)
  on('fs.read', (_$, e: any) => ({
    value: isMac(e.path) ? JSON.stringify({ version: 2, samples: [{ t: Date.now() - 60_000, u: { fh: 0, sd: 33 } }] }) : '',
  }) as any)
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^33%$/ })).toBeDefined()
  await ui.unmount()
})

const APP_FILE = (samples: unknown[]) => ({ value: JSON.stringify({ version: 2, samples }) })

test('the weekly_reset option gives an exact weekly reset time', { options: { weekly_reset: 'Sat 14:30' } }, async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\AppData' }))
  on('fs.read', () => APP_FILE([{ t: Date.now() - 60_000, u: { fh: 0, sd: 46 } }]))
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const resets = (await ui.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)
  const weekly = resets.find(t => /2:30/.test(t))
  expect(weekly).toBeDefined()
  expect(weekly).not.toMatch(/~/) // exact, so no "~"
  await ui.unmount()
})

test('without the option, the weekly reset is detected from the last drop', async ($, on) => {
  const now = Date.now()
  const dropAt = now - 2 * 86_400_000 // reset two days ago, so the next is in ~5 days
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\AppData' }))
  on('fs.read', () =>
    APP_FILE([
      { t: dropAt - 3_600_000, u: { fh: 0, sd: 88 } },
      { t: dropAt, u: { fh: 0, sd: 1 } },
      { t: now - 60_000, u: { fh: 0, sd: 12 } },
    ]),
  )
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^12%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^resets ~\w{3} / /* estimated day and time */ })).toBeDefined()
  await ui.unmount()
})

test('a narrow band keeps the cost and drops the token count instead of wrapping', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 340000, window: 1000000, percent: 34 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 16, resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 50, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
      ],
      cost: { usd: 11.15 },
    },
  }))
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 50 } })
  expect(await ui.find({ type: 'Text', text: /^16%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^34%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$11\.15/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^340k/ })).toBeUndefined()
  await ui.unmount()
})

const APP_ONLY = (on: any, samples: unknown[]) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\AppData' }))
  on('fs.read', () => APP_FILE(samples))
  on('ui.render', () => null as any)
}

test('a drop seen only after a long gap gives no weekly time rather than a wrong one', async ($, on) => {
  const now = Date.now()
  APP_ONLY(on, [
    { t: now - 4 * 86_400_000, org: 'a', u: { fh: 0, sd: 60 } },
    { t: now - 2 * 86_400_000, org: 'a', u: { fh: 0, sd: 2 } }, // reset somewhere in these two days
    { t: now - 60_000, org: 'a', u: { fh: 0, sd: 9 } },
  ])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^9%$/ })).toBeDefined()
  const resets = (await ui.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)
  expect(resets).toEqual([]) // the 5-hour row says "starts on your next message" instead
  await ui.unmount()
})

test('several weekly resets are overlapped to pin the time down', async ($, on) => {
  const WEEK = 7 * 86_400_000
  const reset = Date.now() - 2 * 86_400_000 // the true reset, two days ago
  APP_ONLY(on, [
    // Two weeks ago: seen within a wide 20-hour window, ending an hour after the reset.
    { t: reset - 2 * WEEK - 19 * 3_600_000, org: 'a', u: { fh: 0, sd: 70 } },
    { t: reset - 2 * WEEK + 3_600_000, org: 'a', u: { fh: 0, sd: 3 } },
    // Last week: another wide window, starting an hour before the reset.
    { t: reset - WEEK - 3_600_000, org: 'a', u: { fh: 0, sd: 80 } },
    { t: reset - WEEK + 30 * 3_600_000, org: 'a', u: { fh: 0, sd: 4 } },
    // This week: wide again, but together they leave a two-hour window.
    { t: reset - 10 * 3_600_000, org: 'a', u: { fh: 0, sd: 75 } },
    { t: reset + 10 * 3_600_000, org: 'a', u: { fh: 0, sd: 2 } },
    { t: Date.now() - 60_000, org: 'a', u: { fh: 0, sd: 11 } },
  ])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const expected = new Date(reset + WEEK).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const resets = (await ui.findAll({ type: 'Text', text: /^resets ~/ })).map(t => t.text)
  expect(resets.some(t => t.endsWith(expected))).toBe(true)
  await ui.unmount()
})

test("another account's readings in the file are ignored", async ($, on) => {
  const now = Date.now()
  APP_ONLY(on, [
    { t: now - 3 * 3_600_000, org: 'other', u: { fh: 0, sd: 90 } },
    { t: now - 2 * 3_600_000, org: 'mine', u: { fh: 0, sd: 20 } }, // not a reset: different account
    { t: now - 60_000, org: 'mine', u: { fh: 0, sd: 22 } },
  ])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^22%$/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^resets / })).length).toBe(0)
  await ui.unmount()
})

// A store every session on the machine shares, kept in memory for the test.
const STORE = (on: any) => {
  const store = new Map<string, unknown>()
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }) as any)
  on('store.set', (_$: any, e: any) => (store.set(e.key, e.value), { value: undefined }) as any)
  return store
}

test('exact figures from one session are reused in a session that has none', async ($, on) => {
  const now = Date.now()
  const fiveHourReset = now + 3 * 3_600_000
  const weekReset = now + 2 * 86_400_000
  STORE(on)
  let engineHasLimits = true
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1000000 },
      rateLimits: engineHasLimits
        ? [
            { kind: 'five_hour', percentUsed: 32, resetsAt: new Date(fiveHourReset).toISOString() },
            { kind: 'seven_day', percentUsed: 52, resetsAt: new Date(weekReset).toISOString() },
          ]
        : [],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\AppData' }))
  // The app's own reading is older than the saved one, and its estimates are off.
  on('fs.read', () => APP_FILE([{ t: now - 3_600_000, org: 'a', u: { fh: 20, sd: 50 } }]))
  on('ui.render', () => null as any)

  const first = await $.ui.mount({ ...BAND, surface: 'desktop' }) // saves the exact figures
  await first.unmount()

  engineHasLimits = false
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^32%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^52%$/ })).toBeDefined()
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const resets = (await ui.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)
  expect(resets.some(t => t.endsWith(time(fiveHourReset)) && !t.includes('~'))).toBe(true)
  expect(resets.some(t => t.endsWith(time(weekReset)) && !t.includes('~'))).toBe(true)
  await ui.unmount()
})

test('a saved weekly reset that has passed rolls on a week, and the old week reads 0%', async ($, on) => {
  const now = Date.now()
  const store = STORE(on)
  const passedReset = now - 86_400_000 // reset a day ago
  store.set('rateLimits', {
    at: now - 2 * 86_400_000,
    limits: [{ kind: 'seven_day', percentUsed: 88, resetsAt: new Date(passedReset).toISOString() }],
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: 'C:\AppData' }))
  on('fs.read', () => APP_FILE([{ t: now - 3 * 86_400_000, org: 'a', u: { fh: 0, sd: 88 } }])) // also last week
  on('ui.render', () => null as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^0%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^88%$/ })).toBeUndefined()
  const next = new Date(passedReset + 7 * 86_400_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const resets = (await ui.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)
  expect(resets.some(t => t.endsWith(next) && !t.includes('~'))).toBe(true)
  await ui.unmount()
})

const ENGINE = (on: any, value: object) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [], ...value } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.render', () => null as any)
}
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

test('a limit used faster than its window passes is marked with ⚠', async ($, on) => {
  STORE(on)
  ENGINE(on, {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 70, resetsAt: inHours(4) }, // 70% used, 20% of the window gone
      { kind: 'seven_day', percentUsed: 30, resetsAt: inHours(24) }, // 30% used, ~86% gone
    ],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text', text: /^⚠$/ })).length).toBe(1)
  await ui.unmount()
})

test('alerts pop up once at 80%, and again when the limit resets', async ($, on) => {
  const memory = STORE(on)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }) as any)
  let resetsAt = inHours(2)
  let pct = 83
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.render', () => null as any)

  for (let i = 0; i < 2; i++) (await $.ui.mount({ ...BAND, surface: 'desktop' })).unmount()
  expect(toasts.filter(t => t.startsWith('5-hour limit at 83%')).length).toBe(1) // once, not per redraw

  // The window passes: a new one starts and the alert says so.
  const alerts = memory.get('alerts') as any
  memory.set('alerts', { ...alerts, windows: { ...alerts.windows, five_hour: Date.now() - 60_000 } })
  resetsAt = inHours(5)
  pct = 1
  await (await $.ui.mount({ ...BAND, surface: 'desktop' })).unmount()
  expect(toasts).toContain('5-hour limit has reset')
})

test('alerts can be turned off', { options: { alerts: false } }, async ($, on) => {
  STORE(on)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }) as any)
  ENGINE(on, { rateLimits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: inHours(1) }] })
  await (await $.ui.mount({ ...BAND, surface: 'desktop' })).unmount()
  expect(toasts).toEqual([])
})

test('a context over 70% full offers a Compact button that compacts', async ($, on) => {
  STORE(on)
  let compacted = 0
  let percent = 72
  on('session.compact', () => (compacted++, { value: {} }) as any)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: percent * 10000, window: 1000000, percent }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.render', () => null as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'compact' })
    await ui.unmount()
  }
  expect(compacted).toBe(2)

  // At exactly 70% it isn't offered yet.
  percent = 70
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'compact' } as any)).toBeUndefined()
  await ui.unmount()
})

test('desktop rings carry a hover tooltip', async ($, on) => {
  STORE(on)
  ENGINE(on, { rateLimits: [{ kind: 'seven_day', percentUsed: 52, resetsAt: inHours(30) }] })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const ring: any = await ui.find({ type: 'Svg' } as any)
  expect(ring?.props?.isInteractive ?? ring?.isInteractive).toBe(true)
  expect(String(ring?.props?.source ?? ring?.source)).toContain('<title>Weekly limit: 52% used')
  await ui.unmount()
})
