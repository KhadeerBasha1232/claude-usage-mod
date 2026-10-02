# claude-usage-mod

Your Claude plan usage, always visible: a one-line band **directly above the prompt** in Claude Code.

```
◔ 5h 72% ⚠ resets 1:19 PM  │  ◑ Week 50% resets Sat 2:30 PM  │  ○ Context 40% 404k / 1M  │  Opus 5.5 · $13.24 (+$0.41)
```

- **5h**: your 5-hour session limit, with the time it resets
- **Week**: your weekly limit, with its reset time
- **Context**: how full this chat's context window is, in tokens
- **Model** and this session's **cost** at API prices, with what the last reply added (you aren't charged this on a Pro/Max plan)

It also helps you stay ahead of your limits:

- **Pace warning ⚠**: shown next to a limit you're using faster than its window is passing, so you know you'll run out before it resets.
- **Limit alerts**: a pop-up when the 5-hour or weekly limit reaches 80% and 95%, and when it resets. Each shows once.
- **Compact button**: appears in the band once the context window is over 70% full. Click it to compact the conversation.
- **Tooltips**: in the desktop app, hover over a ring for the details.

Each of these can be turned off in [Settings](#settings).

Each figure has a small progress ring (pie glyphs `○ ◔ ◑ ◕ ●` in the terminal) that turns **yellow at 70%** and **red at 90%**. The band updates live: every 15 seconds, after each step Claude takes, and after every reply. It always stays on one line: in a narrow window it shortens the reset times to `↻ 1:19 PM`, then drops the token count, then the model. The cost always stays.

Works in the **Claude desktop app (Code tab)** on macOS and Windows, and in **`claude` in the terminal**.

## Install

In a Claude Code chat:

```
/plugin marketplace add KhadeerBasha1232/claude-usage-mod
/plugin install usage-band@claude-usage-mod
```

Then fully quit and reopen Claude (in the terminal, `/reload-plugins` is enough). In a new chat the band appears after your first message, once Claude Code has started.

Or from your shell:

```bash
claude plugin marketplace add KhadeerBasha1232/claude-usage-mod
claude plugin install usage-band@claude-usage-mod
```

**Requires** Claude Code with mod support (v2.1.286 or later).

**Tip:** [turn on auto-update](#turn-on-auto-update-recommended) so you get new versions without doing anything.

## Where the numbers come from

| Figure | Source |
|---|---|
| 5h / Week | Claude Code's own rate-limit figures, which give exact reset times. Claude Code only reports them in some sessions, and only after a reply, so the band **saves the last exact figures** and every chat on your computer reuses them. Until it has seen exact figures once, it falls back to the usage history the Claude desktop app keeps on your computer (`plan-usage-history.json`). |
| Context, model, cost | Claude Code's session figures |

Saved reset times stay exact: the weekly one rolls on a week at a time, and the percentage always comes from the newest reading. Only when the band has never seen exact figures are the reset times worked out from the app's history, marked with `~`:

- **5-hour reset**: five hours from when the current window started filling (usually within a few minutes of the real time).
- **Weekly reset**: detected from when your weekly figure dropped back down. The app only records usage while it's open, so a reset is often only noticed hours or days later. The band shows a detected time only once it can pin it down to within about 3 hours (it gets better as more weeks of history build up). Until then the weekly figure shows without a time. **For an exact time from day one, set `weekly_reset` (below).**

The band only reads local files. It makes no network requests and never touches your credentials.

## Settings

| Option | What it does |
|---|---|
| `weekly_reset` | **Recommended.** Your weekly limit's reset time in local time, e.g. `Sat 14:30` or `Saturday 2:30 PM`. You can find it in Claude **Settings → Usage**. Leave empty to detect it automatically. |
| `alerts` | Pop-ups at 80% and 95% and when a limit resets. On by default. |
| `pace` | The ⚠ pace warning. On by default. |
| `compact_button` | The Compact button once the context is over 70% full. On by default. |
| `reply_cost` | The last reply's cost next to the session cost. On by default. |
| `tooltips` | Hover tooltips on the rings in the desktop app. On by default. |

Set it with:

```
/plugin configure usage-band@claude-usage-mod
```

## Update

### Turn on auto-update (recommended)

Claude Code doesn't auto-update third-party marketplaces unless you ask it to. Turn it on once and you'll get new versions by yourself:

1. In a Claude Code chat, run `/plugin`.
2. Go to the **Marketplaces** tab and select **claude-usage-mod**.
3. Select **Enable auto-update**.

In the desktop app, use the same `/plugin` command in a Code tab chat.

Or add `"autoUpdate": true` to the marketplace's entry in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "claude-usage-mod": {
    "source": { "source": "github", "repo": "KhadeerBasha1232/claude-usage-mod" },
    "autoUpdate": true
  }
}
```

With auto-update on, Claude Code checks for a new version a few minutes after your first message in a chat. When it finds one, it shows `Plugin updated: usage-band · Run /reload-plugins to apply`, and your next chat loads it.

### Update by hand

```
/plugin marketplace update claude-usage-mod
```

## Uninstall

```
/plugin uninstall usage-band@claude-usage-mod
```

## Development

```bash
claude plugin validate --strict plugins/usage-band
claude plugin test plugins/usage-band
```

To try changes live, run `claude --plugin-dir plugins/usage-band`. Saving a file reloads the mod.

## License

[MIT](LICENSE)
