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

test('a narrow band drops the cost and token counts instead of wrapping', async ($, on) => {
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
  expect(await ui.find({ type: 'Text', text: /\$11\.15/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^340k/ })).toBeUndefined()
  await ui.unmount()
})
