# Control-loss terminal receipts

An operation may have completed before its following snapshot fails. Previously,
STOPPED discarded that operation's result, while an earlier control-loss callback
could return reading mode and allow another model decision to reacquire control.

The round now records an execution receipt for each requested action and detects
revocation separately from normal task-target changes. Actual revocation or a
STOPPED observation terminates the task. It never requests another decision,
repeats an action, or reattaches automatically. Initial selection failures that
never acquired control remain ordinary recoverable errors.

The optional `interruption` field on an `agent-turn-end` with status `interrupted`
contains only:

```json
{
  "reason": "CONTROL_LOST",
  "results": [
    { "method": "fill", "outcome": "completed" },
    { "method": "click", "outcome": "not-executed" }
  ],
  "observation": "unavailable",
  "resume": "new-user-message-required"
}
```

`completed` means the action call returned; it does not claim that a subsequent
snapshot verified the page. `uncertain` means the call started but did not return
successfully, so a side effect may have occurred. `not-executed` means the action
was not dispatched. The report contains at most ten allowlisted method/outcome
pairs and no action arguments, page output or error text.

The paired Remote change returns the receipt through the original decision's
terminal response. Older Remote versions may omit the extra evidence, but the
task still ends as interrupted. User Stop and connection cancellation remain
immediate and cannot be reversed by a late result. A new owner message starts
the existing normal selection flow; it is not an automatic replay or guaranteed
recovery. In particular, Chrome can refuse debugger attachment while a foreign
extension frame remains on the page.

This fixes loss reporting and consent consistency. It does not prevent every
Chrome debugger detach or establish the cause of a remote user's incident.
