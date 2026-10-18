# Scheduled prompts

Any senpi session can schedule a prompt to run later: a reminder, a follow-up check, or a recurring task. Scheduled prompts are stored on disk, so they work from `--print` and other headless runs and still fire after the process that scheduled them has exited.

There are two parts:

- The model schedules a prompt with the `schedule_prompt` tool. The tool only writes a job file under `<agent dir>/schedule/` and returns.
- A separate `senpi schedule run` process fires due prompts. Run it once (for example from cron), or keep it running with `--watch` (for example under launchd or systemd).

`/loop` is different: it repeats a prompt inside one interactive session with in-process timers, and it stops when that process exits.

## The `schedule_prompt` tool

`schedule_prompt` is a search-exposed (deferred) tool: it is not in a session's tool list until it is needed, so a session that never schedules anything pays no prompt tokens for it. `tool_search` finds it for requests such as "remind me", "later", "schedule", "cron" or "recurring", and a call by name activates it.

| Parameter | Used by | Meaning |
|---|---|---|
| `action` | all | `create`, `list` (this session's jobs), or `cancel` |
| `prompt` | create | Text delivered to this session when the job fires |
| `delaySeconds` | create | Fire this many seconds from now |
| `at` | create | ISO 8601 date-time with `Z` or a UTC offset, e.g. `2026-09-28T09:00:00+09:00`; a time without one is rejected |
| `everySeconds` | create | Repeat every N seconds (minimum 60, at most 366 days) |
| `id` | cancel | Job id (`sch_...`) |

`create` needs exactly one of `delaySeconds` and `at`. A due time more than a minute in the past, or more than 366 days ahead, is rejected. A prompt may be at most 16 KiB, a session may hold 50 pending jobs, and the agent directory 1000. The result's `runnerAvailable` detail says whether a `senpi schedule run --watch` runner is currently live.

`cancel` is final: nothing is delivered or re-armed after it. If one occurrence was already being delivered, that delivery cannot be recalled and the result says so (`inFlight`).

A job belongs to the session that created it. It records the session id, the session file (when the session is persisted) and the working directory.

## Running due prompts

```bash
senpi schedule run                      # fire what is due now, then exit
senpi schedule run --watch              # keep running; wake at the next due time or when a job is added
senpi schedule list [--json]            # every job, in every state, for all sessions
senpi schedule cancel <id>
```

`run` prints one JSON line per event on stdout:

```json
{"event":"fired","id":"sch_3f9c2a1b7d04","sessionId":"my-session","occurrence":1,"outcome":"delivered","firedAt":1790520000000,"dueAt":1790519990000}
```

Other events: `deferred` (another runner is delivering into the job's session, or the session is open in another process; printed once per reason), `lease_error` (the runner could not refresh its heartbeat; printed once per failure streak), `abandoned` (an occurrence whose runner died mid-delivery, moved to `failed/`), `invalid` (an unreadable job file; printed once per file and reason), and `error` (handling a job, or a whole pass, failed, for example on a permission error: the job stays pending and is retried 15 seconds later, other sessions are unaffected, and a `--watch` runner keeps running). A `--watch` runner also prints `{"event":"watching",...}` when it starts and `{"event":"stopped",...}` after `SIGTERM` or `SIGINT`. One-shot `run` exits `1` when any delivery failed or an `error` was reported, `2` on a usage error, and `0` otherwise.

Every runner holds a lease `<agent dir>/schedule/runners/<pid>.json` with its process identity and a heartbeat refreshed every 30 seconds, also while a delivery runs.

Options:

| Option | Default | Meaning |
|---|---|---|
| `--watch` | off | Keep running |
| `--exec <command>` | none | Deliver through a shell command instead of resuming the session |
| `--poll-seconds <n>` | 60 | Longest `--watch` sleep between scans; a new job and the next due time wake it sooner |
| `--timeout-seconds <n>` | 900 | Time limit for one delivery; the delivery's whole process group (POSIX) or tree (Windows) is killed |
| `--concurrency <n>` | 4 | Sessions delivered in parallel; one session's jobs always run one at a time |

### Default delivery: resume the session

Without `--exec`, the runner resumes the scheduling session headlessly in its working directory:

```bash
senpi -p --session <session file or id> "<message>"
```

The message is the prompt with a one-line header, `[Scheduled prompt <id>: created ..., due ..., fired ...]`, so the model can tell a scheduled turn from a user message.

Deliveries into one session never overlap. Every runner takes the session's delivery lock (`<agent dir>/schedule/sessions/<session>.lock`) before it claims a job and holds it until the delivery has finished, so two runner processes cannot write the same session at once. The lock records the delivery process as well, and the delivery does not start its work until it is recorded (on POSIX it waits on a pipe from the runner, so a runner that dies before recording it runs nothing). If the runner dies while a delivery is still running, the lock is only reclaimed once that delivery has exited: on POSIX the delivery leads its own process group and the lock stays held while any process of that group is alive.

On Windows there are no process groups and no gate: the delivery starts before it can be recorded. Once it is recorded, a dead runner's lock is held while that delivery process is alive; if the runner dies in the moment between the start and the record, the lock marks the delivery as ungated and is held until the runner's delivery time limit (`--timeout-seconds`) has passed. A timeout kills the delivery's process tree with `taskkill /T`; a background process that a hook detaches from its tree is not tracked. Keep `--exec` hooks on Windows in the foreground. A job deferred for any of these reasons is retried 15 seconds later. The default delivery also waits while another senpi process has that session open (an interactive session, for example): the job is deferred and fires once the session is closed. That check runs right before the resume starts; a session opened in the moment between the check and the resume is not detected, the same as two senpi processes opening one session by hand.

### Hook delivery: `--exec`

With `--exec <command>`, the runner starts the command through the shell (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows, with the command passed verbatim, so quoted paths with spaces work) and writes one JSON object to its stdin:

```json
{
  "type": "scheduled_prompt",
  "id": "sch_3f9c2a1b7d04",
  "sessionId": "my-session",
  "sessionFile": "/Users/me/.senpi/agent/sessions/.../my-session.jsonl",
  "cwd": "/Users/me/project",
  "prompt": "Check whether the release workflow finished and summarize it.",
  "message": "[Scheduled prompt sch_3f9c2a1b7d04: created ..., due ..., fired ...]\nCheck whether the release workflow finished and summarize it.",
  "dueAt": 1790519990000,
  "firedAt": 1790520000000,
  "everyMs": null,
  "fireCount": 1
}
```

The command also gets `SENPI_SCHEDULE_ID`, `SENPI_SCHEDULE_SESSION_ID`, `SENPI_SCHEDULE_SESSION_FILE` and `SENPI_SCHEDULE_CWD` in its environment. Exit code `0` means delivered.

Use this when something else owns the session, for example a chat bridge that runs one headless senpi turn per incoming message: the hook hands the prompt to the bridge, which runs it in the right conversation and posts the answer.

## Delivery guarantees

- Each occurrence is delivered at most once. A runner claims occurrence `n` of a due job by renaming its file from `pending/` to `firing/<id>@<n>~<runner>.json`; when several runners race, exactly one claim succeeds.
- A recurring job is re-armed at its next slot right after the claim and before the delivery, so a runner crash can lose at most the occurrence in flight, never the schedule. Missed occurrences (no runner was running) collapse into one delivery.
- If a runner dies while delivering, the next runner finds the occurrence record whose owner is no longer alive and moves it to `failed/` as `abandoned`. It is not retried, because it may already have been delivered. If that runner died before it could re-arm a recurring job, the next runner re-arms it at its next slot.
- A failed delivery is kept as `failed/<id>@<n>.json` with the error in `lastError`, where `senpi schedule list` shows it (the 10 most recent per job); `cancel` removes the job and its failed records, and an in-flight occurrence that fails after the cancel leaves no record.
- Cancelling writes a tombstone before removing anything, and every claim and re-arm checks it afterwards, so a cancelled job never comes back.
- A job file that cannot be parsed, or is larger than 64 KiB, is reported by `list` and `run` and never fired.

## Files

```text
<agent dir>/schedule/
  pending/<id>.json               waiting for its due time
  firing/<id>@<n>~<runner>.json   occurrence n being delivered by a runner
  failed/<id>@<n>.json            occurrence n that failed or was abandoned
  cancelled/<id>                  tombstone of a cancelled job
  sessions/<session>.lock         delivery lock of a session
  runners/<pid>.json              lease and heartbeat of each live runner
```

Files are written atomically with mode `0600` in `0700` directories.
