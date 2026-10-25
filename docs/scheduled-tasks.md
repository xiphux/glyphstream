# Scheduled tasks

A scheduled task is a prompt that runs on its own: "every weekday at 7, search my
inbox for anything that needs a reply and summarize it", "every six hours, check
the status page and tell me if anything changed". Set them up in **Settings →
Scheduled tasks**.

Each run is an ordinary conversation, so everything that works on a chat works on
a run: you can reply to it, branch it, retry it, find it in search. Runs are
marked with a clock in the sidebar, named after the schedule and the day
("Morning brief — Oct 25"), and you get a [notification](notifications.md) when
one finishes, needs your approval, or fails.

## Setting one up

- **What to ask** — the prompt, sent as the run's first message. Today's date is
  given to the model as it is in every chat, so "since yesterday" means what you
  expect.
- **Model** — any chat model, or one of your
  [custom models](models.md#custom-models). A custom model's prompt and settings
  are copied in when you save the schedule, so later edits to the preset reach
  the schedule only when you save it again.
- **When** — at a time of day on chosen weekdays (every day, weekdays, one day a
  week…), or every few hours. Times are in the schedule's time zone, which
  defaults to yours. A time that doesn't exist on a daylight-saving night (02:30
  as the clocks jump forward) runs as many minutes late as the jump; a time that
  happens twice (as they fall back) runs once.
- **Deadline** — how long after its time a run may still start. See
  [Sharing the GPU](#sharing-the-gpu).
- **Built-in features** — web access, your persona and memories, the code
  interpreter, canvas and skills, each on or off for the schedule's runs, like a
  chat's feature toggles. Runs can read your memories but don't save to them
  unless you tick **Let runs save to your memories** — a daily summary of your
  inbox shouldn't fill them up.
- **MCP tools** — see below.

**Run now** starts a run straight away, whatever the schedule says and even
while it's turned off. It's the way to try a prompt out, and to retry one that
failed. A schedule runs one at a time, so Run now is refused while one of its
runs is queued or in progress.

## Tools: Off, Ask, Allow

A run happens with nobody watching, so every MCP tool gets one of three settings
for each schedule:

| Setting   | What a run does with it                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| **Off**   | Not offered. The model can't use it — and if it names it anyway, the call is refused. The default.          |
| **Ask**   | Offered. When the model calls it, the run pauses and notifies you; you Allow or Reject in the conversation. |
| **Allow** | Offered, and runs without asking. Only for tools you'd trust with nobody watching.                          |

Your account-wide **Allow always** list (Settings → Permissions) doesn't apply to
runs: the schedule's own settings decide. A tool set to Allow everywhere else
still asks in a run if the schedule says Ask.

When a run pauses on a tool, the approval prompt in its conversation has two
extra choices:

- **Always for this schedule** — runs the call and sets the tool to Allow, so
  future runs don't ask.
- **Never for this schedule** — rejects the call and sets the tool to Off, so
  future runs aren't offered it.

Either way you only answer once. A run waiting for approval holds nothing — no
place in the queue, no GPU — so there's no hurry; after a week it's closed out
as expired.

Be careful with **Allow** on tools that _change_ things (send, delete, post).
What a run reads — an email, a web page — can contain instructions, and with
nobody watching, a tool that runs unasked is a tool that text can trigger.

## Before a run starts

The run checks that the MCP servers its tools come from are reachable. A server
that failed earlier gets one fresh connection attempt. If one still isn't there,
the run fails with the reason — "Mail is unreachable", or "needs your token —
add it in Settings → MCP servers" — rather than producing a confident summary of
nothing.

A run also fails if the schedule's model has since been removed from the
server's configuration.

## When runs fail

The run history (the clock icon on each schedule) lists every run, newest first,
with what happened and a link to its conversation. A failed run's conversation
shows the error where the reply would be.

A schedule that fails three times in a row turns itself off (the operator can
change the number), and says why on the settings page. Saving it, or turning it
back on, re-arms it.

If the server is down when a run was due, it doesn't replay every missed run when
it comes back: it runs the latest one, if that's still within its deadline, and
records the rest as missed. A run that was in progress when the server restarted
is marked as interrupted, and you're notified — press Run now to try again.

## Sharing the GPU

Runs go through the same queue as everyone else's chats, with one difference:
they always let a person go first. A run waits behind anyone waiting on a reply,
including people who arrive after it — but once it has started, it finishes; it
is never interrupted to make room.

On a busy box a run could wait a long time, so each schedule has a **deadline**:
a run that hasn't started that many minutes after its time doesn't run, and
you're notified. (A morning brief that finally runs at 3pm is worth less than
knowing it didn't.) It counts as a failed run, so a schedule that keeps missing
its deadline [turns itself off](#when-runs-fail) like any other — a sign it
wants a quieter time. On the admin **Endpoints** page, a run shows up as **Scheduled task**.

Everyone in a household tends to pick 07:00, so each schedule fires at its own
fixed offset of up to three minutes after its time, rather than all at once.

Scheduled runs don't count toward the per-person cap on queued generations
([`max_queued_generations_per_user`](multi-user.md#capping-one-persons-queue)) —
schedules have [their own limits](#for-operators).

## Retention

Each schedule keeps its last 30 runs' conversations; older ones are deleted
(their entries stay in the run history). A conversation you're still meant to
act on — a run waiting for your approval — is never deleted. Deleting a schedule
keeps its past runs' conversations.

## For operators

Everything is optional; the defaults suit a household.

```toml
[scheduled_tasks]
enabled = true                # false hides the feature and stops the runner
max_per_user = 10             # schedules per non-admin user; unset = no cap
min_interval_hours = 1        # the floor on "every N hours"
default_deadline_minutes = 120
keep_runs = 30                # run conversations kept per schedule
disable_after_failures = 3    # failures in a row before a schedule turns itself off
```

Admins are never held to `max_per_user`. Changing `enabled` needs a restart.
