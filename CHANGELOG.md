# Changelog

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
