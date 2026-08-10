use crate::storage::StorageError;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::Serialize;
use std::collections::BTreeMap;

pub const MAX_OVERVIEW_PROVIDERS: usize = 16;
pub const MAX_OVERVIEW_PROJECTS: usize = 512;
pub const MAX_OVERVIEW_FACT_SIGNALS: usize = 1_024;
pub const MAX_CAPABILITY_PAGE_SIZE: u16 = 200;

const OVERVIEW_ROLLUP_SCHEMA_VERSION: i64 = 1;
const OVERVIEW_ROLLUP_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS overview_rollup_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version>0)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS overview_session_rollups (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  session_key BLOB NOT NULL UNIQUE CHECK(length(session_key)=32),
  provider TEXT NOT NULL,
  project_key BLOB CHECK(project_key IS NULL OR length(project_key)=32),
  session_scope TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  duplicate_group_key BLOB CHECK(duplicate_group_key IS NULL OR length(duplicate_group_key)=32),
  duplicate_method TEXT,
  duplicate_confidence TEXT,
  dedupe_corroboration_fingerprint BLOB
    CHECK(dedupe_corroboration_fingerprint IS NULL OR length(dedupe_corroboration_fingerprint)=32),
  dedupe_closure TEXT,
  eof_observed INTEGER NOT NULL CHECK(eof_observed IN (0,1)),
  source_mtime_ns BLOB NOT NULL CHECK(length(source_mtime_ns)=8),
  active_turn_count INTEGER NOT NULL CHECK(active_turn_count>=0),
  rolled_back_turn_count INTEGER NOT NULL CHECK(rolled_back_turn_count>=0),
  unknown_visibility_count INTEGER NOT NULL CHECK(unknown_visibility_count>=0),
  hard_sealed_turn_count INTEGER NOT NULL CHECK(hard_sealed_turn_count>=0)
);
CREATE INDEX IF NOT EXISTS overview_session_provider
  ON overview_session_rollups(provider,session_id);
CREATE INDEX IF NOT EXISTS overview_session_project
  ON overview_session_rollups(project_key,session_id) WHERE project_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS overview_session_dedupe
  ON overview_session_rollups(
    duplicate_group_key,eligibility,session_scope,duplicate_method,
    duplicate_confidence,dedupe_corroboration_fingerprint,session_id
  );
