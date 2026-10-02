import type { Register } from 'claude-code'

// One line above the prompt with every usage figure:
//
//   ◔ 5h 7% resets 1:19 PM  │  ◑ Week 46% resets Sat 2:30 PM  │  ○ Context 16% 164k / 1M  │  Opus 5.5 · $2.14
//
// The rings are SVG on the desktop and pie glyphs in the terminal.
//
// Plan limits come from the engine when it has them (exact reset times). Desktop
// sessions often get none, so we fall back to the app's own usage samples and
// work the reset times out: the 5-hour window runs five hours from when it
// started filling, and the weekly window resets at the same moment every week,
// taken from the `weekly_reset` option or detected from where the weekly figure
// last dropped.

const HOUR = 3_600_000
const FIVE_HOURS = 5 * HOUR
const WEEK = 7 * 24 * HOUR
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']


type Limit = { key: string; label: string; pct: number; resetsAt?: number; isEstimate?: boolean }
type AppSample = { t: number; org?: string; u: { fh?: number; sd?: number } }

function colorFor(pct: number) {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'yellow'
  return 'green'
}

const RING_HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149' }

// A small progress ring for the desktop, which draws SVG.
function ringSvg(pct: number) {
  const r = 5.5
  const c = 2 * Math.PI * r
  const on = (Math.max(0, Math.min(pct, 100)) / 100) * c
  const stroke = RING_HEX[colorFor(pct)]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">` +
    `<circle cx="7" cy="7" r="${r}" fill="none" stroke="#8b949e" stroke-opacity="0.3" stroke-width="2"/>` +
    `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" ` +
    `stroke-dasharray="${on.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 7 7)"/>` +
    `</svg>`
  )
}

// The terminal can't draw SVG, so it gets a pie glyph.
function pieGlyph(pct: number) {
  if (pct < 12.5) return '○'
  if (pct < 37.5) return '◔'
  if (pct < 62.5) return '◑'
  if (pct < 87.5) return '◕'
  return '●'
}

function clock(at: number, now: number) {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date(now).toDateString()) return time
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function compact(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

// The next moment matching a weekly time such as "Sat 14:30", "saturday 2:30 pm"
// or "Sat 2pm", in local time; undefined when the text doesn't read as one.
function prettyModel(id: string) {
  const m = id.replace(/\[.*\]$/, '').match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (!m) return id
  const name = m[1][0].toUpperCase() + m[1].slice(1)
  return m[3] && m[3].length <= 2 ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

function nextConfiguredReset(text: string, now: number) {
  const m = text.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return undefined
  const day = DAYS.indexOf(m[1])
  let hour = Number(m[2])
  const minute = Number(m[3] ?? 0)
  if (day < 0 || minute > 59) return undefined
  if (m[4]) {
    if (hour < 1 || hour > 12) return undefined
    hour = (hour % 12) + (m[4] === 'pm' ? 12 : 0)
  } else if (hour > 23) {
    return undefined
  }
  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  at.setDate(at.getDate() + ((day - at.getDay() + 7) % 7))
  if (at.getTime() <= now) at.setDate(at.getDate() + 7)
  return at.getTime()
}

// The weekly figure falls back to near zero when its window resets, somewhere
// between the reading before the drop and the one after. The app only samples
// while it's open, so that gap can be days: each drop gives a window the reset
// fell in, and since the reset repeats weekly, overlapping the windows of every
// drop narrows it down. A time is only given once that's within a few hours.
const DETECT_PRECISION = 3 * HOUR

function nextDetectedReset(samples: AppSample[], now: number) {
  const windows: Array<[number, number]> = []
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].u.sd, cur = samples[i].u.sd
    if (prev != null && cur != null && prev - cur >= 5 && cur <= prev / 2) {
      windows.push([samples[i - 1].t, samples[i].t])
    }
  }
  if (!windows.length) return undefined

  // Start from the latest drop and narrow it with the earlier ones, each moved
  // forward by whole weeks; one that doesn't overlap is ignored.
  let [lo, hi] = windows[windows.length - 1]
  for (const [l, h] of windows.slice(0, -1)) {
    const shift = Math.round((hi - h) / WEEK) * WEEK
    const nlo = Math.max(lo, l + shift), nhi = Math.min(hi, h + shift)
    if (nlo <= nhi) [lo, hi] = [nlo, nhi]
  }
  if (hi - lo > DETECT_PRECISION) return undefined

  const resetAt = (lo + hi) / 2
  return resetAt + Math.ceil((now - resetAt) / WEEK) * WEEK
}

