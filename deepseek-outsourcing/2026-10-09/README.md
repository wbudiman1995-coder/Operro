# DeepSeek chat packets — 9 October 2026

There are three four-task queues, one for each new DeepSeek chat:

1. `Operro-DeepSeek-Engine-1-Owner-Experience-20261009.zip`
2. `Operro-DeepSeek-Engine-2-Operations-20261009.zip`
3. `Operro-DeepSeek-Engine-3-Platform-Resilience-20261009.zip`

Each archive has fewer than 50 files, a task-specific `DEEPSEEK_PROMPT.md`, a `PART_MANIFEST.txt`, curated source under `operro/`, and the HomePaw reference. Upload exactly one archive to its matching new chat, then paste the matching starter text below.

## Starter text (same for every chat)

```text
Read START-HERE.md, DEEPSEEK_PROMPT.md, and PART_MANIFEST.txt before coding. Treat the files under operro/ as the only supplied repository paths. Work only on E?.1 first; do not begin later tasks until I send NEXT TASK. Return the required finding table, unified patch, and handoff. Do not deploy, access production, create real records, or invent unavailable files.
```

After Codex has reviewed an output, paste `NEXT TASK` to move that chat to its next numbered task. Do not stack patches on a stale source snapshot: request a refreshed packet if a prior integrated task changed its dependencies.
