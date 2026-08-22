-----META-START-----
created: 2026-08-21
updated: 2026-08-21
summary: "Threadshare memory pipeline"
heat: 1
-----META-END-----
## Team memory design
- Mine post-hoc Insights history; avoid live traffic interception.
- Use one ingestion/extraction/dedupe/storage/sharing contract.
- Require RunnerExecutionPlan and authorization before raw transcript extraction.
- Mark archived chats so prompts cannot obey or continue them.
- Process complete turn-bounded chunks with related-input CAS.
- Quarantine candidates and evidence in SQLite; promote via Git later.
- Commit only sanitized text, opaque ids, and public evidence references.
- Bind promotion to blob hashes, content digests, and policy versions.