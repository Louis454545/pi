# Conversation file format

The canonical file is `~/.morgan/sessions/global/conversation.jsonl`.

The first line is a version-1 session header with `type`, `version`, `id`, `timestamp`, and the HOME `cwd`. Later lines are linear entries with `id`, `parentId`, and `timestamp` plus their type-specific data.

Current entry types are message, thinking-level change, model change, compaction, custom data, and custom message. `parentId` points to the immediately preceding entry and is `null` for the first entry.

Morgan only accepts the current schema. It does not migrate, import, list, branch, name, or recover historical session formats.
