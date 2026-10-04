@AGENTS.md

## Claude Code only
- Broad questions ("everything about X") → subagent memory-searcher, not Explore (Explore skips CLAUDE.md).
- The SessionStart hook prints the start file, also after compaction. If you do not see it, run `node system/memory.mjs start`.
