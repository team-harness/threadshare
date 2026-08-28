# Threadshare Domain Language

Threadshare organizes local Agent work as evidence-backed conversation history, delivery context, and reviewed experience. These terms are shared by source adapters, Local Insights, Team Memory, and the local Dashboard.

## Conversation History

**Conversation**:
An evidence-backed aggregate containing one Root Session and zero or more Sessions connected to it by confirmed Session Lineage.
_Avoid_: Provider conversation, source conversation, a single Session

**Session**:
One persisted execution thread emitted by an Agent source. A source may call it a conversation, thread, run, or chat, but Threadshare calls the canonical unit a Session.
_Avoid_: Conversation, run record

**Root Session**:
The Session at which a Conversation begins and from which every resolved descendant Session can be reached.
_Avoid_: Main conversation

**Subagent Session**:
A separately persisted Session executed on behalf of another Session and connected to it by confirmed Session Lineage.
_Avoid_: Inline subagent activity, delegated Event

**Orphan Session**:
A Session whose source indicates a parent or root relationship that Threadshare cannot currently resolve with sufficient evidence.
_Avoid_: Guessed child Session, inferred Conversation member

**Session Lineage**:
The evidence-backed parent, root, and relation information connecting Sessions inside a Conversation.
_Avoid_: Temporal grouping, title similarity

**Turn**:
A bounded work cycle within one Session, normally initiated by a visible request and ending at the next request or an observed terminal state.
_Avoid_: Message, tool call

**Event**:
An ordered observed fact inside a Session, such as a visible message, capability invocation, result, file activity, lifecycle transition, or provider status.
_Avoid_: Turn, Session

**Inline Subagent Event**:
An Event describing delegated activity inside its owning Session when no separately persisted child Session has been established.
_Avoid_: Subagent Session

## Sources And Evidence

**Session Source**:
A local, read-only source from which an adapter discovers and reads Sessions.
_Avoid_: Conversation Source, model provider, runner

**Evidence**:
A revision-bound observation that supports a displayed fact or relationship and can be inspected without relying on presentation-layer inference.
_Avoid_: Guess, UI-derived fact

**Primary Work**:
Work observed in Root or other primary Sessions and included in default historical efficiency comparisons.
_Avoid_: All Conversation activity

**Delegated Work**:
Work observed in Subagent Sessions or explicit inline delegation and reported separately from Primary Work.
_Avoid_: Primary efficiency score

**Experience Asset**:
A reviewed Team Memory item or synthesis that is eligible for reuse as an entry, scene, doctrine, or Skill.
_Avoid_: Unreviewed extraction candidate, arbitrary transcript excerpt
