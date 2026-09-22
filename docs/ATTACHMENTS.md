# Message attachments

The extension uses ordered `message.content` blocks for user text, quotes,
images and files. Requests use the version 2 message/context/execution envelope.
The composer currently creates text and quotes; a file picker, paste and
drag-and-drop uploads are not part of this change.

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
GIF; other MIME types use `file`. File names are labels, never filesystem paths.
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

Chrome history stores file/image metadata only. It does not persist base64 or
Agent-host paths. Monitor redacts attachment data, including short encodings.

## Browser observations and lifetime

Standalone screenshots and `observe.screenshot` use the same image envelope,
but remain inside their operation result rather than becoming owner attachments.
Both the initial C4 delivery and later decision responses materialize binaries
before exposing them to the Agent. Per request Remote permits at most 12 binary
objects, with the same combined decoded-byte limit.

Attachments are stored in `BROWSER_REMOTE_OBS_DIR` (the existing observations
directory by default), with private directory/file permissions. Remote removes
files older than 24 hours when writing new attachments and caps stored bytes at
128 MiB; a full store rejects new writes instead of evicting active-task files.
This replaces the previous global last-12-screenshots policy, which could remove
a resource still needed by another browser's task. Materialization validates the
whole payload first and rolls back newly written files if writing fails.
