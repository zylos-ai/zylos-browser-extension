# Agent-directed control recovery

Control recovery is separate from WebSocket transport resume. It is negotiated
with `recovery-judgment-v1`; older peers retain terminal control-loss behavior.

## State transitions

An active task receiving a matching parent `target_closed` may retain its task
scope in memory while browser actions are suspended. This is not proof that
the cause was nonhuman: the cause is explicitly unknown. The plugin offers an
Agent judgment only while the original task consent remains valid.

The new request has `execution.mode: recovery`, a single-use recovery ID, an
absolute expiry and the original completed/uncertain/not-executed receipts.
Only one `recover-control` action, or a terminal done/blocked response, is
accepted. Ordinary actions and mixed recovery/action batches are rejected.

The suspension expires after 120 seconds and cannot be extended by another
decision or WebSocket resume. Each disconnect permits one attempt, with at most
three attempts per task and two attempts in any rolling 30 seconds. A later
independent disconnect may receive a new judgment only after successful recovery;
failure, Stop or expiry remains terminal. Exhausting either budget ends control
without offering another attempt. Each attempt has at most 10 seconds including
attachment and observation. Normal Agent task
execution has no new overall deadline.

Recovery requires the same live task, original tab and window, exact URL and
valid task scope. It checks the parent document before and after observation.
It never selects another active tab, creates a replacement, reloads or replays
input. Without explicit candidate selection it does not remove frames.
Successful recovery returns fresh observations and
refs; Agent must evaluate prior side effects before deciding further actions.

Stop, debugger cancellation, scope loss, configuration change or task replacement
revoke recovery. Timeout/failure/revocation terminate with a control-loss receipt
and optional `recoveryOutcome: expired | failed | revoked`. A worker restart
does not restore the token or task. Real browser restrictions can prevent recovery.

During initialization, events from the original tab and its registered child
sessions rebuild nested frame connections before observation. This does not
restore the normal action grant. Stop, expiry and task changes invalidate frame
initialization, including delayed child setup after an awaited native call.

## Explicit Extension Frame Selection

The optional `recovery-frame-selection-v1` capability enables a recovery-only
`inspect-recovery-frames` action when the original document ID was captured
before control loss. Inspection uses an isolated-world script, not CDP. It
returns opaque candidate IDs and extension origins, never iframe contents or
URL paths. The snapshot covers the top document and open shadow roots only;
it does not inspect closed shadow roots or child documents. A candidate is not
proof of the failure's cause. Scans are bounded to 10,000 elements, 16 candidates,
32 levels and 100 ms; repeats return the same snapshot without resetting expiry.

Agent may pass explicitly chosen `selectedCandidateIds` to `recover-control`.
Only those saved node identities are removed, once, before the single attachment
attempt. Each node must still be connected to the original document with the
same src and a foreign `chrome-extension:` origin. Own-extension, HTTP, about and
srcdoc frames are excluded. The original tab, window, URL, document ID and task
consent are checked again. Removal can disrupt another extension's UI; automatic
reinjection is not removed again. A failed attachment remains terminal.

The removal script requests a one-use background authorization bound to its
nonce, recovery token and authenticated sender tab/document. Stop or expiry
before authorization rejects it. After authorization, synchronous removal is an
in-flight effect and cannot be retracted by Stop. A queued revocation and local
deadline checks narrow that boundary but are not a browser cancellation API.
An interrupted selected attempt reports that removal may already have occurred
and was not rolled back. Successful recovery reports the confirmed removal count.
Inspection and selected removal have no automatic retry and do not replay input.

## Asynchronous cleanup

Timeout does not cancel a native Chrome attachment call. The executor retains
serialized attachment ownership and cleans up a late successful attachment
before another attachment can use that queue. A failed late detach fences that
tab for the current worker lifetime. A permanently hung native call can keep
attachment work queued; it must not revive the old task. Terminal delivery does
not wait indefinitely for cleanup.

## Action compatibility

Fill prepares focus, waits for visual preview, then revalidates the original
node and establishes the replacement selection immediately before one native
insertion. Type preserves the caret. This narrows a race; it cannot make two
separate browser commands atomic. Replaced, readonly, disabled, sensitive or
unfocused targets fail without automatic re-resolution or retry.

Snapshots may omit an explicitly unavailable advertised child frame or missing
child layout, with `partial: true` and warnings. Failed frames contribute no
refs or values. Root failures, scope changes, native debugger errors and unknown
errors propagate. A partial snapshot is not evidence of complete page coverage.

Task group title/color updates are cosmetic and best effort. A deleted group
cannot strand an authorized borrowed original tab. An owned target that leaves
its group remains out of scope; existing user-moved tabs are not regrouped.
