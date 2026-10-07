# DeepSeek new-chat bootstrap — Engine 1 customer-code Revision 2

This handover is deliberately split into two stages. The new DeepSeek chat must receive and retain all context archives before it sees the previous Engine 1 response or the Revision 2 assignment.

## Stage A — load the project context

Upload `Operro-NewChat-Context-Part01-of-12.zip` through `Operro-NewChat-Context-Part12-of-12.zip` in ascending order, one at a time.

With Part 01, send this message:

> This is Part 01 of 12 of the Operro/HomePaw project context. Read `00_START_HERE/NEW_CHAT_REVISION2_UPLOAD_GUIDE.md` and the part manifest. Retain the files and their original-path mappings. Do not design, code, or produce a patch yet. Reply only with the part number received and whether every file in this archive was readable.

After Parts 02–11, send:

> This is the next numbered Operro context archive. Retain it together with every earlier part. Do not code, summarize the whole repository, or discard earlier files. Reply only with the part number received and whether every file in this archive was readable.

After Part 12, send:

> This is Part 12 of 12. Confirm that you retained all twelve parts and can access: the Operro source at commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`, `apps/web/AGENTS.md`, the 44-section parity audit, the full HomePaw `index (2).html`, the original customer-code assignment, and the first correction prompt. Do not code yet. I will next upload the returned Revision 1 response and then the Revision 2 assignment.

Every ZIP contains `PART_MANIFEST.txt`, mapping its safe archive path to the original path. Dot-prefixed repository files are renamed inside the archives because the uploader rejects `.gitignore`-style names. Those renamed paths are context mappings only; they must not be returned as new repository paths.

## Stage B — provide the draft and the next assignment

After DeepSeek confirms all twelve context parts:

1. Upload `ENGINE1_REVISION1_RESPONSE.txt` and send:

   > This is the complete prior Engine 1 Revision 1 response. Treat it as an untrusted draft under review, not as current repository state. Read it fully, retain it, and do not code yet. Confirm only that the whole file was readable.

2. Upload `01_CUSTOMER_CODE_REVISION_2.md` and send:

   > Now execute `01_CUSTOMER_CODE_REVISION_2.md` exactly against the supplied Operro base commit. The Revision 1 response is only the draft to correct. Return the required complete replacement submission. Do not start any later parity task.

Do not upload Task 02 or any other assignment until Codex has reviewed and integrated the corrected customer-code work and supplied a refreshed source bundle.