CREATE TABLE IF NOT EXISTS overview_session_capabilities (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  capability_key BLOB NOT NULL CHECK(length(capability_key)=32),
  capability_kind TEXT NOT NULL CHECK(capability_kind IN ('tool','skill')),
  PRIMARY KEY(session_id,capability_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS overview_capability_kind_key
  ON overview_session_capabilities(capability_kind,capability_key,session_id);
CREATE TABLE IF NOT EXISTS overview_session_fact_signals (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  signal_kind TEXT NOT NULL CHECK(signal_kind IN ('coverage','diagnostic')),
  signal_key TEXT NOT NULL,
  signal_count BLOB NOT NULL CHECK(length(signal_count)=8),
  normalized INTEGER NOT NULL CHECK(normalized IN (0,1)),
  PRIMARY KEY(session_id,signal_kind,signal_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS overview_fact_signal_lookup
  ON overview_session_fact_signals(signal_kind,signal_key,session_id);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityListKind {
    Tool,
    Skill,
}

impl CapabilityListKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Skill => "skill",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityPageRequest {
    pub kind: CapabilityListKind,
    pub cursor: Option<String>,
    pub limit: u16,
}

impl CapabilityPageRequest {
    pub fn validate(self) -> Result<Self, StorageError> {
        if self.limit == 0 || self.limit > MAX_CAPABILITY_PAGE_SIZE {
            return Err(StorageError::new(
                "TS_INSIGHTS_INVALID_CAPABILITY_PAGE",
                "capability page limit must be in 1..=200",
            ));
        }
        if self.cursor.as_deref().is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(StorageError::new(
                "TS_INSIGHTS_INVALID_CAPABILITY_PAGE",
                "capability page cursor must be a lowercase stable key",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InsightsOverviewRequest {
    pub now_unix_ms: u64,
    pub quiescence_seconds: u32,
}

impl InsightsOverviewRequest {
    pub fn validate(self) -> Result<Self, StorageError> {
        if !(60..=86_400).contains(&self.quiescence_seconds) {
            return Err(StorageError::new(
                "TS_INSIGHTS_INVALID_OVERVIEW_REQUEST",
                "quiescenceSeconds must be in 60..=86400",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub raw: String,
    pub eligible: String,
    pub excluded: String,
    pub subagent_excluded: String,
    pub unknown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeCounts {
    pub main: String,
    pub subagent: String,
    pub unknown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeCounts {
    pub strong_group: String,
    pub weak_group: String,
    pub observed_eof_provisional_session: String,
    pub unknown_session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCounts {
    pub indexed: String,
    pub active: String,
    pub rolled_back: String,
    pub unknown_visibility: String,
    pub hard_sealed: String,
    pub quiescent: String,
    pub open: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCounts {
    pub total: String,
    pub tool: String,
    pub skill: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRollup {
    pub provider: String,
    pub raw_session_count: String,
    pub eligible_session_count: String,
    pub indexed_turn_count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRollup {
    pub project_key: String,
    pub raw_session_count: String,
    pub eligible_session_count: String,
    pub indexed_turn_count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedItems<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageCount {
    pub key: String,
    pub count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCount {
    pub code: String,
    pub count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsOverview {
    pub snapshot_seq: String,
    pub sessions: SessionCounts,
    pub scopes: ScopeCounts,
    pub dedupe: DedupeCounts,
    pub turns: TurnCounts,
    pub capabilities: CapabilityCounts,
    pub providers: BoundedItems<ProviderRollup>,
    pub projects: BoundedItems<ProjectRollup>,
    pub coverage: BoundedItems<CoverageCount>,
    pub diagnostics: BoundedItems<DiagnosticCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityTerminalCounts {
    pub pending: String,
    pub completed: String,
    pub failed: String,
    pub cancelled: String,
    pub unknown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStrengthCounts {
    pub observed: String,
    pub confirmed: String,
    pub inferred: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySummary {
    pub capability_key: String,
    pub provider: String,
    pub kind: CapabilityListKind,
    pub canonical_name: String,
    pub use_count: String,
    pub turn_count: String,
    pub session_count: String,
    pub terminal: CapabilityTerminalCounts,
    pub strength: CapabilityStrengthCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityPage {
    pub snapshot_seq: String,
    pub items: Vec<CapabilitySummary>,
    pub next_cursor: Option<String>,
}

fn corrupt(message: &'static str) -> StorageError {
    StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", message)
}

fn count(value: i64) -> Result<String, StorageError> {
    u64::try_from(value)
        .map(|value| value.to_string())
        .map_err(|_| corrupt("stored Insights count is outside uint64"))
}

fn count_columns<const N: usize>(row: &Row<'_>) -> rusqlite::Result<[i64; N]> {
    let mut values = [0_i64; N];
    for (index, value) in values.iter_mut().enumerate() {
        *value = row.get(index)?;
    }
    Ok(values)
}

fn session_counts(transaction: &Transaction<'_>) -> Result<SessionCounts, StorageError> {
    let values = transaction.query_row(
        "WITH purged AS (
           SELECT COUNT(*) AS count FROM source_purge_states purge
           WHERE NOT EXISTS (
             SELECT 1 FROM overview_session_rollups r WHERE r.session_key=purge.session_key
           )
         )
         SELECT COUNT(*)+(SELECT count FROM purged),
                COALESCE(SUM(eligibility='eligible'),0),
                COALESCE(SUM(eligibility='excluded'),0)+(SELECT count FROM purged),
                COALESCE(SUM(eligibility='subagent-excluded'),0),
                COALESCE(SUM(eligibility NOT IN ('eligible','excluded','subagent-excluded')),0)
         FROM overview_session_rollups",
        [],
        count_columns::<5>,
    )?;
    Ok(SessionCounts {
        raw: count(values[0])?,
        eligible: count(values[1])?,
        excluded: count(values[2])?,
        subagent_excluded: count(values[3])?,
        unknown: count(values[4])?,
    })
}

fn scope_counts(transaction: &Transaction<'_>) -> Result<ScopeCounts, StorageError> {
    let values = transaction.query_row(
        "WITH purged AS (
           SELECT COUNT(*) AS count FROM source_purge_states purge
           WHERE NOT EXISTS (
             SELECT 1 FROM overview_session_rollups r WHERE r.session_key=purge.session_key
           )
         )
         SELECT COALESCE(SUM(session_scope='main'),0),
                COALESCE(SUM(session_scope='subagent'),0),
                COALESCE(SUM(session_scope NOT IN ('main','subagent')),0)
                  +(SELECT count FROM purged)
         FROM overview_session_rollups",
        [],
        count_columns::<3>,
    )?;
    Ok(ScopeCounts {
        main: count(values[0])?,
        subagent: count(values[1])?,
        unknown: count(values[2])?,
    })
}

fn dedupe_counts(transaction: &Transaction<'_>) -> Result<DedupeCounts, StorageError> {
    let (strong, weak): (i64, i64) = transaction.query_row(
        "WITH member_sets AS (
           SELECT duplicate_group_key AS group_key,
                  dedupe_corroboration_fingerprint AS corroboration,
                  MAX(CASE WHEN duplicate_method='explicit-lineage'
                                AND duplicate_confidence='strong'
                           THEN 1 ELSE 0 END) AS explicit_strong,
                  COUNT(*) AS member_count
           FROM overview_session_rollups s
           WHERE eligibility='eligible' AND session_scope='main'
             AND duplicate_group_key IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
             )
           GROUP BY duplicate_group_key,dedupe_corroboration_fingerprint
         ), groups AS (
           SELECT group_key,
                  CASE WHEN MAX(explicit_strong)=1 OR (
                       SUM(CASE WHEN corroboration IS NOT NULL THEN 1 ELSE 0 END)=1
                       AND MAX(CASE WHEN corroboration IS NOT NULL THEN member_count ELSE 0 END)>=2
                  ) THEN 1 ELSE 0 END AS is_strong
           FROM member_sets GROUP BY group_key
         )
         SELECT COALESCE(SUM(is_strong=1),0),COALESCE(SUM(is_strong=0),0) FROM groups",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (observed_eof, unknown): (i64, i64) = transaction.query_row(
        "SELECT COALESCE(SUM(dedupe_closure='observed-eof'),0),
                COALESCE(SUM(duplicate_group_key IS NULL),0)
         FROM overview_session_rollups s
         WHERE eligibility='eligible' AND session_scope='main'
           AND NOT EXISTS (
             SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
           )",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(DedupeCounts {
        strong_group: count(strong)?,
        weak_group: count(weak)?,
        observed_eof_provisional_session: count(observed_eof)?,
        unknown_session: count(unknown)?,
    })
}

// This is intentionally identical to query.rs::hard_sealed_sql. Overview and search use the
// same provider evidence requirements even though they expose different read models.
fn hard_sealed_sql() -> &'static str {
    "((t.next_user_boundary=1 AND EXISTS (
       SELECT 1 FROM turn_evidence seal_link
       JOIN evidence_events seal_event ON seal_event.event_id=seal_link.event_id
       JOIN visible_message_events seal_message ON seal_message.event_id=seal_event.event_id
       WHERE seal_link.turn_id=t.turn_id AND seal_link.role='follow-up'
         AND seal_message.message_role='user'))
     OR (t.provider_terminal IS NOT NULL AND EXISTS (
       SELECT 1 FROM turn_evidence seal_link
       JOIN evidence_events seal_event ON seal_event.event_id=seal_link.event_id
       JOIN turn_lifecycle_events seal_lifecycle ON seal_lifecycle.event_id=seal_event.event_id
       WHERE seal_link.turn_id=t.turn_id AND seal_link.role='lifecycle'
         AND ((t.provider_terminal='completed' AND seal_lifecycle.lifecycle_state='completed')
           OR (t.provider_terminal='aborted' AND seal_lifecycle.lifecycle_state='aborted')))))"
}

fn refresh_session_fact_signals(
    transaction: &Transaction<'_>,
    session_id: i64,
    signal_kind: &'static str,
    source_table: &'static str,
    key_column: &'static str,
    count_column: &'static str,
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM overview_session_fact_signals
         WHERE session_id=?1 AND signal_kind=?2",
        params![session_id, signal_kind],
    )?;
    let sql = format!("SELECT {key_column},{count_column} FROM {source_table} WHERE session_id=?1");
    let mut statement = transaction.prepare(&sql)?;
    let mut rows = statement.query([session_id])?;
    let mut totals = BTreeMap::<String, (u64, bool)>::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let value = blob_u64(row.get(1)?)?;
        let (safe_key, normalized) = safe_fact_signal(&key);
        let entry = totals.entry(safe_key.to_owned()).or_default();
        entry.0 = entry
            .0
            .checked_add(value)
            .ok_or_else(|| corrupt("aggregated Fact count exceeds uint64"))?;
        entry.1 |= normalized;
    }
    drop(rows);
    drop(statement);
    for (key, (value, normalized)) in totals {
        transaction.execute(
            "INSERT INTO overview_session_fact_signals(
               session_id,signal_kind,signal_key,signal_count,normalized
             ) VALUES (?1,?2,?3,?4,?5)",
            params![
                session_id,
                signal_kind,
                key,
                value.to_be_bytes().to_vec(),
                i64::from(normalized)
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn refresh_session_overview_rollup(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> Result<(), StorageError> {
    let hard = hard_sealed_sql();
    let sql = format!(
        "INSERT INTO overview_session_rollups(
           session_id,session_key,provider,project_key,session_scope,eligibility,
           duplicate_group_key,duplicate_method,duplicate_confidence,
           dedupe_corroboration_fingerprint,dedupe_closure,eof_observed,source_mtime_ns,
           active_turn_count,rolled_back_turn_count,unknown_visibility_count,
           hard_sealed_turn_count
         )
         SELECT s.session_id,s.session_key,s.provider,s.project_key,s.session_scope,s.eligibility,
                s.duplicate_group_key,s.duplicate_method,s.duplicate_confidence,
                s.dedupe_corroboration_fingerprint,s.dedupe_closure,
                COALESCE(sc.eof_observed,0),COALESCE(sc.source_mtime_ns,zeroblob(8)),
                COALESCE(SUM(CASE WHEN t.effective_provider_visibility='active'
                                  THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN t.effective_provider_visibility='rolled-back'
                                  THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN t.turn_id IS NOT NULL
                                       AND t.effective_provider_visibility NOT IN ('active','rolled-back')
                                  THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN t.effective_provider_visibility='active' AND ({hard})
                                  THEN 1 ELSE 0 END),0)
         FROM sessions s
         LEFT JOIN source_checkpoints sc ON sc.session_id=s.session_id
         LEFT JOIN turns t ON t.session_id=s.session_id
         WHERE s.session_id=?1
         GROUP BY s.session_id
         ON CONFLICT(session_id) DO UPDATE SET
           session_key=excluded.session_key,provider=excluded.provider,
           project_key=excluded.project_key,session_scope=excluded.session_scope,
           eligibility=excluded.eligibility,duplicate_group_key=excluded.duplicate_group_key,
           duplicate_method=excluded.duplicate_method,
           duplicate_confidence=excluded.duplicate_confidence,
           dedupe_corroboration_fingerprint=excluded.dedupe_corroboration_fingerprint,
           dedupe_closure=excluded.dedupe_closure,eof_observed=excluded.eof_observed,
           source_mtime_ns=excluded.source_mtime_ns,
           active_turn_count=excluded.active_turn_count,
           rolled_back_turn_count=excluded.rolled_back_turn_count,
           unknown_visibility_count=excluded.unknown_visibility_count,
           hard_sealed_turn_count=excluded.hard_sealed_turn_count"
    );
    let changed = transaction.execute(&sql, [session_id])?;
    if changed == 0 {
        return Err(corrupt(
            "Overview rollup session disappeared during refresh",
        ));
    }

    transaction.execute(
        "DELETE FROM overview_session_capabilities WHERE session_id=?1",
        [session_id],
    )?;
    transaction.execute(
        "INSERT INTO overview_session_capabilities(session_id,capability_key,capability_kind)
         SELECT DISTINCT u.session_id,c.capability_key,c.capability_kind
         FROM capability_uses u
         JOIN turns t ON t.turn_id=u.turn_id
         JOIN capabilities c ON c.capability_id=u.capability_id
         WHERE u.session_id=?1 AND u.origin_scope='main'
           AND t.effective_provider_visibility='active'",
        [session_id],
    )?;
    refresh_session_fact_signals(
        transaction,
        session_id,
        "coverage",
        "fact_coverage",
        "coverage_key",
        "coverage_count",
    )?;
    refresh_session_fact_signals(
        transaction,
        session_id,
        "diagnostic",
        "fact_diagnostics",
        "code",
        "diagnostic_count",
    )
}

pub(crate) fn initialize_overview_rollup_schema(
    connection: &mut Connection,
) -> Result<(), StorageError> {
    connection.execute_batch(OVERVIEW_ROLLUP_SCHEMA)?;
    let current = connection
        .query_row(
            "SELECT schema_version FROM overview_rollup_state WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if current == Some(OVERVIEW_ROLLUP_SCHEMA_VERSION) {
        return Ok(());
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("DELETE FROM overview_session_fact_signals", [])?;
    transaction.execute("DELETE FROM overview_session_capabilities", [])?;
    transaction.execute("DELETE FROM overview_session_rollups", [])?;
    let session_ids = {
        let mut statement =
            transaction.prepare("SELECT session_id FROM sessions ORDER BY session_id")?;
        statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for session_id in session_ids {
        refresh_session_overview_rollup(&transaction, session_id)?;
    }
    transaction.execute(
        "INSERT INTO overview_rollup_state(singleton,schema_version) VALUES (1,?1)
         ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version",
        [OVERVIEW_ROLLUP_SCHEMA_VERSION],
    )?;
    transaction.commit()?;
    Ok(())
}

fn turn_counts(
    transaction: &Transaction<'_>,
    request: InsightsOverviewRequest,
) -> Result<TurnCounts, StorageError> {
    let visibility = transaction.query_row(
        "SELECT COALESCE(SUM(active_turn_count),0),
                COALESCE(SUM(rolled_back_turn_count),0),
                COALESCE(SUM(unknown_visibility_count),0)
         FROM overview_session_rollups r
         WHERE r.eligibility='eligible' AND r.session_scope='main'
           AND NOT EXISTS (
             SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
           )",
        [],
        count_columns::<3>,
    )?;
    let threshold_ns = request
        .now_unix_ms
        .saturating_sub(u64::from(request.quiescence_seconds) * 1_000)
        .saturating_mul(1_000_000)
        .to_be_bytes()
        .to_vec();
    let closure = transaction.query_row(
        "SELECT COALESCE(SUM(hard_sealed_turn_count),0),
                COALESCE(SUM(
                  (active_turn_count-hard_sealed_turn_count)
                  * (eof_observed=1 AND source_mtime_ns<=?1)
                ),0),
                COALESCE(SUM(
                  (active_turn_count-hard_sealed_turn_count)
                  * NOT (eof_observed=1 AND source_mtime_ns<=?1)
                ),0)
         FROM overview_session_rollups r
         WHERE r.eligibility='eligible' AND r.session_scope='main'
           AND NOT EXISTS (
             SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
           )",
        params![threshold_ns],
        count_columns::<3>,
    )?;
    Ok(TurnCounts {
        indexed: count(visibility[0])?,
        active: count(visibility[0])?,
        rolled_back: count(visibility[1])?,
        unknown_visibility: count(visibility[2])?,
        hard_sealed: count(closure[0])?,
        quiescent: count(closure[1])?,
        open: count(closure[2])?,
    })
}

fn capability_counts(transaction: &Transaction<'_>) -> Result<CapabilityCounts, StorageError> {
    let values = transaction.query_row(
        "SELECT COUNT(DISTINCT c.capability_key),
                COUNT(DISTINCT CASE WHEN c.capability_kind='tool' THEN c.capability_key END),
                COUNT(DISTINCT CASE WHEN c.capability_kind='skill' THEN c.capability_key END)
         FROM overview_session_capabilities c
         JOIN overview_session_rollups r ON r.session_id=c.session_id
         WHERE r.eligibility='eligible' AND r.session_scope='main'
           AND NOT EXISTS (
             SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
           )",
        [],
        count_columns::<3>,
    )?;
    Ok(CapabilityCounts {
        total: count(values[0])?,
        tool: count(values[1])?,
        skill: count(values[2])?,
    })
}

fn provider_rollups(
    transaction: &Transaction<'_>,
) -> Result<BoundedItems<ProviderRollup>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT r.provider,
                COUNT(*),
                COALESCE(SUM(CASE WHEN r.eligibility='eligible' AND NOT EXISTS (
                  SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
                ) THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN r.eligibility='eligible' AND r.session_scope='main'
                  AND NOT EXISTS (
                    SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
                  ) THEN r.active_turn_count ELSE 0 END),0)
         FROM overview_session_rollups r
         GROUP BY r.provider ORDER BY r.provider ASC LIMIT ?1",
    )?;
    let mut items = statement
        .query_map(
            [i64::try_from(MAX_OVERVIEW_PROVIDERS + 1).unwrap()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let truncated = items.len() > MAX_OVERVIEW_PROVIDERS;
    items.truncate(MAX_OVERVIEW_PROVIDERS);
    Ok(BoundedItems {
        items: items
            .into_iter()
            .map(|item| {
                Ok(ProviderRollup {
                    provider: item.0,
                    raw_session_count: count(item.1)?,
                    eligible_session_count: count(item.2)?,
                    indexed_turn_count: count(item.3)?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?,
        truncated,
    })
}

fn project_rollups(
    transaction: &Transaction<'_>,
) -> Result<BoundedItems<ProjectRollup>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT lower(hex(r.project_key)),
                COUNT(*),
                COALESCE(SUM(CASE WHEN r.eligibility='eligible' AND NOT EXISTS (
                  SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
                ) THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN r.eligibility='eligible' AND r.session_scope='main'
                  AND NOT EXISTS (
                    SELECT 1 FROM source_purge_states purge WHERE purge.session_key=r.session_key
                  ) THEN r.active_turn_count ELSE 0 END),0)
         FROM overview_session_rollups r
         WHERE r.project_key IS NOT NULL
         GROUP BY r.project_key ORDER BY r.project_key ASC LIMIT ?1",
    )?;
    let mut items = statement
        .query_map([i64::try_from(MAX_OVERVIEW_PROJECTS + 1).unwrap()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let truncated = items.len() > MAX_OVERVIEW_PROJECTS;
    items.truncate(MAX_OVERVIEW_PROJECTS);
    Ok(BoundedItems {
        items: items
            .into_iter()
            .map(|item| {
                Ok(ProjectRollup {
                    project_key: item.0,
                    raw_session_count: count(item.1)?,
                    eligible_session_count: count(item.2)?,
                    indexed_turn_count: count(item.3)?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?,
        truncated,
    })
}

fn blob_u64(value: Vec<u8>) -> Result<u64, StorageError> {
    let bytes: [u8; 8] = value
        .try_into()
        .map_err(|_| corrupt("stored Fact count is not an 8-byte uint64"))?;
    Ok(u64::from_be_bytes(bytes))
}

const SAFE_FACT_SIGNALS: &[&str] = &[
    "ambiguous-session-skipped",
    "ambiguous-turn-terminal",
    "claude-uuid-dedupe-overflow",
    "coverage-key-overflow",
    "dedupe-unknown-fact-truncation",
    "diagnostic-code-overflow",
    "file-scope-unknown",
    "file-subagent-excluded",
    "ignored-compact-summary",
    "ignored-compacted",
    "ignored-context-compacted",
    "ignored-duplicate-uuid",
    "ignored-hidden-user-message",
    "ignored-meta",
    "ignored-provider-twin",
    "ignored-thinking",
    "ignored-tool-twin",
    "inline-subagent-record",
    "invalid-capability-name",
    "invalid-json-record",
    "invalid-rollback-count",
    "invalid-tool-input",
    "invalid-unicode-replaced",
    "orphan-skill-load",
    "orphan-tool-result",
    "oversized-json-record",
    "oversized-tool-input",
    "record-content-items-truncated",
    "records",
    "sidechain-record",
    "tool-input-truncated",
    "unknown-provider-record",
    "unknown-session-scope",
    "unnamed-subagent-file-skipped",
];

fn safe_fact_signal(value: &str) -> (&str, bool) {
    if SAFE_FACT_SIGNALS.contains(&value) {
        return (value, false);
    }
    if value.starts_with("unknown-event-msg:") {
        return ("unknown-event-msg", true);
    }
    if value.starts_with("unknown-record:") {
        return ("unknown-record", true);
    }
    if value.starts_with("ignored-response-item:") {
        return ("ignored-response-item", true);
    }
    ("other", true)
}

fn bounded_fact_counts<T>(
    transaction: &Transaction<'_>,
    signal_kind: &'static str,
    make: impl Fn(String, String) -> T,
) -> Result<BoundedItems<T>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT signal_key,signal_count,normalized
         FROM overview_session_fact_signals WHERE signal_kind=?1",
    )?;
    let mut rows = statement.query([signal_kind])?;
    let mut totals = BTreeMap::<String, u64>::new();
    let mut truncated = false;
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let value = blob_u64(row.get(1)?)?;
        truncated |= row.get::<_, i64>(2)? != 0;
        let target = if totals.contains_key(&key) || totals.len() < MAX_OVERVIEW_FACT_SIGNALS - 1 {
            key.as_str()
        } else {
            truncated = true;
            "other"
        };
        let total = totals.entry(target.to_owned()).or_default();
        *total = total
            .checked_add(value)
            .ok_or_else(|| corrupt("aggregated Fact count exceeds uint64"))?;
    }
    Ok(BoundedItems {
        items: totals
            .into_iter()
            .map(|(key, count)| make(key, count.to_string()))
            .collect(),
        truncated,
    })
}

pub fn read_insights_overview(
    connection: &Connection,
    request: InsightsOverviewRequest,
) -> Result<InsightsOverview, StorageError> {
    let request = request.validate()?;
    let transaction = connection.unchecked_transaction()?;
    let snapshot_seq = transaction.query_row(
        "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
        [],
        |row| row.get::<_, String>(0),
    )?;
    let overview = InsightsOverview {
        snapshot_seq,
        sessions: session_counts(&transaction)?,
        scopes: scope_counts(&transaction)?,
        dedupe: dedupe_counts(&transaction)?,
        turns: turn_counts(&transaction, request)?,
        capabilities: capability_counts(&transaction)?,
        providers: provider_rollups(&transaction)?,
        projects: project_rollups(&transaction)?,
        coverage: bounded_fact_counts(&transaction, "coverage", |key, count| CoverageCount {
            key,
            count,
        })?,
        diagnostics: bounded_fact_counts(&transaction, "diagnostic", |code, count| {
            DiagnosticCount { code, count }
        })?,
    };
    transaction.commit()?;
    Ok(overview)
}

fn capability_summary(
    row: &Row<'_>,
    kind: CapabilityListKind,
) -> rusqlite::Result<CapabilitySummary> {
    let values = [
        row.get::<_, i64>(4)?,
        row.get::<_, i64>(5)?,
        row.get::<_, i64>(6)?,
        row.get::<_, i64>(7)?,
        row.get::<_, i64>(8)?,
        row.get::<_, i64>(9)?,
        row.get::<_, i64>(10)?,
        row.get::<_, i64>(11)?,
        row.get::<_, i64>(12)?,
        row.get::<_, i64>(13)?,
        row.get::<_, i64>(14)?,
    ];
    let decimal = |index: usize| {
        u64::try_from(values[index])
            .map(|value| value.to_string())
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index + 4, values[index]))
    };
    Ok(CapabilitySummary {
        capability_key: row.get(0)?,
        provider: row.get(1)?,
        kind,
        canonical_name: row.get(2)?,
        use_count: decimal(0)?,
        turn_count: decimal(1)?,
        session_count: decimal(2)?,
        terminal: CapabilityTerminalCounts {
            pending: decimal(3)?,
            completed: decimal(4)?,
            failed: decimal(5)?,
            cancelled: decimal(6)?,
            unknown: decimal(7)?,
        },
        strength: CapabilityStrengthCounts {
            observed: decimal(8)?,
            confirmed: decimal(9)?,
            inferred: decimal(10)?,
        },
    })
}

pub fn list_capabilities(
    connection: &Connection,
    request: CapabilityPageRequest,
) -> Result<CapabilityPage, StorageError> {
    let request = request.validate()?;
    let transaction = connection.unchecked_transaction()?;
    let snapshot_seq = transaction.query_row(
        "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
        [],
        |row| row.get::<_, String>(0),
    )?;
    let cursor = request
        .cursor
        .as_deref()
        .map(hex::decode)
        .transpose()
        .map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_INVALID_CAPABILITY_PAGE",
                "capability page cursor must be a lowercase stable key",
            )
        })?;
    let mut statement = transaction.prepare(
        "SELECT lower(hex(c.capability_key)),c.provider,c.canonical_name,c.capability_kind,
                COUNT(*),COUNT(DISTINCT u.turn_id),COUNT(DISTINCT u.session_id),
                COALESCE(SUM(u.provider_terminal_state='pending'),0),
                COALESCE(SUM(u.provider_terminal_state='completed'),0),
                COALESCE(SUM(u.provider_terminal_state='failed'),0),
                COALESCE(SUM(u.provider_terminal_state='cancelled'),0),
                COALESCE(SUM(u.provider_terminal_state NOT IN (
                  'pending','completed','failed','cancelled'
                )),0),
                COALESCE(SUM(u.strength='observed'),0),
                COALESCE(SUM(u.strength='confirmed'),0),
                COALESCE(SUM(u.strength='inferred'),0)
         FROM capabilities c
         JOIN capability_uses u ON u.capability_id=c.capability_id AND u.origin_scope='main'
         JOIN turns t ON t.turn_id=u.turn_id AND t.effective_provider_visibility='active'
         JOIN sessions s ON s.session_id=u.session_id
         WHERE c.capability_kind=?1
           AND (?2 IS NULL OR c.capability_key>?2)
           AND s.eligibility='eligible' AND s.session_scope='main'
           AND NOT EXISTS (
             SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
           )
         GROUP BY c.capability_id
         ORDER BY c.capability_key ASC LIMIT ?3",
    )?;
    let query_limit = i64::from(request.limit) + 1;
    let mut items = statement
        .query_map(params![request.kind.as_str(), cursor, query_limit], |row| {
            capability_summary(row, request.kind)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = items.len() > usize::from(request.limit);
    items.truncate(usize::from(request.limit));
    let next_cursor = has_more
        .then(|| items.last().map(|item| item.capability_key.clone()))
        .flatten();
    drop(statement);
    transaction.commit()?;
    Ok(CapabilityPage {
        snapshot_seq,
        items,
        next_cursor,
    })
}
