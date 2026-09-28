# Message attachments

The extension uses ordered `message.content` blocks for user text, quotes,
images and files. Requests use the version 2 message/context/execution envelope.
The composer supports text, quotes and arbitrary files. The plus button opens a
multi-file picker; clipboard files and files dropped on the composer use the same validation.
Draft attachments appear as equal-sized tiles to the right of the plus button,
wrapping within the composer when space is limited,
while the selection stays above the text input.
PNG, JPEG, WebP and GIF display thumbnails; other formats (including SVG/HEIC)
display a compact file icon with name and size on hover. Sent history retains
file cards with visible names and sizes. Unknown MIME types fall back to
`application/octet-stream`; no extension allowlist restricts file selection.
All attachments (including quotes) share the eight-item limit and 5,250,000-byte
binary budget. Image signatures/decoding, empty files and aggregate bytes are
checked before sending. An invalid batch leaves existing draft attachments intact.
Attachments can be removed, and failed submissions retain text and files.
Attachment-only submissions supply localized text for compatibility with existing
Remote versions requiring nonempty user text; image-only prompts retain their wording.

## Owner attachments

The panel submits `remote-chat-send.message: {role: "user", content: [...]}`.
The background validates the contents, saves a display-only history projection,
and sends `agent-request.message: {id, role, content}` on the first round.
Later rounds carry `message: {id}` only, so the original bytes are not resent.

```json
{
  "message": {
    "id": "task-1",
    "role": "user",
    "content": [
      { "type": "text", "text": "Compare this quote with the file" },
      {
        "id": "quote-1",
        "type": "quote",
        "text": "The selected passage",
        "truncated": false,
        "source": {
          "contextId": "task-1",
          "url": "https://example.com/article",
          "title": "Article"
        }
      },
      {
        "id": "file-1",
        "type": "file",
        "name": "notes.txt",
        "mimeType": "text/plain",
        "bytes": 5,
        "data": "aGVsbG8="
      }
    ]
  }
}
```

This is the wire representation. The captured page appears separately and only
once in `context.pages`; quotes belong to the user's message, not page metadata.
See [the full message protocol](EXTENSION-WEBSOCKET-PROTOCOL.md).

Inside the extension, a quote's `source` contains `tabId`, `documentId`, `url`,
`title` and optionally `selectionVersion`. These are used to verify that the
displayed selection still belongs to the captured document. Before transport,
the private DOM binding is replaced with the validated `contextId`, URL and title.
Quotes retain the existing 4,000-character limit and fail sending if their source
document changes. Old local `selection` history entries are migrated on read.

## Binary attachments

Images and files use the same fields: `id`, `type`, `name`, `mimeType`, `bytes`
and base64 `data`. `type` is `image` or `file`. Images support PNG, JPEG, WebP and
GIF; other MIME types use `file`, including non-previewable image formats.
File names are labels, never filesystem paths. Remote preserves safe filename
suffixes for document readers while generating its own unique storage basename.
Empty files, path separators, malformed encodings and size mismatches are rejected.
All binary attachments in a message share a 5,250,000-byte decoded budget (at most
7,000,000 base64 characters), leaving space under the 8 MiB WebSocket frame limit.

Remote advertises `attachments-v1` in its `ready.capabilities`. The extension
refuses user image/file submissions without this capability, before storing or
sending the message. All new plugins require `agent-message-v2`; update Remote first.
The updated Remote normalizes older client requests at ingress. Remote continues to accept older nested `{mimeType,data}` screenshots.

Remote writes private files on the **Agent host** and replaces `data` with
`path` and `imageReadRequired: true` or `fileReadRequired: true`. The path is not
sent from the user's computer. No public file URL, arbitrary path lookup or
remote URL fetch is introduced. The Agent must actually read the resource;
metadata alone is not image or document content. Unsupported document readers
remain an Agent limitation, independent of successful binary transport.

Chrome history stores file/image metadata and optional small JPEG thumbnails, never
the original binary data or Agent-host paths. Thumbnails are generated locally with
a maximum dimension of 256 px and a 24,000-character data URL limit. The panel passes
them in the local-only `remote-chat-send.imagePreviews` map, separate from
`message.content`. They never enter the Agent request. History retains at most
1,000,000 thumbnail characters, discarding older previews (but keeping their image
metadata) when necessary. Clearing history also clears its thumbnails. Monitor
redacts transport attachment data, including short encodings.

## Browser observations and lifetime

Standalone screenshots and `observe.screenshot` use the same image envelope,
but remain inside their operation result rather than becoming owner attachments.
Both the initial C4 delivery and later decision responses materialize binaries
before exposing them to the Agent. Per request Remote permits at most 12 binary
objects, with the same combined decoded-byte limit.

Attachments are temporarily stored in `BROWSER_REMOTE_OBS_DIR` (the existing
observations directory by default), with private directory/file permissions.
Remote tracks files by browser endpoint and task, retaining them across rounds
and deleting them when the task completes, stops, is interrupted, disconnects,
or the service shuts down. Confirmed intake failure also releases files.
New tasks that need an original image must attach it again; Chrome thumbnails
remain available in local history.
There is no startup, scheduled or age-based cleanup. A 128 MiB cap rejects new writes instead of
evicting active-task files. Materialization validates the whole payload first
and rolls back newly written files if writing fails.