// The current 5-hour window started where the latest run of non-zero readings
// began: after a zero reading, a drop, or a gap longer than a window.
function fiveHourStart(samples: AppSample[]) {
  let i = samples.length - 1
  if (!(samples[i]?.u.fh! > 0)) return undefined
  while (i > 0) {
    const prev = samples[i - 1], cur = samples[i]
    const restarted = !(prev.u.fh! > 0) || prev.u.fh! > cur.u.fh! || cur.t - prev.t > FIVE_HOURS
    if (restarted) {
      // A zero reading shortly before is the closest we have to the first message.
      return !(prev.u.fh! > 0) && cur.t - prev.t < 30 * 60_000 ? prev.t : cur.t
    }
    i--
  }
  return samples[0].t
}

// Where the desktop app keeps its usage samples: %APPDATA%\Claude on Windows,
// ~/Library/Application Support/Claude on macOS, ~/.config/Claude on Linux.
async function usageFilePath($: any) {
  const appData = await $.env.get('APPDATA').catch(() => undefined)
  if (appData) return `${appData}\\Claude\\plan-usage-history.json`
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) throw new Error('no home directory')
  for (const dir of [`${home}/Library/Application Support/Claude`, `${home}/.config/Claude`]) {
    if (await $.fs.exists(`${dir}/plan-usage-history.json`)) return `${dir}/plan-usage-history.json`
  }
  throw new Error('no usage file')
}

async function appLimits($: any, now: number, weeklyReset: string): Promise<Limit[]> {
  try {
    const json = JSON.parse(await $.fs.read(await usageFilePath($)))
    const all: AppSample[] = (json.samples ?? []).filter((s: AppSample) => s && s.u)
    const last = all[all.length - 1]
    if (!last) return []
    // The file can hold readings from more than one account: keep the current one's.
    const samples = all.filter(s => s.org === last.org)

    const limits: Limit[] = []

    if (last.u.fh != null) {
      const start = fiveHourStart(samples)
      const resetsAt = start != null ? start + FIVE_HOURS : undefined
      const isExpired = resetsAt == null || resetsAt <= now
      limits.push({
        key: 'five_hour',
        label: '5h',
        pct: isExpired ? 0 : last.u.fh,
        resetsAt: isExpired ? undefined : resetsAt,
        isEstimate: true,
      })
    }

    if (last.u.sd != null) {
      const configured = weeklyReset ? nextConfiguredReset(weeklyReset, now) : undefined
      const resetsAt = configured ?? nextDetectedReset(samples, now)
      // A reading from before the last weekly reset belongs to the old week.
      const isStale = resetsAt != null && last.t < resetsAt - WEEK
      limits.push({
        key: 'seven_day',
        label: 'Week',
        pct: isStale ? 0 : last.u.sd,
        resetsAt,
        isEstimate: configured == null,
      })
    }

    return limits
  } catch {
    return []
  }
}

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']

