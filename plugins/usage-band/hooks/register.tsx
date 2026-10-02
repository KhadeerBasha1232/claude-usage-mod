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


type Limit = { key: string; label: string; pct: number; resetsAt?: number; isEstimate?: boolean; readAt?: number }
type AppSample = { t: number; org?: string; u: { fh?: number; sd?: number } }

function colorFor(pct: number) {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'yellow'
  return 'green'
}

const RING_HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149' }

// A small progress ring for the desktop, which draws SVG; its title is the
// tooltip shown on hover.
function ringSvg(pct: number, title = '') {
  const r = 5.5
  const c = 2 * Math.PI * r
  const on = (Math.max(0, Math.min(pct, 100)) / 100) * c
  const stroke = RING_HEX[colorFor(pct)]
  const safe = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">` +
    (safe ? `<title>${safe}</title>` : '') +
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
        readAt: last.t,
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
        readAt: last.t,
      })
    }

    return limits
  } catch {
    return []
  }
}

// The last exact figures Claude Code reported, kept in the store every session
// on this machine shares: Claude Code only reports them in some sessions, and
// only after a reply, so the others borrow them.
type Saved = { at: number; limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }> }
const SAVED_KEY = 'rateLimits'
const PERIOD: Record<string, number> = { five_hour: FIVE_HOURS, seven_day: WEEK }

// An exact reset that has passed moves on by whole windows for the weekly
// limit; a passed 5-hour reset says nothing about the next window.
function rollForward(kind: string, resetsAt: number, now: number) {
  if (resetsAt > now) return resetsAt
  return kind === 'seven_day' ? resetsAt + Math.ceil((now - resetsAt) / WEEK) * WEEK : undefined
}

// Saved exact reset times win over estimated ones. The percentage is the newest
// reading of the current window: the saved one, or the app's if it's newer, or
// zero when the window has reset since either was taken.
function withSaved(saved: Saved | undefined, app: Limit[], now: number): Limit[] {
  if (!saved?.limits?.length) return app
  const kinds = ORDER.filter(k => app.some(a => a.key === k) || saved.limits.some(l => l.kind === k))
  const out: Limit[] = []
  for (const kind of kinds) {
    const a = app.find(l => l.key === kind)
    const s = saved.limits.find(l => l.kind === kind)
    const exact = s?.resetsAt ? rollForward(kind, Date.parse(s.resetsAt), now) : undefined
    if (s == null || exact == null) {
      if (a) out.push(a)
      continue
    }
    const windowStart = exact - (PERIOD[kind] ?? WEEK)
    const readings = [
      { pct: s.percentUsed, at: saved.at },
      ...(a?.readAt != null ? [{ pct: a.pct, at: a.readAt }] : []),
    ].filter(r => r.at >= windowStart)
    const newest = readings.sort((x, y) => y.at - x.at)[0]
    out.push({ key: kind, label: LABELS[kind] ?? kind, pct: newest ? newest.pct : 0, resetsAt: exact })
  }
  return out
}

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }

// Using a limit faster than its window is passing: at least 20% used, and more
// than 15 points ahead of the share of the window that has gone by.
function isAhead(l: Limit, now: number) {
  const period = PERIOD[l.key]
  if (l.resetsAt == null || period == null || l.pct < 20) return false
  const elapsed = Math.min(1, Math.max(0, 1 - (l.resetsAt - now) / period))
  return l.pct / 100 > elapsed + 0.15
}

// Pop-ups when a limit crosses 80% and 95%, and when one resets. Each fires once
// per window, remembered in the store every session shares so two open chats
// don't both show it.
type Alerts = { fired: string[]; windows: Record<string, number> }
const ALERTS_KEY = 'alerts'
const THRESHOLDS = [95, 80]

