function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const SPEC = deepFreeze({
  format: "threadshare-insights-agent-spec@v1",
  purpose: "Route a user's natural-language analysis question to bounded local Insights actions.",
  userContract: {
    userProvidesNaturalLanguageQuestion: true,
    agentChoosesProtocol: true,
    maintenanceNeverImplicit: true,
  },
  startup: {
    inspect: "threadshare insights status --format json",
    refresh: "threadshare insights sync --format json",
    rule: "Inspect status first. Ask before sync when freshness matters; queries never sync implicitly.",
  },
  intents: [
    {
      id: "capability-use-context",
      when: "The user asks which Tools or Skills are used most, how broadly, or in what situations.",
      userQuestions: [
        "Which Skills do I use most, and in which contexts?",
        "Which Tools grew or declined compared with the previous period?",
      ],
      plan: [
        {
          action: "usage",
          target: "skill-or-tool",
          purpose: "Rank recorded use in a bounded window and resolve capability keys.",
          requiredInputs: ["kind", "window", "orderBy"],
          optionalFilters: ["comparisonWindow", "providers", "projectKeys", "terminalStates"],
        },
        {
          action: "recipe",
          recipe: "capability-contexts@1",
          purpose: "Read representative recorded contexts for the selected capability keys.",
          requiredInputs: ["window", "filters.capabilityKeys"],
          optionalFilters: ["providers", "projectKeys", "sessionKeys"],
        },
        {
          action: "evidence",
          purpose: "Read revision-bound evidence only for claims that need complete recorded content.",
          requiredInputs: ["target", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Distinguish invocation count, distinct Turns, Sessions, and dedupe groups.",
        "Treat representative contexts as evidence of recorded use, not proof of effectiveness.",
        "Check aliases before interpreting a capability-name trend.",
      ],
    },
    {
      id: "failure-recovery",
      when: "The user asks which Tool attempts fail, whether retries recover, or what to fix first.",
      userQuestions: [
        "Which Tool attempts kept failing, and did the same attempt chain later succeed?",
        "Should I prioritize the most failures or the highest failure rate?",
      ],
      plan: [
        {
          action: "usage",
          target: "tool",
          purpose: "Rank failing invocations and retain the invocation denominator.",
          requiredInputs: ["window", "orderBy=recorded-failing-invocation-count"],
          optionalFilters: ["comparisonWindow", "providers", "projectKeys", "terminalStates"],
        },
        {
          action: "recipe",
          recipe: "failure-chains@1",
          purpose: "Classify recorded attempt chains as recovered, never succeeded, or abandoned.",
          requiredInputs: ["window"],
          optionalFilters: ["providers", "projectKeys", "sessionKeys", "eventKinds", "text"],
        },
        {
          action: "evidence",
          purpose: "Read the selected attempt-chain evidence before assigning a cause.",
          requiredInputs: ["target.kind=attempt-chain", "target.chainKey", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Report absolute failure count and failure rate separately.",
        "Do not describe containing-Turn outcomes as caused by a Tool terminal state.",
        "A ranked prefix is not the full failure distribution; report truncation and coverage.",
      ],
    },
    {
      id: "file-workflow",
      when: "The user asks which Sessions were research-heavy, implementation-heavy, or lacked docs.",
      userQuestions: [
        "Which sessions were research-heavy or implementation-heavy?",
        "Where did implementation proceed without recorded supporting documentation?",
      ],
      plan: [
        {
          action: "recipe",
          recipe: "file-workflow-signals@1",
          purpose: "Rank Session-level recorded file activity and versioned workflow estimates.",
          requiredInputs: ["window"],
          optionalFilters: ["providers", "projectKeys", "sessionKeys"],
        },
        {
          action: "evidence",
          purpose: "Inspect a selected Session before treating an estimate as a workflow conclusion.",
          requiredInputs: ["target.kind=session", "target.sessionKey", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Describe researchHeavy, implementationHeavy, docVoid, and specPrecisionGap as estimates.",
        "File volume is not a code-quality or productivity score.",
      ],
    },
    {
      id: "activity-change",
      when: "The user asks when activity, project switching, or work mix changed over time.",
      userQuestions: [
        "When did activity or project switching change compared with a prior UTC window?",
        "Which complete week had the highest Tool density?",
      ],
      plan: [
        {
          action: "activity",
          purpose: "Read aligned UTC day or ISO-week aggregates with an optional comparison window.",
          requiredInputs: ["window", "bucket", "timeZone=UTC"],
          optionalFilters: ["comparisonWindow", "providers", "projectKeys"],
        },
        {
          action: "recipe",
          recipe: "activity-shifts@1",
          purpose: "Compare bucket-level Sessions, Turns, capabilities, tokens, and context transitions.",
          requiredInputs: ["window", "filters.bucket"],
          optionalFilters: ["comparisonWindow", "providers", "projectKeys"],
        },
      ],
      answerRules: [
        "Use complete aligned UTC buckets for trend comparisons.",
        "A recorded context transition is not a measurement of human attention or productivity.",
        "Closure counts are current state evaluated at the response clock, not historical closure state.",
      ],
    },
    {
      id: "token-hotspot",
      when: "The user asks which provider, model, or project groups recorded the most tokens.",
      userQuestions: [
        "Which provider, model, and project combinations consumed the most recorded tokens?",
        "Are the largest input totals mostly cached or uncached?",
      ],
      plan: [
        {
          action: "recipe",
          recipe: "token-hotspots@1",
          purpose: "Aggregate recorded token metrics by provider, model, and project.",
          requiredInputs: ["window"],
          optionalFilters: ["providers", "projectKeys", "sessionKeys"],
        },
        {
          action: "query",
          purpose: "Run an exact token-usage aggregate when the user needs a custom grouping or metric.",
          requiredInputs: ["resource=token-usage", "shape.kind=aggregate", "groupBy", "metrics"],
          optionalFilters: ["where", "orderBy", "limit"],
        },
      ],
      answerRules: [
        "Report every metric's coverage denominator; missing token values are unknown, not zero.",
        "Do not infer Tool- or Skill-scoped token attribution from Turn co-occurrence.",
        "Recorded tokens are not a provider-independent billing amount.",
      ],
    },
    {
      id: "solution-reuse",
      when: "The user has a concrete error and asks where it happened before and what later succeeded.",
      userQuestions: [
        "Where did this exact error occur before, and what successful attempt followed it?",
        "What previously worked for this build or protocol failure?",
      ],
      plan: [
        {
          action: "search",
          purpose: "Find candidate Turns for a specific error signature, command, or output excerpt.",
          requiredInputs: ["specific query text"],
          optionalFilters: ["window", "providers", "projectKeys", "sessionKeys"],
        },
        {
          action: "recipe",
          recipe: "solution-recall@1",
          purpose: "Link matching recorded events to a later successful event in the same attempt chain.",
          requiredInputs: ["window", "filters.text"],
          optionalFilters: ["providers", "projectKeys", "sessionKeys", "eventKinds"],
        },
        {
          action: "evidence",
          purpose: "Read both the matched failure and subsequent-success evidence before recommending it.",
          requiredInputs: ["target", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Reject or narrow generic terms before running a global recall query.",
        "Historical subsequent success is a candidate procedure, not proof it will fix the current case.",
        "Group repeated events from one Session or attempt chain before counting solutions.",
      ],
    },
    {
      id: "session-explanation",
      when: "The user asks what happened around a decision, Tool call, compaction, rollback, or resume.",
      userQuestions: [
        "What exactly happened in this Session around the failed command and later review?",
        "Show the ordered events around compaction, rollback, resume, Tool calls, and lifecycle changes.",
      ],
      plan: [
        {
          action: "search",
          purpose: "Resolve a relevant Session when the user has not already selected one.",
          requiredInputs: ["specific query text"],
          optionalFilters: ["window", "providers", "projectKeys"],
        },
        {
          action: "recipe",
          recipe: "session-timeline@1",
          purpose: "Read one Session's recorded events in original order.",
          requiredInputs: ["window", "exactly one filters.sessionKeys item"],
          optionalFilters: ["providers", "projectKeys", "eventKinds"],
        },
        {
          action: "evidence",
          purpose: "Page complete payload evidence for the small set of events used in the answer.",
          requiredInputs: ["target.kind=event", "target.eventKey", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Continue pagination until truncated is false before claiming the timeline is complete.",
        "Preserve unknown and incomplete events; do not invent causal links from adjacency.",
      ],
    },
    {
      id: "delivery-trace",
      when: "The user asks how an intent, Agent Session, file, and Git commit are connected in a delivered change.",
      userQuestions: [
        "Which Sessions and commits delivered this feature, and what evidence connects them?",
        "How was this failure resolved, and what code changed in the successful delivery?",
        "Which requirements still have no recorded commit evidence?",
        "Which commits have no recorded Agent or intent evidence?",
        "What should I know before continuing this work?",
      ],
      plan: [
        {
          action: "recipe",
          recipe: "delivery-trace@1",
          purpose: "Traverse the bounded evidence graph from the selected intent, Session, file, repository, or commit root.",
          requiredInputs: ["direction", "maxDepth"],
          optionalFilters: [
            "root (defaults to the registered repository containing the current working directory)",
            "window", "includeCandidateEdges", "includeContextualEdges", "cursor",
          ],
        },
        {
          action: "evidence",
          purpose: "Read revision-bound Trace node or edge evidence before using it in a delivery claim.",
          requiredInputs: ["target.kind=delivery-node-or-delivery-edge", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
        {
          action: "evidence",
          purpose: "Hydrate an authorized immutable Git object diff only after the graph identifies the commit and path.",
          requiredInputs: ["format=threadshare-insights-git-diff-evidence-request@v1", "repositoryKey", "commitObjectId", "parentObjectId", "revision"],
          optionalFilters: ["path", "contextLines", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Call direct edges explicit or recorded; call observed edges observed, never Agent authorship.",
        "Candidate and contextual edges do not support the default conclusion and must remain separate.",
        "Disclose truncated, partial, unavailable, or stale evidence next to the affected conclusion.",
        "A Git diff is complete only after every page is read and the payload digest remains unchanged.",
        "A continuation context summarizes evidence; it cannot restore a Session, code state, or Git state.",
      ],
    },
    {
      id: "custom-query",
      when: "The question needs fields, filters, grouping, or metrics not covered by a predefined intent.",
      userQuestions: [
        "Count error occurrences by provider and event kind for this project and time window.",
        "List revision-bound events matching these exact typed conditions.",
      ],
      plan: [
        {
          action: "query",
          purpose: "Run bounded typed records or aggregate queries over the published resource registry.",
          requiredInputs: ["resource", "shape", "orderBy", "limit"],
          optionalFilters: ["where", "cursor"],
        },
        {
          action: "evidence",
          purpose: "Read payload content only for selected revision-bound records.",
          requiredInputs: ["target", "revision"],
          optionalFilters: ["include", "maxBytes", "cursor"],
        },
      ],
      answerRules: [
        "Prefer reference payload mode for discovery and fetch full payloads only after narrowing.",
        "Keep cursors unchanged and restart the originating query after a stale revision or snapshot.",
      ],
    },
  ],
  actions: [
    {
      action: "overview",
      useWhen: "Establish snapshot identity, indexed scope, and aggregate coverage.",
      help: "threadshare insights --help",
      requestFormat: null,
    },
    {
      action: "capabilities",
      useWhen: "Resolve Tool or Skill names to stable capability keys.",
      help: "threadshare insights --help",
      requestFormat: null,
    },
    {
      action: "usage",
      useWhen: "Rank Tool or Skill use and compare bounded windows.",
      help: "threadshare insights --help",
      requestFormat: "threadshare-insights-usage-request@v1",
    },
    {
      action: "activity",
      useWhen: "Read aligned UTC day or ISO-week aggregates.",
      help: "threadshare insights --help",
      requestFormat: "threadshare-insights-activity-request@v1",
    },
    {
      action: "search",
      useWhen: "Find candidate Turns from bounded text and structured filters.",
      help: "threadshare insights --help",
      requestFormat: "threadshare-insights-search-request@v1",
    },
    {
      action: "query",
      useWhen: "Read custom typed records or aggregates.",
      help: "threadshare insights query --help",
      requestFormat: "threadshare-insights-query-request@v2",
    },
    {
      action: "recipe",
      useWhen: "Run a versioned multi-resource analysis selected by the Agent spec.",
      help: "threadshare insights recipe --help",
      requestFormat: "threadshare-insights-recipe-request@v1",
    },
    {
      action: "evidence",
      useWhen: "Read complete revision-bound evidence after narrowing.",
      help: "threadshare insights evidence --help",
      requestFormat: "threadshare-insights-evidence-request@v2",
    },
  ],
  schemas: [
    "schema/threadshare-insights-agent-spec.v1.schema.json",
    "schema/threadshare-insights-continuation-context.v1.schema.json",
    "schema/threadshare-insights-search-request.v1.schema.json",
    "schema/threadshare-insights-usage-request.v1.schema.json",
    "schema/threadshare-insights-activity-request.v1.schema.json",
    "schema/threadshare-insights-query-request.v2.schema.json",
    "schema/threadshare-insights-recipe-request.v1.schema.json",
    "schema/threadshare-insights-evidence-request.v2.schema.json",
    "schema/threadshare-insights-delivery-trace-request.v1.schema.json",
    "schema/threadshare-insights-delivery-trace.v1.schema.json",
    "schema/threadshare-insights-git-diff-evidence-request.v1.schema.json",
    "schema/threadshare-insights-git-diff-evidence.v1.schema.json",
  ],
});

export function createInsightsAgentSpec() {
  return SPEC;
}
