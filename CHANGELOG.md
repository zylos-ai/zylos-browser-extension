# Changelog

## [Unreleased]

### Added

- Add a default-off compatibility permission scoped to the current task. It allows
  removal of inspected, revalidated foreign extension frames during recovery and
  is cleared on task changes, completion, stop or disconnect.
- In compatibility mode, separate input preparation from text dispatch so a
  focus-time detach can recover before sending text once. Revalidate the original
  document, node, value and caret; never replay uncertain text input.
- Allow a connected Agent to start a task with explicit, revocable permission for
  the current worker session. Starts use new task tabs, negotiated support and a
  bounded request-ID ledger; duplicate or uncertain requests never repeat effects.
- Retain the latest consented fault snapshot for up to 24 hours in memory, bounded
  to 2 MiB. Live detailed capture still ends after 10 minutes. Export, explicit
  clear and one-time sharing remain separate from metadata diagnostics.

### Fixed

- Wait for an Agent-started task page to become readable before its first context.
- Preserve recovery scan scope across transport interruption, reject incomplete
  child-frame probes and record each probe outcome. Keep detailed fault exports
  compatible with the existing Remote schema.
- Detect silent relay loss after 60 seconds without valid inbound traffic, fence
  late socket callbacks and preserve the existing bounded task recovery deadline.
- Discover selected foreign extension iframe candidates in closed shadow roots
  only after negotiating support. Older Remote versions retain open-root scans;
  original-document checks, one-use removal and no input replay remain enforced.

## [0.17.1] - 2026-10-21

Pairs with Zylos Browser Remote 0.10.2. Update Remote before reloading the
extension to enable negotiated recovery and selected iframe removal.

### Changed

- Download a fresh diagnostic snapshot directly. Keep raw JSON and hashes in
  optional collapsible details, show an accurate empty-log state, and preserve
  explicit consent and recipient disclosure for each prepared sharing snapshot.

- Add negotiated recovery-only inspection of foreign extension iframe candidates.
  Explicit Agent selection can remove selected saved nodes once before recovery,
  with original-document checks, one-use authorization, bounded isolated-world
  scans and no input replay. Report possible removal on interrupted attempts;
  reinjected frames are not automatically removed again.

- Restore nested child-frame sessions during control recovery, and fence delayed
  initialization after consent revocation. Verify missing task groups separately
  from styling failures and record bounded cleanup timeout/failure diagnostics.
- Permit a later independent disconnect to request recovery after a successful
  attempt, with a maximum of three attempts per task and two in any 30 seconds.
  Each disconnect retains its single-use token and failure remains terminal.

- Revalidate the original editable element after input preview and select text
  immediately before the single fill insertion. Preserve native debugger errors
  and fail before input when focus, editability or element identity changes.
- Keep snapshot results from available frames when an explicitly unavailable
  child frame or its layout disappears; mark partial output and discard that
  frame's refs. Root/control/scope failures still propagate.
- Treat task-group presentation updates as best effort. Clear removed group
  references while preserving an authorized borrowed tab; never regroup tabs
  removed from an owned task's scope.
- Negotiate bounded Agent-directed control recovery for eligible parent
  `target_closed` events in the same live task. Pause for at most 120 seconds,
  allow one explicit recovery attempt with a 10-second budget, and return fresh
  observations without replaying prior input. Stop, cancellation, scope loss,
  expiry and unsuccessful recovery terminate; persistent browser restrictions
  are not bypassed.

- Combine detailed capture, bounded CDP/iframe diagnostics and one-time sharing
  in a schema-2 incident bundle. Record exact task/action correlations, runtime
  at the trigger, limited non-value page state and explicit capture gaps for
  debugger detach, control loss and operation errors. Preserve the reviewed
  snapshot and hash; Remote transport evidence remains a separate companion.
  Diagnostics alone do not trigger recovery, replay actions or infer a root cause.

- Add separate, explicit one-time sharing of a prepared detailed diagnostic file with the configured Remote over WSS. Grants expire within two minutes and are revoked on disconnect, capture disable or configuration changes. Viewing file details is optional; explicit sharing consent remains required.

- Add a separate, default-off detailed local capture for extension console text
  and Error stacks. Keep at most ten minutes, 1 MiB and 1,000 events in worker
  memory; clear on disable, expiry, connection changes or worker restart.
  Download a fresh JSON file directly with a SHA-256 identifier, with optional
  collapsible file details.
  Preserve the existing safe Remote diagnostics contract: detailed logs are
  never automatically shared or exposed through diagnostics.get.

- Show successful reconnection in the existing connection status for three
  seconds, then return to Connected. Keep offline/reconnecting notices visible
  and guard delayed dismissal against newer recovery states and panel reopening.

