# DeepSeek Free — two-part Engine 1 Revision 2 handover

This reduced handover fits a two-upload context limit. It is task-complete for the persistent customer-code assignment, but it is intentionally not a copy of every Operro file.

## Upload 1 — current project context

Upload `Operro-CustomerCode-Part1-Context.zip` and send:

> This is Part 1 of 2. Read every file, beginning with `00_START_HERE/TWO_PART_REVISION2_GUIDE.md` and `PART_MANIFEST.txt`. This is the authoritative current Operro/HomePaw context for the customer-code assignment at commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`. Retain the exact source, schema, RLS, test, concurrency, and populated-upgrade patterns. Do not code, propose changes, or produce a patch yet. Reply only: `Part 1 retained`, followed by any unreadable filenames.

Wait for that acknowledgement.

## Upload 2 — draft under review and correction assignment

Upload `Operro-CustomerCode-Part2-Revision.zip` and send:

> This is Part 2 of 2. `reference/ENGINE1_REVISION1_RESPONSE.txt` is an untrusted prior draft, not repository state. Read it completely, then execute `00_START_HERE/01_CUSTOMER_CODE_REVISION_2.md` exactly against the Part 1 source. Return the required complete replacement submission. Do not start Task 2 or any other parity work.

## Important mapping rule

Each ZIP contains `PART_MANIFEST.txt`. Dot-prefixed files are stored under uploader-safe names such as `_gitattributes.txt`; the manifest records their real repository paths. Do not create underscored replacements in the returned patch.

Part 1 contains the complete files needed to correct and validate this task: the HomePaw reference, parity audit, repository rules, every proposed application call site, customer creation paths, relevant schema/RLS migrations, gate runner, PostgreSQL bootstrap, populated-upgrade rehearsal, and existing concurrency/test patterns. Files unrelated to customer codes were omitted solely to fit the free two-upload limit.
