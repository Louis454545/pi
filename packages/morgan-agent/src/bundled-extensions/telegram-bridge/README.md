# Telegram Bridge

This is an editable Morgan extension installed by `morgan setup`.

Files:

- `index.ts` contains the bridge logic.
- `config.json` contains the bot token, allowlist, and polling settings.
- `state.json` contains the Telegram update offset and pause state.

After editing this extension while Morgan is running, use `/reload` or the `reload` tool so Morgan reloads the bridge.

Incoming Telegram files are downloaded to the configured `dataDir` and passed to Morgan as local filesystem paths.

Morgan does not automatically send assistant responses back to Telegram. To reply from a session, use the
`send_message` tool with `integration: "telegram"`. The tool sends text messages and local file attachments to
allowed Telegram chats.
