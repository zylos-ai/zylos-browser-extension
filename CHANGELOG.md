# Changelog

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
