# Operro full-context upload guide for DeepSeek

This handover is split into **12 numbered ZIP files** because DeepSeek can read at most 50 contained files at a time. Each ZIP contains no more than 50 files, including its own `PART_MANIFEST.txt`.

The parts collectively contain:

- Every Git-tracked Operro file at commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`.
- The complete HomePaw reference `index (2).html`.
- The 44-section parity audit and all tracked handoffs/evidence.
- The DeepSeek outsourcing prompt queue and review rules.
- The Engine 1 customer-code response and revision prompt.

No `.git` directory, credentials, `.env` secrets, `node_modules`, or production keys are included. Uploaders sometimes reject dot-prefixed files or folders, so every tracked dot-prefixed path is stored under a readable `_dotfiles`/underscored archive path. Each `PART_MANIFEST.txt` records its original repository path; these renamed copies are context only and must not be returned as new repository paths.

## Upload procedure

Use one DeepSeek chat for the inventory pass.

1. Upload `Part01-of-12.zip` and paste the initialization prompt below.
2. Wait for `READY FOR PART 02`.
3. Upload each next part in numeric order. After each upload, tell DeepSeek to read its `PART_MANIFEST.txt`, inventory the files, retain their repository paths, and reply only `READY FOR PART NN`.
4. After Part 12, tell DeepSeek to reply with a compact repository map and the exact base commit. Do not ask it to code during the inventory pass.
5. For actual implementation, give it only one assignment prompt at a time. Codex reviews and integrates every returned patch before the next dependent assignment.

### Initialization prompt for Part 01

```text
You are receiving the complete Operro/HomePaw context in 12 numbered ZIP parts because you may read no more than 50 files per upload.

This is an inventory pass only. Do not write code or propose a patch yet.

Open Part01-of-12.zip. Read PART_MANIFEST.txt first, then read:
- handover/FULL_CONTEXT_UPLOAD_GUIDE.md
- prompts/00_COMMON_INSTRUCTIONS.md
- handover/DEEPSEEK_HOMEPAW_PARITY_CONTINUATION.md

Treat paths under operro/ as repository-relative source at commit 8bef156aa745aa958c329adeae66b2cba7cf0ccf. Dot-prefixed repository paths were renamed only to satisfy upload restrictions; use PART_MANIFEST.txt to recover each original path.

Inventory the supplied paths and retain a compact map. Do not invent files that have not been uploaded. Do not implement anything yet.

When finished, reply only: READY FOR PART 02
```

### Prompt after each intermediate part

```text
Read this part's PART_MANIFEST.txt and inventory every supplied path. Add them to the repository map from the earlier parts. Do not code, summarize features, or propose changes yet. When finished, reply only: READY FOR PART NN
```

Replace `NN` with the next part number.

### Prompt after Part 12

```text
All 12 Operro context parts are now uploaded. Verify that you have inventoried every path from every PART_MANIFEST.txt. Reply with:
1. The base commit.
2. Counts by top-level area: apps, packages, supabase, integration, docs/logs, prompts/reference.
3. The authoritative parity-audit path.
4. The HomePaw reference path.
5. Any archive path you could not read.

Do not write code yet.
```

## Important limitation

The parts describe one fixed snapshot. After Codex integrates a patch, later dependent work must use a refreshed task-specific bundle. Do not ask DeepSeek to stack several dependent patches on this original snapshot.
