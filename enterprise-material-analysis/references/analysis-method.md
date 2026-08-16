# Enterprise Material Analysis Method

## 1. Scope And Inventory

Confirm one process and authorized material set. Assign stable IDs such as `MAT-001`. Record material type, source, period, version, readability, sensitivity, and whether it is original, excerpt, transcription, screenshot, export, or analyst-created summary.

Do not downgrade a screenshot because it is visual, or upgrade a spreadsheet because it is structured. Evidence level depends on what the item actually represents.

## 2. Read Before Synthesis

Read each relevant material completely when feasible. For long files, inspect structure first, then all sections that can affect the in-scope process. Note truncated or skipped spans. For spreadsheets, identify sheets, headers, row population, date coverage, formulas, filters, missing fields, and units before citing cells.

## 3. Extract Atomic Claims

Extract observable or attributable claims, not broad summaries. Preserve speaker role and whether a sentence is:

- actual operation report;
- opinion or explanation;
- target or proposal;
- decision or commitment;
- policy requirement;
- measured record;
- estimate;
- unknown.

Use the narrowest stable locator available. Do not quote large private passages.

## 4. Map Process Nodes

Attach each claim to one or more node types:

`actor`, `trigger`, `input`, `action`, `system`, `decision`, `output`, `handoff`, `exception`, `burden`, `risk`, `outcome`.

When a workflow card is supplied, use its step IDs as anchors but independently evaluate its evidence references. Employee confirmation validates the transcription of the employee's account, not the enterprise fact.

## 5. Compare

Compare by the same business object and time period. Detect agreements and conflicts across:

- sender vs receiver;
- employee vs manager;
- reported practice vs SOP;
- sample/log vs estimate;
- old vs current version;
- normal path vs exception;
- claimed system behavior vs observed records.

Do not count absence as contradiction unless the material was expected to cover that fact.

## 6. Coverage

List which roles, process nodes, time periods, normal/exception paths, systems, decisions, and quantities have evidence. Missing coverage remains unknown. A large file count does not equal sufficient coverage.

## 7. Minimum Evidence Request

For each decision-changing gap, specify:

1. question to resolve;
2. minimum evidence item;
3. likely owner or system;
4. sample/period boundary;
5. why it changes diagnosis or pilot design;
6. privacy minimization or desensitization;
7. fallback if unavailable.

Prefer, for example, “20 desensitized records with created/approved timestamps” over “export the whole OA database.”

## 8. Handoff

End with a machine-readable-compatible block containing:

- process and analysis scope;
- material IDs and status;
- supported/corroborated/conflicted/unsupported/unknown claim IDs;
- process-node coverage;
- prioritized evidence requests;
- prohibited conclusions;
- upstream workflow card IDs;
- analysis version and date.

The later diagnosis Skill may interpret business demand and route only after reading this block and the cited evidence pack.