async function raiseAlerts($: any, limits: Limit[], now: number) {
  const state = ((await $.store.get(ALERTS_KEY).catch(() => undefined)) ?? { fired: [], windows: {} }) as Alerts
  let changed = false
  for (const l of limits) {
    if (l.resetsAt == null || PERIOD[l.key] == null) continue
    const name = NAMES[l.key] ?? l.label

    // The window moved on since we last looked: it has reset.
    const prev = state.windows[l.key]
    if (prev == null || Math.abs(prev - l.resetsAt) > 30 * 60_000) {
      if (prev != null && prev <= now && l.resetsAt > prev) $.ui.toast(`${name} has reset`)
      state.windows[l.key] = l.resetsAt
      changed = true
    }

    // Name the window by the hour it resets in, so small shifts in an estimate don't re-fire.
    const crossed = THRESHOLDS.find(t => l.pct >= t)
    const id = crossed && `${l.key}:${Math.round(l.resetsAt / HOUR)}:${crossed}`
    if (id && !state.fired.includes(id)) {
      $.ui.toast(`${name} at ${Math.round(l.pct)}% · resets ${clock(l.resetsAt, now)}`, { timeoutMs: 8000 })
      state.fired = [...state.fired, id].slice(-40)
      changed = true
    }
  }
  if (changed) await $.store.set(ALERTS_KEY, state).catch(() => {})
}

