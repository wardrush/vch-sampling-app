# Agent reports

One file per agent per wave: `<agent-name>-wave<n>.md`. One file each is what makes
parallel writes safe — never append to another agent's file, and never write a shared
`REPORTS.md`.

`fleet-integrator` reads every file here at the end of a wave and writes
`wave-<n>-integration.md` beside them. The orchestrator reads that.

## Why the file matters more than the final message

Your closing message to the orchestrator gets summarised into a conversation that will
later be compacted. **The file is the durable record.** Anything a future instance needs
— a prop API, a blocked item, a name you could not confirm — belongs here, not only in
what you say back.

## Template

```markdown
# <agent-name> — wave <n>

**Tasks:** <ids from TASK_BOARD.md>
**Gate:** `npm run typecheck && npm test` → <pass / fail, with counts>
(Note: this ran against a tree other agents were still writing to. See FLEET.md §4.5.)

## Landed
| Task | Files | What it does |
|---|---|---|

## Contract or interface changes others need
<A published prop API, a changed exported type, a new module boundary.
 Code block, not prose. Empty is a valid answer — say "none".>

## Stopped, and why
<Anything unspecified that you did NOT invent a value for. Name the exact
 threshold / table name / behaviour, and where you stopped. This section is
 the most valuable one in the file.>

## Needs from another agent
<Also append to integration/requests-<a|b|c>.md if it is a code change in
 someone else's paths.>

## Files touched
<`git status --short` output, verbatim. Confirms nothing landed at the wrong path.>
```

## Rules

- **Report what is true.** If tests fail, say which and paste the output. If you
  skipped part of the task, say which part and why. A report claiming more than the
  diff supports is worse than no report — `fleet-integrator` checks reports against the
  diff and a mismatch is a finding.
- **"Stopped, and why" empty is suspicious on a haiku-tier task.** That tier exists
  because the spec is complete; when it is not, stopping is the correct outcome and
  reporting it is the deliverable.
- **Never delete or edit another agent's report**, including in a later wave.
