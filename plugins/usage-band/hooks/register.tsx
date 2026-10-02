import type { Register } from 'claude-code'

// One line above the prompt with every usage figure:
//
//   ◔ 5h 7% resets in 4h 39m    ◑ Week 46% resets Sat 2:30 PM    ○ Context 16% 164k / 1M    $2.14
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
type AppSample = { t: number; u: { fh?: number; sd?: number } }

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

function duration(ms: number) {
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
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

// The weekly figure falls back to (near) zero when its window resets: the last
// such drop marks a reset, and every later one is a whole week on.
function nextDetectedReset(samples: AppSample[], now: number) {
  for (let i = samples.length - 1; i > 0; i--) {
    const prev = samples[i - 1].u.sd, cur = samples[i].u.sd
    if (prev != null && cur != null && prev - cur >= 5) {
      const resetAt = samples[i].t
      return resetAt + Math.ceil((now - resetAt) / WEEK) * WEEK
    }
  }
  return undefined
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
    const samples: AppSample[] = (json.samples ?? []).filter((s: AppSample) => s && s.u)
    const last = samples[samples.length - 1]
    if (!last) return []

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

    type Segment = { key: string; label: string; pct: number; details: string[] }
    const segments: Segment[] = []

    for (const l of limits) {
      const tilde = l.isEstimate ? "~" : ""
      let details: string[] = []
      if (l.resetsAt != null) {
        // The 5-hour window reads best as a countdown, the weekly one as a day and time.
        details = l.key === "five_hour"
          ? [`resets in ${tilde}${duration(l.resetsAt - now)}`, `${tilde}${duration(l.resetsAt - now)}`]
          : [`resets ${tilde}${clock(l.resetsAt, now)}`, `${tilde}${clock(l.resetsAt, now)}`]
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
    // context tokens, then the reset phrases altogether.
    const GAP = 4
    const costText = cost != null ? `$${cost.toFixed(2)}` : ""
    const width = (detailLevel: number, withCost: boolean, withTokens: boolean) =>
      segments.reduce((sum, s, i) => {
        const detail = s.key === "context" ? (withTokens ? s.details[0] ?? "" : "") : s.details[detailLevel] ?? ""
        return sum + (i ? GAP : 0) + 2 + s.label.length + 1 + `${Math.round(s.pct)}%`.length + (detail ? 1 + detail.length : 0)
      }, 0) + (withCost && costText ? GAP + costText.length : 0) + 2
    const cols = e.props.bodyColumns ?? 200
    const plans: Array<[number, boolean, boolean]> = [[0, true, true], [0, false, true], [1, false, true], [1, false, false], [2, false, false]]
    const [detailLevel, withCost, withTokens] = plans.find(([d, c, t]) => width(d, c, t) <= cols) ?? plans[plans.length - 1]

    const Svg = e.surface === "desktop" ? els.Svg : undefined

    const parts = segments.map(s => {
      const color = colorFor(s.pct)
      const detail = s.key === "context" ? (withTokens ? s.details[0] : undefined) : s.details[detailLevel]
      const ring = Svg
        ? <Svg key="ring" source={ringSvg(s.pct)} alt={`${s.label} ${Math.round(s.pct)}% used`} width={14} height={14} />
        : <Text key="ring" color={color}>{pieGlyph(s.pct)}</Text>
      return (
        <Box key={s.key} flexDirection="row" gap={1} flexShrink={0} alignItems="center">
          {ring}
          <Text dimColor>{s.label}</Text>
          <Text color={color} bold>{`${Math.round(s.pct)}%`}</Text>
          {detail ? <Text dimColor>{detail}</Text> : null}
        </Box>
      )
    })
    if (withCost && costText) parts.push(<Text key="cost" dimColor wrap="truncate-end">{costText}</Text>)

    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="center" alignItems="center" width="100%" gap={GAP} paddingX={1} overflow="hidden">
        {parts}
      </Box>
    )
  })
}