- Give viewport and document-text extraction independent elapsed-time budgets,
  so a slow overview does not consume the following document read's allowance.
  Make DOM content tests use a controlled clock and explicitly test timeout
  truncation without relaxing form/editor privacy assertions.

- Negotiate `task-resume-v1` to preserve a live task across temporary transport
  loss for at most two minutes. Reconcile runtime/task/request identity and
  acknowledge queued request, owner-input and terminal frames without replaying
  browser actions. Pause new operations until reconnection and keep started
  operation results. Show localized recovery state and durable failure notices.
  Stop, control revocation, configuration changes and process restarts cannot
  revive the old task. Requires a compatible Remote.

- Preserve completed research-operation receipts when a later browser action loses
  control, and include research operations in the diagnostic event stream.
- Mark mid-task diagnostic capture as partial while retaining local task correlation;
  distinguish consent-revision and queued-command cancellation checks.
- Synchronize the authoritative plugin protocol and development documentation.

- End active browser work consistently when control is revoked. Preserve bounded
  completed, uncertain and not-executed action receipts in the interrupted
  terminal response instead of discarding prior successes or requesting another
  decision that could implicitly reattach. New user input is required to begin
  another task; actions are never replayed by this recovery path.

- Add an owner-controlled diagnostic sharing switch, disabled by default. The
  connected agent can retrieve task, operation, control, transport and runtime
  metadata with local task/operation correlation through `diagnostics-v2`.
- Keep at most 1,000 events, 256 KiB and 30 minutes in session storage. Return
  the actual manifest version, filtered snapshot pages, capture epoch, restart,
  overflow and storage-health information without claiming complete raw logs.
- Observe background and sidepanel errors, rejections and console severity
  without collecting console arguments, exception messages/stacks or page data.
- Serialize consent and recipient changes, clear on disable, reject stale
  queued events and revoke sharing before saving a different relay or key.

### Limits

- Selected iframe removal scans the original root document and open shadow roots,
  not closed shadow roots or embedded documents. It may affect other extension
  UI; detection does not establish the cause of a disconnect. Removal is not
  rolled back when recovery fails, and Stop cannot retract an already-authorized
  in-flight mutation. Persistent restrictions or reinjection may still end tasks.
- Recovery does not survive a worker or Remote process restart. Diagnostic
  capture is bounded and partial; no complete DevTools recording is claimed.

## [0.17.0] - 2026-10-09

Pairs with Zylos Browser Remote 0.10.0; Remote needs no update.

### Changed

- The page context sent with a message is now an overview instead of the first
  6000 characters of page text. It contains what the owner currently sees and a
  heading outline of the whole page, so content scrolled into view is no longer
  lost behind navigation and page headers.
- The viewport digest lists visible text, headings, links, buttons and form
  field labels as `- role "name"` lines, matching the snapshot format, with
  scroll position and the remaining height below. It respects fixed headers and
  scroll-container clipping, and skips controls covered by dialogs. Form values
  are still omitted, and lines carry no action refs.
- The outline lists page headings with their offsets in the page text and marks
  the owner's current section. The Agent reads page text with read-page from
  offset 0, or jumps to a heading offset with the context's contentVersion.
- When the page context exceeds its size budget, deeper outline headings are
  removed first, then the outline tail, and the viewport last. Text is trimmed
  to fit at line boundaries instead of being halved.

### Upgrade notes

Questions about the visible part of a page can be answered from the first
request. Questions about the whole page now take one read-page round. Pages
without heading elements have an empty outline.

## [0.16.0] - 2026-09-30

Pairs with Zylos Browser Remote 0.10.0.

### Added

- Follow-up messages during an active task are sent immediately through Remote
  to C4. Decisions acknowledge the latest input before executing further actions.
- Expandable public Agent progress includes commentary, decision summaries and
  limited tool activity. History is stored locally with bounded retention.

### Changed

- Progress is expanded by default while a task runs and follows the latest user
  message. Completion collapses it; it can be opened again.
- An empty composer shows the stop button during a task. Entering text or adding
  an attachment switches it back to send. Follow-up status badges are removed.
- Tasks have no total-duration or decision-round limit, and browser actions no
  longer inherit a default execution deadline. Connection handshakes and bounded
  page-readiness checks retain their own timeouts.

### Fixed

- Closing the task's tab clears its preview and prevents late frames from
  restoring the closed preview.

### Upgrade notes

Update Remote to 0.10.0 before loading this extension to enable direct follow-up
input and public Agent history. Existing connection settings and local chat
history are retained when updating the same extension installation. Stopping a
task interrupts it; it does not create a resumable paused task.
