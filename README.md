# claude-usage-mod

Your Claude plan usage, always visible: a one-line band **directly above the prompt** in Claude Code.

```
◔ 5h 16% resets in 4h 12m    ◑ Week 50% resets Sat 2:29 PM    ○ Context 34% 340k / 1M    $11.15
```

- **5h**: your 5-hour session limit, with when it resets and how long until then
- **Week**: your weekly limit, with its reset time
- **Context**: how full this chat's context window is, in tokens
- **Cost**: this session's cost at API prices (you aren't charged this on a Pro/Max plan)

Each figure has a small progress ring (pie glyphs `○ ◔ ◑ ◕ ●` in the terminal) that turns **yellow at 70%** and **red at 90%**. The band updates live: every 15 seconds, after each step Claude takes, and after every reply. It always stays on one line: in a narrow window it drops the cost, then shortens the reset times, then drops the token count.

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

## Where the numbers come from

| Figure | Source |
|---|---|
| 5h / Week | Claude Code's own rate-limit figures when it has them, which give exact reset times. Desktop sessions often don't get them, so the band falls back to the usage history the Claude desktop app keeps on your computer (`plan-usage-history.json`). |
| Context, model, cost | Claude Code's session figures |

When it uses the app's history, the reset times are worked out, and marked with `~`:

- **5-hour reset**: five hours from when the current window started filling (usually within a few minutes of the real time).
- **Weekly reset**: detected from when your weekly figure last dropped back down. For an exact time, set it yourself (below).

The band only reads local files. It makes no network requests and never touches your credentials.

## Settings

| Option | What it does |
|---|---|
| `weekly_reset` | Your weekly limit's reset time in local time, e.g. `Sat 14:30` or `Saturday 2:30 PM`. You can find it in Claude **Settings → Usage**. Leave empty to detect it automatically. |

Set it with:

```
/plugin configure usage-band@claude-usage-mod
```

## Update

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