export const register: Register = (on, options) => {
  // What this session last saved, so an unchanged reading isn't written again.
  let lastSaved = ''
  const weeklyReset = String((options as any)?.weekly_reset ?? '')
  // Every extra is on unless its option is set to false.
  const isOn = (name: string) => (options as any)?.[name] !== false
  const showAlerts = isOn('alerts')
  const showPace = isOn('pace')
  const showCompact = isOn('compact_button')
  const showReplyCost = isOn('reply_cost')
  const showTooltips = isOn('tooltips')

  // What the session had cost when the current reply started, and what the last
  // finished reply added.
  let turnStartCost: number | undefined
  let lastReplyCost: number | undefined

  on('turn.start', async ($, e, next) => {
    turnStartCost = (await $.session.usage()).cost?.usd
    return next(e)
  })

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
    const cost = (await $.session.usage()).cost?.usd
    if (cost != null && turnStartCost != null && cost > turnStartCost) lastReplyCost = cost - turnStartCost
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
    if (usage.rateLimits?.length) {
      const fresh = JSON.stringify(usage.rateLimits)
      if (fresh !== lastSaved) {
        lastSaved = fresh
        await $.store.set(SAVED_KEY, { at: now, limits: usage.rateLimits } satisfies Saved).catch(() => {})
      }
    } else {
      const saved = (await $.store.get(SAVED_KEY).catch(() => undefined)) as Saved | undefined
      limits = withSaved(saved, await appLimits($, now, weeklyReset), now)
    }
    if (showAlerts) await raiseAlerts($, limits, now)

    const ctx = usage.context
    const cost = usage.cost?.usd
    let model = ""
    try {
      model = prettyModel(await $.session.model())
    } catch {}

    type Segment = { key: string; label: string; pct: number; details: string[]; ahead?: boolean; tooltip: string }
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
      const ahead = showPace && isAhead(l, now)
      const tooltip = [
        `${NAMES[l.key] ?? l.label}: ${Math.round(l.pct)}% used`,
        l.resetsAt != null ? `resets ${l.isEstimate ? "about " : ""}${clock(l.resetsAt, now)}` : "",
        ahead ? "using it faster than the window is passing" : "",
      ].filter(Boolean).join(" · ")
      segments.push({ key: l.key, label: l.label, pct: l.pct, details, ahead, tooltip })
    }

    if (ctx?.percent != null) {
      const tokens = ctx.tokens != null ? `${compact(ctx.tokens)} / ${compact(ctx.window)}` : ""
      const tooltip = `Context window: ${ctx.percent}% full${ctx.tokens != null ? ` · ${ctx.tokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens` : ""}`
      segments.push({ key: "context", label: "Context", pct: ctx.percent, details: tokens ? [tokens] : [], tooltip })
    }
    // Offer to compact once the context is nearly full.
    const offerCompact = showCompact && (ctx?.percent ?? 0) >= 85

    const els = $.ui.resolve(e) as any
    const { Box, Text } = els

    if (!segments.length) {
      return (
        <Box paddingX={1} width="100%" justifyContent="center">
          <Text dimColor>Usage appears after the first reply</Text>
        </Box>
      )
    }

    // Fit one line, always keeping the cost: shorten the reset phrases to "↻",
    // then drop the context tokens, then the model, then the reset phrases.
    const GAP = 2
    const SEP_WIDTH = 1 + 2 * GAP
    const replyCost = showReplyCost && lastReplyCost != null && lastReplyCost >= 0.005 ? ` (+$${lastReplyCost.toFixed(2)})` : ""
    const costText = cost != null ? `$${cost.toFixed(2)}${replyCost}` : ""
    const COMPACT_WIDTH = "Compact".length + GAP
    type Plan = { detail: number; cost: boolean; tokens: boolean; model: boolean }
    const tailText = (p: Plan) => [p.model ? model : "", p.cost ? costText : ""].filter(Boolean).join(" · ")
    const width = (p: Plan) => {
      const segs = segments.reduce((sum, s, i) => {
        const detail = s.key === "context" ? (p.tokens ? s.details[0] ?? "" : "") : s.details[p.detail] ?? ""
        return sum + (i ? SEP_WIDTH : 0) + 2 + s.label.length + 1 + `${Math.round(s.pct)}%`.length + (s.ahead ? 2 : 0) + (detail ? 1 + detail.length : 0)
      }, 0)
      const tail = tailText(p)
      return segs + (offerCompact ? COMPACT_WIDTH : 0) + (tail ? SEP_WIDTH + tail.length : 0) + 2
    }
    const cols = e.props.bodyColumns ?? 200
    const plans: Plan[] = [
      { detail: 0, cost: true, tokens: true, model: true },
      { detail: 1, cost: true, tokens: true, model: true },
      { detail: 1, cost: true, tokens: false, model: true },
      { detail: 1, cost: true, tokens: false, model: false },
      { detail: 2, cost: true, tokens: false, model: false },
    ]
    const plan = plans.find(p => width(p) <= cols) ?? plans[plans.length - 1]

    const Svg = e.surface === "desktop" ? els.Svg : undefined
    // A quiet grey divider; dimColor alone tints oddly on some surfaces.
    const sep = (key: string) => <Text key={key} color="#6e7681">│</Text>

    const { Button } = els
    const parts: any[] = []
    segments.forEach((s, i) => {
      const color = colorFor(s.pct)
      const detail = s.key === "context" ? (plan.tokens ? s.details[0] : undefined) : s.details[plan.detail]
      // An interactive SVG shows its <title> as a tooltip on hover.
      const ring = Svg
        ? showTooltips
          ? <Svg key="ring" source={ringSvg(s.pct, s.tooltip)} alt={s.tooltip} width={14} height={14} isInteractive />
          : <Svg key="ring" source={ringSvg(s.pct)} alt={s.tooltip} width={14} height={14} />
        : <Text key="ring" color={color}>{pieGlyph(s.pct)}</Text>
      if (i) parts.push(sep(`sep-${s.key}`))
      parts.push(
        <Box key={s.key} flexDirection="row" gap={1} flexShrink={0} alignItems="center">
          {ring}
          <Text dimColor>{s.label}</Text>
          <Text color={color} bold>{`${Math.round(s.pct)}%`}</Text>
          {s.ahead ? <Text key="ahead" color="yellow">⚠</Text> : null}
          {detail ? <Text dimColor>{detail}</Text> : null}
          {s.key === "context" && offerCompact && Button
            ? <Button key="compact" label="Compact" plain onPress={() => { $.session.compact().catch(() => {}) }} />
            : null}
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
