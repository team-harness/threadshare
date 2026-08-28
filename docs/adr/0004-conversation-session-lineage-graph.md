---
adr: "0004"
title: Insights models Conversations as evidence-backed Session lineage graphs
status: Proposed
date: 2026-08-27
applies-to: Session sources, Local Insights Fact V3, Deep Query, Delivery Trace, Team Memory evidence, and Dashboard
enforcement: design
stage: [design, review, check, runtime]
lint: null
---

# Context

Provider records use conversation, thread, run, and Session inconsistently. Current Local Insights stores one provider Session as its largest query unit, excludes separately persisted subagent Sessions from the eligible corpus, and preserves inline subagent activity only as scoped Events. The target local Dashboard needs to navigate a root execution together with child Agent Sessions without changing historical metrics or inventing relationships from titles and timestamps.

A browser-only grouping would create a second truth model beside Agent Query and Recipe. Reusing the current `subagent-excluded` state would hide the child transcript. Treating every inline subagent Event as a Session would double count work. Adding a temporary Fact V2 sidecar would also require a second identity migration when the already proposed source-neutral Fact V3 contract lands.

# Decision

Local Insights models a Conversation as a persistent, snapshot-bound graph of Sessions connected by evidence-backed lineage.

- A Conversation contains exactly one resolved Root Session and zero or more descendant Sessions. A separately persisted Session is the membership unit; Turn and Event ownership never crosses Session identity.
- Session adapters may submit root, parent, role, and relation claims only from provider-explicit metadata or adapter-qualified source structure. Title similarity, temporal proximity, shared project, and text similarity cannot establish membership.
- Unresolved or contradictory claims produce an Orphan Session with explicit diagnostics. They do not disappear and are not attached to the nearest plausible Conversation.
- Inline subagent activity remains an Event in its owning Session unless a separately persisted child Session is independently discovered and linked. A linkage may reference the spawn Event as evidence, but it cannot duplicate that Event as a child transcript.
- Fact V3 owns stable Conversation and lineage identity, normalized storage, graph validation, rollups, query semantics, and evidence references. Dashboard code only renders Engine results.
- Subagent Sessions become indexable and inspectable. Existing default efficiency and solution-quality universes remain Primary Work only; Delegated Work is reported as a separate, explicitly labeled dimension.
- Conversation lineage ships through the existing Fact V3 shadow rebuild and snapshot replacement path. Fact V2 does not gain a second hierarchy store.

# Consequences

- Source adapters must preserve enough private lineage metadata to derive stable opaque keys without exposing native Session, parent, or Agent identifiers.
- Fact V3 gains Conversation identity, Session lineage claims, lineage diagnostics, graph projections, rollups, query resources, and migration golden tests.
- A Session may move from orphan to resolved membership when new evidence appears. The Session key remains stable while Conversation membership and lineage revision change.
- Existing main-only analytics remain comparable. New Conversation summaries must display Primary Work and Delegated Work separately rather than silently combining their counts.
- Delivery Trace can add recorded `conversation-contains-session` edges and show `Intent -> Conversation -> Session -> Turn -> File -> Commit` without changing evidence-strength rules.
- V2 cursors, source positions, and Memory bindings still become stale at the coordinated V3 database swap described by the Session Source Adapter design.

# Rejected alternatives

- **Use Session and Conversation as synonyms.** Rejected because the Dashboard needs one stable aggregate over multiple independently persisted execution threads.
- **Group Sessions in browser JavaScript.** Rejected because Agent and Dashboard answers would drift and relationship rules would evade transactional tests.
- **Infer relationships from title, project, text, or time.** Rejected because parallel work and copied context create ordinary false positives.
- **Count Subagent Sessions inside existing main metrics.** Rejected because historical comparisons would change meaning and delegation volume is not equivalent to primary efficiency.
- **Add a Fact V2 lineage sidecar.** Rejected because it creates a disposable identity store and a second migration beside the required Fact V3 shadow rebuild.
