# Zylos Browser Privacy Policy

Last updated: September 30, 2026.

This policy describes Zylos Browser, the Chrome extension maintained in the [zylos-ai/zylos-browser-extension project](https://github.com/zylos-ai/zylos-browser-extension). It reflects extension version 0.16.0 and Zylos Browser Remote 0.10.0.

## How Zylos Browser works

Zylos Browser lets you chat with a Zylos Agent and request browser tasks. You configure the Relay URL and connection Key. The extension sends task-related information to that Relay and Agent. The extension does not provide a built-in hosted AI account or automatically route your conversations to a developer-operated AI service.

Your Relay operator, Agent operator, and any AI model or tool providers used by your Agent may process data under their own policies. Their identities depend on the services you configure; check those services before connecting.

## Information the extension handles

- **Connection settings and identifiers.** Your Relay URL, authentication Key, connection preferences, a randomly generated browser-installation identifier, and connection/task identifiers are used to authenticate and route requests. The installation identifier is not obtained from your Chrome account and is not your name or email address.
- **Messages and files.** The messages you send, Agent replies, selected-text quotations, files you attach, and attachment metadata are used to carry out the conversation or task. Images may have small local previews.
- **Current-page context.** Sending a message normally includes the active page's title, URL, a text excerpt, and relevant links. The automatic text extractor omits input and editable-field values. Restricted pages may be unavailable.
- **Browser-task observations.** For a requested task, the extension can read page text and accessibility/DOM information and capture screenshots. It can process navigation, element, viewport, and operation results so the Agent can decide the next step. Page observations can contain personal information that is visible on the page.
- **Task activity.** The extension keeps a bounded local activity history, such as operation names, timing, status, and short target hints. When supported by your Remote, it also receives public Agent progress messages and limited tool activity from the task's Agent session. Accepted decision summaries are included in this history. Hidden model reasoning is not collected for this display. During a task it also observes network request identifiers and timing to determine whether a page has finished loading; this readiness tracker does not retain request headers or response bodies. This supports browser-task execution, rather than general browsing analytics or a recording of everything you type.

The extension has no separate registration form requesting your name, email address, age, postal address, or government identification. It does not request device geolocation or include advertising or third-party analytics SDKs. Content you choose to send, or that appears in a task page or screenshot, may itself contain personal or sensitive information.

## How information is used and shared

Information is used to connect to your configured Relay and Agent, answer messages, perform requested browser tasks, display task activity and previews, and restore local preferences and recent conversation history.

Messages, original attachments, selected text, page context, and task observations may be transmitted to your configured Relay and Agent. When your Agent uses external models or tools, those services may receive the information needed for their operation. Browser actions such as submitting a form also send information to the website involved in that action.

The extension does not include a mechanism that sells user data or sends it to advertising services. It does not use user data for advertising, creditworthiness decisions, or lending. Data use and transfers through the extension are limited to its stated user-facing functionality. Zylos Browser's use of information received through Chrome APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Storage, retention, and deletion

Connection settings, the installation identifier, language preferences, recent chat history, bounded Agent progress history, attachment metadata, small image previews, and task-recovery information are stored in the extension's local storage in your Chrome profile. The extension uses local storage, not Chrome's sync storage, for these records.

Original attachment files are not retained in local chat history. Zylos Browser Remote 0.10.0 writes task-owned temporary attachments and screenshots on the Agent host and attempts to delete those files when their task ends. A process crash or filesystem failure can prevent that cleanup. This cleanup does not delete your original local files or independent copies, conversation records, logs, or backups made by the Agent, Relay deployment, model providers, or other tools.

Use **Clear chat** to remove the extension's local conversation history and associated stored previews. You can disable the connection in Settings and remove the extension through Chrome to remove its extension-local stored data. Deleting local history does not delete records already held by your configured services; contact those service operators for their retention and deletion controls.

## Connection security and your choices

Use a trusted Relay and Agent. Remote connections should use `wss://`; local development can connect to a service on the same machine using `ws://127.0.0.1`. The current extension also accepts user-entered `ws://` endpoints, which are not encrypted in transit, so do not use an unencrypted remote endpoint for sensitive data.

The connection Key is stored in Chrome extension local storage for reconnection; the extension does not add its own encryption layer to that stored value. Protect access to your Chrome profile and revoke or rotate a Key through your Relay operator when it is no longer needed.

Before sending a message, consider the current page context and any selected text or attachments. You can remove a quoted selection or attached file before sending, stop an active task, or disable the Relay connection. Stopping a task does not retract data already transmitted.

## Changes and contact

Changes to this policy will be published with the project. For questions about the extension or this policy, contact the project maintainers through the [project support page](https://github.com/zylos-ai/zylos-browser-extension/issues). That page is public: do not post connection Keys, private conversations, files, or other sensitive information there. For private records held by a configured Relay, Agent, or AI provider, contact that service's operator directly.
