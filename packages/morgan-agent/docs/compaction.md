# Compaction

Compaction replaces older model context with a summary while retaining recent messages. It can run automatically near the context limit or manually through `/compact`.

The resulting compaction entry stores the summary and the first retained entry ID. Conversation reconstruction uses the newest valid compaction plus subsequent linear entries.

Configure compaction globally in `~/.morgan/agent/settings.json`. The canonical JSONL keeps the compaction record; Morgan has no branch summarization or tree navigation.
