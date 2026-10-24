# intervals-training-bridge

An MCP server that lets Claude Code read your [intervals.icu](https://intervals.icu) training data and write planned workouts to your intervals.icu calendar. If your calendar syncs to Garmin Connect, those workouts appear on your watch.

The bridge is deliberately mechanical. It fetches and writes data; all the training judgement stays with you and Claude.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `get_training_context` | Wellness (CTL/ATL/form, resting HR, HRV, sleep), completed activities, planned events, and a planned-versus-completed reconciliation for a date range. Planned events include an `eventId` for update and delete. | No |
| `get_activity_laps` | Per-lap pace, heart rate, power, cadence and gradient for one activity. | No |
| `get_activity_streams` | Time-series for one activity, bucketed (per kilometre by default) with min/avg/max per metric. Never raw samples. | No |
| `push_workout` | Creates a planned workout on a given date. | Yes |
| `update_workout` | Replaces an existing planned workout. | Yes |
| `delete_workout` | Removes a planned workout. | Yes |

### dryRun defaults

`push_workout`, `update_workout` and `delete_workout` all default to `dryRun: true`. A dry run reports what would be written and changes nothing. Claude should only pass `dryRun: false` after you have explicitly approved that specific change.

> **Warning:** `dryRun: false` writes to your real intervals.icu calendar, which syncs to Garmin Connect and onto your watch. `delete_workout` cannot be undone. Always review the dry run first.

Each workout stays in one metric family: all pace or all power. Mixing them breaks intervals.icu's load and time-in-zone calculations. Workouts can be pushed for `run` and `bike`.

## Setup

### 1. Get an intervals.icu API key

In intervals.icu, open Settings, then Developer Settings, and create an API key.

### 2. Create a settings file

Create `config/intervals.env` in your project:

```
INTERVALS_API_KEY=
INTERVALS_ATHLETE_ID=
```

Paste your key after the `=`. `INTERVALS_ATHLETE_ID` is optional. Leave it blank to use the owner of the API key. This file holds a live API key, so keep it out of version control. Add it to your project's `.gitignore`:

```
config/intervals.env
```

### 3. Add the server to Claude Code

Add this to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "intervals-training-bridge": {
      "command": "npx",
      "args": [
        "-y",
        "intervals-training-bridge@^0.2",
        "--stdio",
        "--settings-file",
        "config/intervals.env"
      ]
    }
  }
}
```

Relative settings-file paths resolve against the directory Claude Code launches the server from. As an alternative to the flag, set the `INTERVALS_ENV_FILE` environment variable to the file's path; the flag wins if both are given.

Restart Claude Code, approve the server, and ask it for your recent training.

### Optional settings

These go in the same settings file.

- `LOGS_PATH`: a directory to write `bridge.log` to. Logs always go to stderr, which Claude Code captures. With `--stdio`, no log file is written unless you set this.
- `TIMEZONE`: the time zone that decides what "today" is, for example `Europe/London` or `America/New_York`. Leave it out to use your computer's time zone.

## Requirements

Node.js 20 or later.

## Development

```
npm install
npm run build
npm test
```

## Licence

MIT. See `LICENSE`.