export const register: Register = (on, options) => {
  const weeklyReset = String((options as any)?.weekly_reset ?? '')

  on('session.start', async ($, e, next) => {
    // Keep the countdowns and the app's samples fresh between turns.
    $.clock.every(15_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  // Pushed by the engine after each turn and whenever a limit moves a point.
  on('session.measure', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Mid-turn, each tool call follows a fresh model response, so the context
  // figure has moved: redraw then too instead of waiting for the turn to end.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey owns the band while it's up.
    if (e.props.hasSurvey) return next(e)

    const now = Date.now()
    const usage = await $.session.usage()

    let limits: Limit[] = [...(usage.rateLimits ?? [])]
      .sort((a, b) => {
        const ia = ORDER.indexOf(a.kind), ib = ORDER.indexOf(b.kind)
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
      })
      .map(l => ({
        key: l.kind,
        label: LABELS[l.kind] ?? l.kind,
        pct: l.percentUsed,
        resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : undefined,
      }))
    if (!limits.length) limits = await appLimits($, now, weeklyReset)

    const ctx = usage.context
    const cost = usage.cost?.usd
    let model = ""
    try {
      model = prettyModel(await $.session.model())
    } catch {}

    type Segment = { key: string; label: string; pct: number; details: string[] }
    const segments: Segment[] = []

    for (const l of limits) {
      const tilde = l.isEstimate ? "~" : ""
      let details: string[] = []
      if (l.resetsAt != null) {
        // The time it resets at: just the time today, with the day when it's later.
        details = [`resets ${tilde}${clock(l.resetsAt, now)}`, `↻ ${tilde}${clock(l.resetsAt, now)}`]
      } else if (l.key === "five_hour") {
        details = ["starts on your next message", "next message"]
      }
      segments.push({ key: l.key, label: l.label, pct: l.pct, details })
    }

    if (ctx?.percent != null) {
      const tokens = ctx.tokens != null ? `${compact(ctx.tokens)} / ${compact(ctx.window)}` : ""
      segments.push({ key: "context", label: "Context", pct: ctx.percent, details: tokens ? [tokens] : [] })
    }

    const els = $.ui.resolve(e) as any
    const { Box, Text } = els

    if (!segments.length) {
      return (
        <Box paddingX={1} width="100%" justifyContent="center">
          <Text dimColor>Usage appears after the first reply</Text>
        </Box>
      )
    }

    // Fit one line: drop the cost, then shorten the reset phrases, then drop the
    // context tokens, then the model, then the reset phrases altogether.
    const GAP = 2
    const SEP_WIDTH = 1 + 2 * GAP
    const costText = cost != null ? `$${cost.toFixed(2)}` : ""
    type Plan = { detail: number; cost: boolean; tokens: boolean; model: boolean }
    const tailText = (p: Plan) => [p.model ? model : "", p.cost ? costText : ""].filter(Boolean).join(" · ")
    const width = (p: Plan) => {
      const segs = segments.reduce((sum, s, i) => {
        const detail = s.key === "context" ? (p.tokens ? s.details[0] ?? "" : "") : s.details[p.detail] ?? ""
        return sum + (i ? SEP_WIDTH : 0) + 2 + s.label.length + 1 + `${Math.round(s.pct)}%`.length + (detail ? 1 + detail.length : 0)
      }, 0)
      const tail = tailText(p)
      return segs + (tail ? SEP_WIDTH + tail.length : 0) + 2
    }
    const cols = e.props.bodyColumns ?? 200
    const plans: Plan[] = [
      { detail: 0, cost: true, tokens: true, model: true },
      { detail: 0, cost: false, tokens: true, model: true },
      { detail: 1, cost: false, tokens: true, model: true },
      { detail: 1, cost: false, tokens: false, model: true },
      { detail: 1, cost: false, tokens: false, model: false },
      { detail: 2, cost: false, tokens: false, model: false },
    ]
    const plan = plans.find(p => width(p) <= cols) ?? plans[plans.length - 1]

    const Svg = e.surface === "desktop" ? els.Svg : undefined
    // A quiet grey divider; dimColor alone tints oddly on some surfaces.
    const sep = (key: string) => <Text key={key} color="#6e7681">│</Text>

    const parts: any[] = []
    segments.forEach((s, i) => {
      const color = colorFor(s.pct)
      const detail = s.key === "context" ? (plan.tokens ? s.details[0] : undefined) : s.details[plan.detail]
      const ring = Svg
        ? <Svg key="ring" source={ringSvg(s.pct)} alt={`${s.label} ${Math.round(s.pct)}% used`} width={14} height={14} />
        : <Text key="ring" color={color}>{pieGlyph(s.pct)}</Text>
      if (i) parts.push(sep(`sep-${s.key}`))
      parts.push(
        <Box key={s.key} flexDirection="row" gap={1} flexShrink={0} alignItems="center">
          {ring}
          <Text dimColor>{s.label}</Text>
          <Text color={color} bold>{`${Math.round(s.pct)}%`}</Text>
          {detail ? <Text dimColor>{detail}</Text> : null}
        </Box>,
      )
    })
    const tail = tailText(plan)
    if (tail) {
      parts.push(sep("sep-tail"))
      parts.push(<Text key="tail" dimColor wrap="truncate-end">{tail}</Text>)
    }

    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="center" alignItems="center" width="100%" gap={GAP} paddingX={1} overflow="hidden">
        {parts}
      </Box>
    )
  })
}
