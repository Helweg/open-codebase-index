---
description: Search codebase by meaning using semantic search
---

Search the codebase using semantic search.

User input: $ARGUMENTS

The first part is the search query. Look for optional parameters:
- `limit=N` or "top N" or "first N" → set limit
- `type=X` or mentions "functions"/"classes"/"methods" → set chunkType
- `dir=X` or "in folder X" → set directory filter
- File extensions like ".ts", "typescript", ".py" → set fileType
- `author=X` or `blameAuthor=X` → set blameAuthor filter
- `sha=X` or `blameSha=X` → set blameSha filter
- `since=YYYY-MM-DD` or `blameSince=YYYY-MM-DD` → set blameSince filter
- `until=YYYY-MM-DD` or `blameUntil=YYYY-MM-DD` → set blameUntil filter

Call `codebase_search` with the parsed arguments.

Examples:
- `/search authentication logic` → query="authentication logic"
- `/search error handling limit=5` → query="error handling", limit=5
- `/search validation functions` → query="validation", chunkType="function"
- `/search auth logic author=jane@example.com since=2025-01-01 until=2025-01-31` → query="auth logic", blameAuthor="jane@example.com", blameSince="2025-01-01", blameUntil="2025-01-31"

If the index doesn't exist, run `index_codebase` first.

Return results with file paths and line numbers.
