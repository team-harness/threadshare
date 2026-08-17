use crate::fact_model::HistoryEventFact;
use crate::storage::{CommitOutcome, StorageError};
use crate::{hash_key, try_canonical_json};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

pub const TRACE_SOURCE_DELTA_FORMAT: &str = "threadshare-insights-trace-source-delta@v1";
const DELIVERY_GRAPH_PROJECTION_VERSION: &str = "delivery-graph@1";
const DELIVERY_GRAPH_EDGE_GENERATION: &str = "delivery-graph-edges@2";
const MAX_COMMITS: usize = 50_000;
const MAX_FILES: usize = 2_000_000;

const DELIVERY_GRAPH_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS repository_sources (
  repository_id TEXT PRIMARY KEY,
  repository_key BLOB NOT NULL UNIQUE CHECK(length(repository_key)=32),
  generation BLOB NOT NULL CHECK(length(generation)=8),
  delta_id BLOB NOT NULL CHECK(length(delta_id)=32),
  ref_digest BLOB NOT NULL CHECK(length(ref_digest)=32),
  available INTEGER NOT NULL CHECK(available IN (0,1)),
  scm_provider TEXT,
  web_base_url TEXT,
  repository_path TEXT,
  snapshot_seq INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS repository_refs (
  repository_id TEXT NOT NULL REFERENCES repository_sources(repository_id) ON DELETE CASCADE,
  ref_name TEXT NOT NULL,
  object_id TEXT NOT NULL,
  PRIMARY KEY(repository_id,ref_name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS repository_refs_object ON repository_refs(repository_id,object_id);
CREATE TABLE IF NOT EXISTS repository_project_keys (
  repository_id TEXT NOT NULL REFERENCES repository_sources(repository_id) ON DELETE CASCADE,
  project_key BLOB NOT NULL CHECK(length(project_key)=32),
  PRIMARY KEY(repository_id,project_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS repository_project_keys_project
  ON repository_project_keys(project_key,repository_id);
CREATE TABLE IF NOT EXISTS git_commits (
  repository_id TEXT NOT NULL REFERENCES repository_sources(repository_id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  commit_key BLOB NOT NULL UNIQUE CHECK(length(commit_key)=32),
  parent_object_ids_json TEXT NOT NULL,
  author_timestamp TEXT NOT NULL,
  committer_timestamp TEXT NOT NULL,
  tree_object_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  reachable INTEGER NOT NULL CHECK(reachable IN (0,1)),
  revision BLOB NOT NULL CHECK(length(revision)=32),
  PRIMARY KEY(repository_id,object_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS git_commits_time ON git_commits(repository_id,committer_timestamp DESC,object_id);
CREATE TABLE IF NOT EXISTS git_commit_files (
  repository_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  status TEXT NOT NULL,
  additions BLOB CHECK(additions IS NULL OR length(additions)=8),
  deletions BLOB CHECK(deletions IS NULL OR length(deletions)=8),
  file_key BLOB NOT NULL CHECK(length(file_key)=32),
  revision BLOB NOT NULL CHECK(length(revision)=32),
  PRIMARY KEY(repository_id,object_id,path),
  FOREIGN KEY(repository_id,object_id) REFERENCES git_commits(repository_id,object_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS git_commit_files_path ON git_commit_files(repository_id,path,object_id);
CREATE TABLE IF NOT EXISTS delivery_trace_edges (
  repository_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  edge_key BLOB NOT NULL UNIQUE CHECK(length(edge_key)=32),
  from_kind TEXT NOT NULL,
  from_key BLOB NOT NULL CHECK(length(from_key)=32),
  to_kind TEXT NOT NULL,
  to_key BLOB NOT NULL CHECK(length(to_key)=32),
  relation TEXT NOT NULL,
  strength TEXT NOT NULL,
  source TEXT NOT NULL,
  revision BLOB NOT NULL CHECK(length(revision)=32),
  PRIMARY KEY(repository_id,object_id,edge_key),
  FOREIGN KEY(repository_id,object_id) REFERENCES git_commits(repository_id,object_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS delivery_trace_edges_from ON delivery_trace_edges(repository_id,from_kind,from_key,relation,to_key);
CREATE INDEX IF NOT EXISTS delivery_trace_edges_to ON delivery_trace_edges(repository_id,to_kind,to_key,relation,from_key);
CREATE TABLE IF NOT EXISTS delivery_trace_edge_evidence (
  edge_key BLOB PRIMARY KEY REFERENCES delivery_trace_edges(edge_key) ON DELETE CASCADE,
  facts_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS observed_git_commits (
  event_key BLOB NOT NULL REFERENCES history_events(event_key) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  observed_timestamp TEXT,
  PRIMARY KEY(event_key,object_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS observed_git_commits_session
  ON observed_git_commits(session_id,object_id,event_key);
CREATE TABLE IF NOT EXISTS observed_git_commit_prefixes (
  event_key BLOB NOT NULL REFERENCES history_events(event_key) ON DELETE CASCADE,
  object_id_prefix TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  observed_timestamp TEXT,
  PRIMARY KEY(event_key,object_id_prefix)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS observed_git_commit_prefixes_session
  ON observed_git_commit_prefixes(session_id,object_id_prefix,event_key);
CREATE TABLE IF NOT EXISTS intent_sources (
  repository_id TEXT PRIMARY KEY REFERENCES repository_sources(repository_id) ON DELETE CASCADE,
  source_key BLOB NOT NULL UNIQUE CHECK(length(source_key)=32),
  adapter_version TEXT NOT NULL,
  revision BLOB NOT NULL CHECK(length(revision)=32),
  locator TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial','unavailable')),
  diagnostics_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS intent_nodes (
  repository_id TEXT NOT NULL REFERENCES intent_sources(repository_id) ON DELETE CASCADE,
  intent_key BLOB NOT NULL UNIQUE CHECK(length(intent_key)=32),
  node_id TEXT NOT NULL,
  parent_intent_key BLOB CHECK(parent_intent_key IS NULL OR length(parent_intent_key)=32),
  kind TEXT NOT NULL CHECK(kind IN ('feature','story')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','todo')),
  stable_id INTEGER NOT NULL CHECK(stable_id IN (0,1)),
  revision BLOB NOT NULL CHECK(length(revision)=32),
  PRIMARY KEY(repository_id,node_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS intent_nodes_parent ON intent_nodes(repository_id,parent_intent_key,intent_key);
CREATE TABLE IF NOT EXISTS intent_refs (
  repository_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('session','commit','spec','issue')),
  ref_value TEXT NOT NULL,
  revision BLOB NOT NULL CHECK(length(revision)=32),
  PRIMARY KEY(repository_id,node_id,ref_kind,ref_value),
  FOREIGN KEY(repository_id,node_id) REFERENCES intent_nodes(repository_id,node_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS intent_refs_value ON intent_refs(repository_id,ref_kind,ref_value,node_id);
CREATE TABLE IF NOT EXISTS intent_trace_edges (
  repository_id TEXT NOT NULL REFERENCES intent_sources(repository_id) ON DELETE CASCADE,
  edge_key BLOB NOT NULL UNIQUE CHECK(length(edge_key)=32),
  from_key BLOB NOT NULL CHECK(length(from_key)=32),
  to_kind TEXT NOT NULL CHECK(to_kind IN ('session','git-commit')),
  to_key BLOB NOT NULL CHECK(length(to_key)=32),
  relation TEXT NOT NULL CHECK(relation IN ('intent-declares-session','intent-declares-commit','intent-correlates-session')),
  strength TEXT NOT NULL CHECK(strength IN ('direct','candidate')),
  source TEXT NOT NULL CHECK(source IN ('intent-explicit-session-ref','intent-explicit-commit-ref','unique-text-overlap')),
  facts_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  revision BLOB NOT NULL CHECK(length(revision)=32),
  PRIMARY KEY(repository_id,edge_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS intent_trace_edges_from ON intent_trace_edges(repository_id,from_key,relation,to_key);
CREATE INDEX IF NOT EXISTS intent_trace_edges_to ON intent_trace_edges(repository_id,to_kind,to_key,relation,from_key);
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryDelta {
    pub repository_id: String,
    pub repository_key: String,
    pub available: bool,
    pub ref_digest: String,
    pub scm_provider: Option<String>,
    pub web_base_url: Option<String>,
    pub repository_path: Option<String>,
    pub project_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryRefDelta {
    pub name: String,
    pub object_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitFileDelta {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: Option<String>,
    pub deletions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitDelta {
    pub object_id: String,
    pub parent_object_ids: Vec<String>,
    pub author_timestamp: String,
    pub committer_timestamp: String,
    pub tree_object_id: String,
    pub summary: String,
    pub files: Vec<GitCommitFileDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitRecordDelta {
    pub object_id: String,
    pub parent_object_ids: Vec<String>,
    pub author_timestamp: String,
    pub committer_timestamp: String,
    pub tree_object_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitFileRecordDelta {
    pub object_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: Option<String>,
    pub deletions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentDiagnosticDelta {
    pub line: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentSourceDelta {
    pub source_key: String,
    pub adapter_version: String,
    pub revision: String,
    pub locator: String,
    pub coverage: String,
    pub diagnostics: Vec<IntentDiagnosticDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentNodeDelta {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub stable_id: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentRefDelta {
    pub node_id: String,
    pub kind: String,
    pub value: String,
}

impl From<&GitCommitDelta> for GitCommitRecordDelta {
    fn from(value: &GitCommitDelta) -> Self {
        Self {
            object_id: value.object_id.clone(),
            parent_object_ids: value.parent_object_ids.clone(),
            author_timestamp: value.author_timestamp.clone(),
            committer_timestamp: value.committer_timestamp.clone(),
            tree_object_id: value.tree_object_id.clone(),
            summary: value.summary.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceSourceDeltaV1 {
    pub format: String,
    pub delta_id: String,
    pub expected_generation: String,
    pub target_generation: String,
    pub repository: RepositoryDelta,
    pub intent: Option<IntentSourceDelta>,
    pub refs: Vec<RepositoryRefDelta>,
    pub commits: Vec<GitCommitDelta>,
    pub intent_nodes: Vec<IntentNodeDelta>,
    pub intent_refs: Vec<IntentRefDelta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatePage {
    pub generation: String,
    pub available: Option<bool>,
    pub ref_digest: Option<String>,
    pub intent_revision: Option<String>,
    pub coverage_after: Option<String>,
    pub refs: Vec<RepositoryRefDelta>,
    pub next_cursor: Option<String>,
}

fn invalid(message: &'static str) -> StorageError {
    StorageError::new("TS_INSIGHTS_INVALID_DELTA", message)
}

fn valid_hex(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

pub(crate) fn parse_u64(value: &str) -> Result<u64, StorageError> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return Err(invalid("trace source generation is invalid"));
    }
    value
        .parse()
        .map_err(|_| invalid("trace source generation is invalid"))
}

pub(crate) fn parse_optional_u64(value: &Option<String>) -> Result<Option<Vec<u8>>, StorageError> {
    value
        .as_ref()
        .map(|value| parse_u64(value).map(|value| value.to_be_bytes().to_vec()))
        .transpose()
}

pub(crate) fn decode_key(value: &str) -> Result<Vec<u8>, StorageError> {
    if !valid_hex(value, &[64]) {
        return Err(invalid("trace source key is invalid"));
    }
    hex::decode(value).map_err(|_| invalid("trace source key is invalid"))
}

pub(crate) fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 12 * 1024
        && !value.starts_with('/')
        && !value.split('/').any(|part| part == "..")
}

pub(crate) fn validate_ref(reference: &RepositoryRefDelta) -> Result<(), StorageError> {
    if !reference.name.starts_with("refs/")
        || reference.name.len() > 4096
        || !valid_hex(&reference.object_id, &[40, 64])
    {
        return Err(invalid("trace source ref is invalid"));
    }
    Ok(())
}

pub(crate) fn validate_commit_record(commit: &GitCommitRecordDelta) -> Result<(), StorageError> {
    if !valid_hex(&commit.object_id, &[40, 64])
        || !valid_hex(&commit.tree_object_id, &[40, 64])
        || commit.parent_object_ids.len() > 16
        || commit.summary.len() > 4096
        || commit
            .parent_object_ids
            .iter()
            .any(|value| !valid_hex(value, &[40, 64]))
    {
        return Err(invalid("trace source commit is invalid"));
    }
    crate::agent_query::parse_canonical_timestamp(&commit.author_timestamp, "authorTimestamp")
        .map_err(|_| invalid("trace source commit timestamp is invalid"))?;
    crate::agent_query::parse_canonical_timestamp(
        &commit.committer_timestamp,
        "committerTimestamp",
    )
    .map_err(|_| invalid("trace source commit timestamp is invalid"))?;
    Ok(())
}

pub(crate) fn validate_file_record(file: &GitCommitFileRecordDelta) -> Result<(), StorageError> {
    if !valid_hex(&file.object_id, &[40, 64])
        || !valid_path(&file.path)
        || file
            .old_path
            .as_ref()
            .is_some_and(|value| !valid_path(value))
        || !matches!(
            file.status.as_str(),
            "A" | "B" | "C" | "D" | "M" | "R" | "T" | "U" | "X"
        )
    {
        return Err(invalid("trace source file change is invalid"));
    }
    parse_optional_u64(&file.additions)?;
    parse_optional_u64(&file.deletions)?;
    Ok(())
}

impl TraceSourceDeltaV1 {
    pub fn validate(&self) -> Result<(), StorageError> {
        if self.format != TRACE_SOURCE_DELTA_FORMAT
            || !valid_hex(&self.delta_id, &[64])
            || !valid_uuid(&self.repository.repository_id)
            || !valid_hex(&self.repository.repository_key, &[64])
            || !valid_hex(&self.repository.ref_digest, &[64])
            || self.repository.project_keys.len() != 2
            || self
                .repository
                .project_keys
                .iter()
                .any(|value| !valid_hex(value, &[64]))
            || self.refs.len() > 100_000
            || self.commits.len() > MAX_COMMITS
            || self.intent_nodes.len() > 10_000
            || self.intent_refs.len() > 100_000
        {
            return Err(invalid("trace source delta is invalid"));
        }
        match &self.intent {
            None if !self.intent_nodes.is_empty() || !self.intent_refs.is_empty() => {
                return Err(invalid("trace intent collections require source metadata"));
            }
            None => {}
            Some(intent) => {
                if !valid_hex(&intent.source_key, &[64])
                    || !valid_hex(&intent.revision, &[64])
                    || intent.adapter_version != "markdown-checklist@1"
                    || !valid_path(&intent.locator)
                    || !matches!(
                        intent.coverage.as_str(),
                        "complete" | "partial" | "unavailable"
                    )
                    || intent.diagnostics.len() > 4096
                    || intent.diagnostics.iter().any(|item| {
                        parse_u64(&item.line).is_err()
                            || !item.code.starts_with("TS_INSIGHTS_INTENT_")
                            || item.code.len() > 128
                    })
                {
                    return Err(invalid("trace intent source is invalid"));
                }
                let mut ids = BTreeSet::new();
                for node in &self.intent_nodes {
                    if node.id.is_empty()
                        || node.id.len() > 64
                        || !node.id.bytes().enumerate().all(|(index, byte)| {
                            byte.is_ascii_alphanumeric()
                                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
                        })
                        || !matches!(node.kind.as_str(), "feature" | "story")
                        || !matches!(node.status.as_str(), "complete" | "todo")
                        || node.title.is_empty()
                        || node.title.len() > 4096
                        || !ids.insert(node.id.as_str())
                    {
                        return Err(invalid("trace intent node is invalid"));
                    }
                    if node
                        .parent_id
                        .as_ref()
                        .is_some_and(|parent| !ids.contains(parent.as_str()))
                    {
                        return Err(invalid("trace intent parent is invalid"));
                    }
                }
                let mut refs = BTreeSet::new();
                for reference in &self.intent_refs {
                    let valid_value = match reference.kind.as_str() {
                        "session" => valid_hex(&reference.value, &[64]),
                        "commit" => valid_hex(&reference.value, &[40, 64]),
                        "spec" => valid_path(&reference.value),
                        "issue" => !reference.value.is_empty() && reference.value.len() <= 4096,
                        _ => false,
                    };
                    if !ids.contains(reference.node_id.as_str())
                        || !valid_value
                        || !refs.insert((
                            reference.node_id.as_str(),
                            reference.kind.as_str(),
                            reference.value.as_str(),
                        ))
                    {
                        return Err(invalid("trace intent reference is invalid"));
                    }
                }
            }
        }
        let expected = parse_u64(&self.expected_generation)?;
        if parse_u64(&self.target_generation)?
            != expected
                .checked_add(1)
                .ok_or_else(|| invalid("trace source generation overflow"))?
        {
            return Err(invalid("trace source target generation is invalid"));
        }
        let scm_count = [
            self.repository.scm_provider.is_some(),
            self.repository.web_base_url.is_some(),
            self.repository.repository_path.is_some(),
        ]
        .into_iter()
        .filter(|value| *value)
        .count();
        if !matches!(scm_count, 0 | 3)
            || self
                .repository
                .scm_provider
                .as_deref()
                .is_some_and(|value| !matches!(value, "github" | "gitlab"))
        {
            return Err(invalid("trace source SCM metadata is invalid"));
        }
        if self
            .repository
            .web_base_url
            .as_ref()
            .is_some_and(|value| value.len() > 4096)
            || self
                .repository
                .repository_path
                .as_ref()
                .is_some_and(|value| !valid_path(value))
        {
            return Err(invalid("trace source SCM metadata is invalid"));
        }
        let mut file_count = 0usize;
        let mut ref_names = BTreeSet::new();
        for reference in &self.refs {
            validate_ref(reference)?;
            if !ref_names.insert(&reference.name) {
                return Err(invalid("trace source ref is invalid"));
            }
        }
        let mut commit_ids = BTreeSet::new();
        for commit in &self.commits {
            file_count = file_count
                .checked_add(commit.files.len())
                .ok_or_else(|| invalid("trace source file count overflow"))?;
            let record = GitCommitRecordDelta::from(commit);
            validate_commit_record(&record)?;
            if file_count > MAX_FILES || !commit_ids.insert(&commit.object_id) {
                return Err(invalid("trace source commit is invalid"));
            }
            let mut paths = BTreeSet::new();
            for file in &commit.files {
                let record = GitCommitFileRecordDelta {
                    object_id: commit.object_id.clone(),
                    path: file.path.clone(),
                    old_path: file.old_path.clone(),
                    status: file.status.clone(),
                    additions: file.additions.clone(),
                    deletions: file.deletions.clone(),
                };
                validate_file_record(&record)?;
                if !paths.insert(&file.path) {
                    return Err(invalid("trace source file change is invalid"));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn initialize_schema(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(DELIVERY_GRAPH_SCHEMA)?;
    connection.execute(
        "INSERT OR IGNORE INTO engine_metadata(key,value) VALUES ('delivery_graph_projection',?1)",
        [DELIVERY_GRAPH_PROJECTION_VERSION],
    )?;
    reproject_edges_if_stale(connection)?;
    Ok(())
}

/// Edge projection semantics are versioned separately from the projection stage
/// gate so an index written by an earlier generation is rebuilt rather than left
/// mixing eras. A mixed graph would let one query see turn attribution for some
/// Sessions and not others.
///
/// A missing marker is the era that predates edge generations, not a fresh index, so it is
/// reprojected like any other stale generation. On a genuinely fresh index the loop below finds
/// no repository and costs nothing; skipping it there would instead stamp the current generation
/// over an index that still holds pre-generation edges, and the marker would keep it from ever
/// being rebuilt.
fn reproject_edges_if_stale(connection: &Connection) -> Result<(), StorageError> {
    let recorded: Option<String> = connection
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='delivery_graph_edges'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if recorded.as_deref() == Some(DELIVERY_GRAPH_EDGE_GENERATION) {
        return Ok(());
    }
    let mut statement = connection
        .prepare("SELECT repository_id FROM repository_sources ORDER BY repository_id")?;
    let repositories = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for repository_id in repositories {
        refresh_repository_delivery_edges(connection, &repository_id)?;
    }
    connection.execute(
        "INSERT INTO engine_metadata(key,value) VALUES ('delivery_graph_edges',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [DELIVERY_GRAPH_EDGE_GENERATION],
    )?;
    Ok(())
}

pub(crate) fn revision<T: Serialize>(value: &T) -> Result<Vec<u8>, StorageError> {
    let value =
        serde_json::to_value(value).map_err(|_| invalid("trace source value is invalid"))?;
    let canonical =
        try_canonical_json(&value).map_err(|_| invalid("trace source value is non-canonical"))?;
    Ok(Sha256::digest(canonical.as_bytes()).to_vec())
}

fn intent_key(repository_key: &[u8], node_id: &str) -> Result<Vec<u8>, StorageError> {
    hex::decode(hash_key(
        "intent",
        &[repository_key.to_vec(), node_id.as_bytes().to_vec()],
    ))
    .map_err(|_| invalid("trace intent key is invalid"))
}

pub(crate) fn replace_intent_source(
    connection: &Connection,
    repository: &RepositoryDelta,
    intent: Option<&IntentSourceDelta>,
) -> Result<(), StorageError> {
    connection.execute(
        "DELETE FROM intent_sources WHERE repository_id=?1",
        [&repository.repository_id],
    )?;
    let Some(intent) = intent else {
        return Ok(());
    };
    connection.execute(
        "INSERT INTO intent_sources(repository_id,source_key,adapter_version,revision,locator,coverage,diagnostics_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            repository.repository_id,
            decode_key(&intent.source_key)?,
            intent.adapter_version,
            decode_key(&intent.revision)?,
            intent.locator,
            intent.coverage,
            serde_json::to_string(&intent.diagnostics)
                .map_err(|_| invalid("trace intent diagnostics are invalid"))?,
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_intent_node(
    connection: &Connection,
    repository: &RepositoryDelta,
    node: &IntentNodeDelta,
) -> Result<(), StorageError> {
    let repository_key = decode_key(&repository.repository_key)?;
    let key = intent_key(&repository_key, &node.id)?;
    let parent = node
        .parent_id
        .as_deref()
        .map(|parent| intent_key(&repository_key, parent))
        .transpose()?;
    if let Some(parent) = &parent {
        let parent_exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM intent_nodes WHERE repository_id=?1 AND intent_key=?2)",
            params![repository.repository_id, parent],
            |row| row.get::<_, bool>(0),
        )?;
        if !parent_exists {
            return Err(invalid("trace intent parent is unavailable"));
        }
    }
    connection.execute(
        "INSERT INTO intent_nodes(repository_id,intent_key,node_id,parent_intent_key,kind,title,status,stable_id,revision)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            repository.repository_id,
            key,
            node.id,
            parent,
            node.kind,
            node.title,
            node.status,
            i64::from(node.stable_id),
            revision(node)?,
        ],
    )?;
    Ok(())
}

struct IntentEdgeSpec<'a> {
    repository_id: &'a str,
    from_key: &'a [u8],
    to_kind: &'a str,
    to_key: &'a [u8],
    relation: &'a str,
    strength: &'a str,
    source: &'a str,
    facts: &'a serde_json::Value,
    limitations: &'a serde_json::Value,
}

fn insert_intent_edge(
    connection: &Connection,
    spec: IntentEdgeSpec<'_>,
) -> Result<(), StorageError> {
    let IntentEdgeSpec {
        repository_id,
        from_key,
        to_kind,
        to_key,
        relation,
        strength,
        source,
        facts,
        limitations,
    } = spec;
    let edge_key = hex::decode(hash_key(
        "delivery-edge",
        &[
            from_key.to_vec(),
            to_key.to_vec(),
            relation.as_bytes().to_vec(),
        ],
    ))
    .map_err(|_| invalid("delivery edge key is invalid"))?;
    let edge_revision = revision(&serde_json::json!({
        "from": hex::encode(from_key), "to": hex::encode(to_key), "relation": relation,
        "strength": strength, "source": source, "facts": facts, "limitations": limitations,
    }))?;
    connection.execute(
        "INSERT OR REPLACE INTO intent_trace_edges(repository_id,edge_key,from_key,to_kind,to_key,relation,strength,source,facts_json,limitations_json,revision)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            repository_id, edge_key, from_key, to_kind, to_key, relation, strength, source,
            facts.to_string(), limitations.to_string(), edge_revision,
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_intent_ref(
    connection: &Connection,
    repository: &RepositoryDelta,
    reference: &IntentRefDelta,
) -> Result<(), StorageError> {
    let repository_key = decode_key(&repository.repository_key)?;
    let from_key = intent_key(&repository_key, &reference.node_id)?;
    connection.execute(
        "INSERT INTO intent_refs(repository_id,node_id,ref_kind,ref_value,revision)
         VALUES (?1,?2,?3,?4,?5)",
        params![
            repository.repository_id,
            reference.node_id,
            reference.kind,
            reference.value,
            revision(reference)?,
        ],
    )?;
    let target = match reference.kind.as_str() {
        "session" => {
            let key = decode_key(&reference.value)?;
            connection
                .query_row(
                    "SELECT session_key FROM sessions s
                     WHERE session_key=?1 AND eligibility='eligible' AND session_scope='main'
                       AND NOT EXISTS (SELECT 1 FROM source_purge_states p WHERE p.session_key=s.session_key)",
                    [&key],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()?
                .map(|value| ("session", value, "intent-declares-session", "intent-explicit-session-ref"))
        }
        "commit" => connection
            .query_row(
                "SELECT commit_key FROM git_commits WHERE repository_id=?1 AND object_id=?2",
                params![repository.repository_id, reference.value],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?
            .map(|value| {
                (
                    "git-commit",
                    value,
                    "intent-declares-commit",
                    "intent-explicit-commit-ref",
                )
            }),
        _ => None,
    };
    if let Some((to_kind, to_key, relation, source)) = target {
        insert_intent_edge(
            connection,
            IntentEdgeSpec {
                repository_id: &repository.repository_id,
                from_key: &from_key,
                to_kind,
                to_key: &to_key,
                relation,
                strength: "direct",
                source,
                facts: &serde_json::json!([{ "kind": "explicit-reference" }]),
                limitations: &serde_json::json!(["not-causality"]),
            },
        )?;
    }
    Ok(())
}

fn significant_terms(title: &str) -> BTreeSet<String> {
    title
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() >= 3)
        .take(32)
        .map(str::to_owned)
        .collect()
}

pub(crate) fn insert_candidate_intent_edges(
    connection: &Connection,
    repository: &RepositoryDelta,
) -> Result<(), StorageError> {
    let project_keys = repository
        .project_keys
        .iter()
        .map(|value| decode_key(value))
        .collect::<Result<Vec<_>, _>>()?;
    let mut sessions = BTreeMap::<Vec<u8>, BTreeSet<String>>::new();
    let mut statement = connection.prepare(
        "SELECT s.session_key,t.problem_text FROM sessions s JOIN turns t USING(session_id)
         WHERE s.project_key IN (?1,?2) AND s.eligibility='eligible' AND s.session_scope='main'
           AND t.problem_text IS NOT NULL AND t.revision IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM source_purge_states p WHERE p.session_key=s.session_key)
         ORDER BY s.session_key,t.turn_id",
    )?;
    let mut rows = statement.query(params![project_keys[0], project_keys[1]])?;
    while let Some(row) = rows.next()? {
        let key: Vec<u8> = row.get(0)?;
        let text: String = row.get(1)?;
        let entry = sessions.entry(key).or_default();
        if entry.len() < 4_096 {
            entry.extend(
                significant_terms(&text)
                    .into_iter()
                    .take(4_096 - entry.len()),
            );
        }
    }
    drop(rows);
    drop(statement);
    let mut nodes = connection.prepare(
        "SELECT intent_key,title FROM intent_nodes WHERE repository_id=?1 ORDER BY intent_key",
    )?;
    let rows = nodes
        .query_map([&repository.repository_id], |row| {
            Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(nodes);
    for (from_key, title) in rows {
        let terms = significant_terms(&title);
        if terms.len() < 2 {
            continue;
        }
        let mut scored = sessions
            .iter()
            .filter_map(|(key, session_terms)| {
                let score = terms.intersection(session_terms).count();
                (score >= 2).then_some((score, key))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(right.1)));
        let Some((score, target)) = scored.first() else {
            continue;
        };
        if scored.get(1).is_some_and(|next| next.0 == *score) {
            continue;
        }
        insert_intent_edge(
            connection,
            IntentEdgeSpec {
                repository_id: &repository.repository_id,
                from_key: &from_key,
                to_kind: "session",
                to_key: target,
                relation: "intent-correlates-session",
                strength: "candidate",
                source: "unique-text-overlap",
                facts: &serde_json::json!([
                    { "kind": "significant-term-overlap", "count": score.to_string() },
                    { "kind": "same-repository" }
                ]),
                limitations: &serde_json::json!([
                    "not-authorship",
                    "not-causality",
                    "candidate-not-default"
                ]),
            },
        )?;
    }
    Ok(())
}

pub(crate) fn insert_commit_changed_file_edge(
    connection: &Connection,
    repository_id: &str,
    repository_key: &[u8],
    object_id: &str,
    file_key: &[u8],
) -> Result<(), StorageError> {
    let commit_key = hex::decode(hash_key(
        "git-commit",
        &[repository_key.to_vec(), object_id.as_bytes().to_vec()],
    ))
    .map_err(|_| invalid("trace source commit key is invalid"))?;
    let edge_key = hex::decode(hash_key(
        "delivery-edge",
        &[
            commit_key.clone(),
            file_key.to_vec(),
            b"commit-changed-file".to_vec(),
        ],
    ))
    .map_err(|_| invalid("delivery edge key is invalid"))?;
    let edge_revision = hex::decode(hash_key(
        "delivery-trace-edge",
        &[commit_key.clone(), file_key.to_vec()],
    ))
    .map_err(|_| invalid("delivery edge revision is invalid"))?;
    connection.execute(
        "INSERT INTO delivery_trace_edges(repository_id,object_id,edge_key,from_kind,from_key,to_kind,to_key,relation,strength,source,revision)
         VALUES (?1,?2,?3,'git-commit',?4,'file',?5,'commit-changed-file','direct','git-tree-diff',?6)",
        params![
            repository_id,
            object_id,
            edge_key,
            commit_key,
            file_key,
            edge_revision
        ],
    )?;
    connection.execute(
        "INSERT INTO delivery_trace_edge_evidence(edge_key,facts_json,limitations_json)
         VALUES (?1,'[]','[\"not-exclusive-line-attribution\"]')",
        [edge_key],
    )?;
    Ok(())
}

pub(crate) fn replace_repository_project_keys(
    connection: &Connection,
    repository: &RepositoryDelta,
) -> Result<(), StorageError> {
    connection.execute(
        "DELETE FROM repository_project_keys WHERE repository_id=?1",
        [&repository.repository_id],
    )?;
    for project_key in &repository.project_keys {
        connection.execute(
            "INSERT INTO repository_project_keys(repository_id,project_key) VALUES (?1,?2)",
            params![repository.repository_id, decode_key(project_key)?],
        )?;
    }
    Ok(())
}

pub(crate) fn replace_observed_git_commits(
    connection: &Connection,
    event: &HistoryEventFact,
) -> Result<(), StorageError> {
    let event_key = event.event_key.as_bytes();
    connection.execute(
        "DELETE FROM observed_git_commits WHERE event_key=?1",
        [event_key],
    )?;
    connection.execute(
        "DELETE FROM observed_git_commit_prefixes WHERE event_key=?1",
        [event_key],
    )?;
    let metadata = event.metadata.as_object();
    if let Some(values) = metadata.and_then(|metadata| metadata.get("observedGitCommitObjectIds")) {
        let values = values
            .as_array()
            .ok_or_else(|| invalid("observed Git commit identities must be an array"))?;
        if values.len() > 16 {
            return Err(invalid("observed Git commit identities exceed their bound"));
        }
        let mut seen = BTreeSet::new();
        for value in values {
            let object_id = value
                .as_str()
                .ok_or_else(|| invalid("observed Git commit identity must be a string"))?;
            if object_id.len() != 40
                || !object_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                || !seen.insert(object_id)
            {
                return Err(invalid("observed Git commit identity is invalid"));
            }
            connection.execute(
                "INSERT INTO observed_git_commits(event_key,object_id,session_id,observed_timestamp)
                 SELECT ?1,?2,session_id,?3 FROM history_events WHERE event_key=?1",
                params![event_key, object_id, event.observed_timestamp],
            )?;
        }
    }
    let Some(values) = metadata.and_then(|metadata| metadata.get("observedGitCommitPrefixes"))
    else {
        return Ok(());
    };
    let values = values
        .as_array()
        .ok_or_else(|| invalid("observed Git commit prefixes must be an array"))?;
    if values.len() > 16 {
        return Err(invalid("observed Git commit prefixes exceed their bound"));
    }
    let mut seen = BTreeSet::new();
    for value in values {
        let object_id_prefix = value
            .as_str()
            .ok_or_else(|| invalid("observed Git commit prefix must be a string"))?;
        if !(7..40).contains(&object_id_prefix.len())
            || !object_id_prefix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !seen.insert(object_id_prefix)
        {
            return Err(invalid("observed Git commit prefix is invalid"));
        }
        connection.execute(
            "INSERT INTO observed_git_commit_prefixes(event_key,object_id_prefix,session_id,observed_timestamp)
             SELECT ?1,?2,session_id,?3 FROM history_events WHERE event_key=?1",
            params![event_key, object_id_prefix, event.observed_timestamp],
        )?;
    }
    Ok(())
}

struct DeliveryEdgeSpec<'a> {
    repository_id: &'a str,
    object_id: &'a str,
    from_kind: &'a str,
    from_key: &'a [u8],
    to_kind: &'a str,
    to_key: &'a [u8],
    relation: &'a str,
    strength: &'a str,
    source: &'a str,
    facts: &'a serde_json::Value,
    limitations: &'a serde_json::Value,
}

fn insert_delivery_edge(
    connection: &Connection,
    spec: DeliveryEdgeSpec<'_>,
) -> Result<(), StorageError> {
    let DeliveryEdgeSpec {
        repository_id,
        object_id,
        from_kind,
        from_key,
        to_kind,
        to_key,
        relation,
        strength,
        source,
        facts,
        limitations,
    } = spec;
    let edge_key = decode_key(&hash_key(
        "delivery-edge",
        &[
            from_key.to_vec(),
            to_key.to_vec(),
            relation.as_bytes().to_vec(),
        ],
    ))?;
    let facts_json =
        try_canonical_json(facts).map_err(|_| invalid("delivery edge facts are invalid"))?;
    let limitations_json = try_canonical_json(limitations)
        .map_err(|_| invalid("delivery edge limitations are invalid"))?;
    let revision = decode_key(&hash_key(
        "delivery-trace-edge",
        &[
            edge_key.clone(),
            facts_json.as_bytes().to_vec(),
            limitations_json.as_bytes().to_vec(),
        ],
    ))?;
    connection.execute(
        "INSERT OR REPLACE INTO delivery_trace_edges(
           repository_id,object_id,edge_key,from_kind,from_key,to_kind,to_key,
           relation,strength,source,revision
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            repository_id,
            object_id,
            edge_key,
            from_kind,
            from_key,
            to_kind,
            to_key,
            relation,
            strength,
            source,
            revision,
        ],
    )?;
    connection.execute(
        "INSERT OR REPLACE INTO delivery_trace_edge_evidence(edge_key,facts_json,limitations_json)
         VALUES (?1,?2,?3)",
        params![edge_key, facts_json, limitations_json],
    )?;
    Ok(())
}

fn refresh_session_repository_edges(
    connection: &Connection,
    repository_id: &str,
    session_id: i64,
) -> Result<(), StorageError> {
    let session_key: Vec<u8> = connection.query_row(
        "SELECT s.session_key FROM sessions s
         JOIN repository_project_keys p ON p.project_key=s.project_key
         WHERE s.session_id=?1 AND p.repository_id=?2",
        params![session_id, repository_id],
        |row| row.get(0),
    )?;
    connection.execute(
        "DELETE FROM delivery_trace_edges
         WHERE repository_id=?1 AND from_kind='session' AND from_key=?2",
        params![repository_id, &session_key],
    )?;
    connection.execute(
        "DELETE FROM delivery_trace_edges
         WHERE repository_id=?1 AND from_kind='turn' AND from_key IN (
           SELECT turn_key FROM turns WHERE session_id=?2
         )",
        params![repository_id, session_id],
    )?;

    let mut direct_statement = connection.prepare(
        "SELECT c.object_id,c.commit_key FROM observed_git_commits observed
         JOIN git_commits c ON c.repository_id=?1 AND c.object_id=observed.object_id
         WHERE observed.session_id=?2 ORDER BY c.object_id",
    )?;
    let direct = direct_statement
        .query_map(params![repository_id, session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(direct_statement);
    let direct_ids = direct
        .iter()
        .map(|(object_id, _)| object_id.clone())
        .collect::<BTreeSet<_>>();
    for (object_id, commit_key) in direct {
        insert_delivery_edge(
            connection,
            DeliveryEdgeSpec {
                repository_id,
                object_id: &object_id,
                from_kind: "session",
                from_key: &session_key,
                to_kind: "git-commit",
                to_key: &commit_key,
                relation: "session-observed-commit",
                strength: "direct",
                source: "observed-git-result",
                facts: &serde_json::json!([{ "kind": "full-commit-hash" }]),
                limitations: &serde_json::json!([
                    "not-authorship",
                    "not-exclusive-line-attribution"
                ]),
            },
        )?;
    }

    let mut prefix_statement = connection.prepare(
        "WITH matches AS (
           SELECT observed.object_id_prefix,c.object_id,c.commit_key,
                  COUNT(*) OVER (
                    PARTITION BY observed.event_key,observed.object_id_prefix
                  ) AS match_count
           FROM observed_git_commit_prefixes observed
           JOIN git_commits c
             ON c.repository_id=?1 AND c.reachable=1
            AND substr(c.object_id,1,length(observed.object_id_prefix))=observed.object_id_prefix
           WHERE observed.session_id=?2
         )
         SELECT object_id,commit_key,object_id_prefix FROM matches
         WHERE match_count=1 ORDER BY object_id,object_id_prefix",
    )?;
    let prefix_matches = prefix_statement
        .query_map(params![repository_id, session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(prefix_statement);
    let mut observed_prefixes = BTreeMap::new();
    for (object_id, commit_key, prefix) in prefix_matches {
        if direct_ids.contains(&object_id) {
            continue;
        }
        let entry = observed_prefixes
            .entry(object_id)
            .or_insert((commit_key, prefix.clone()));
        if prefix.len() > entry.1.len() {
            entry.1 = prefix;
        }
    }
    for (object_id, (commit_key, _prefix)) in &observed_prefixes {
        insert_delivery_edge(
            connection,
            DeliveryEdgeSpec {
                repository_id,
                object_id,
                from_kind: "session",
                from_key: &session_key,
                to_kind: "git-commit",
                to_key: commit_key,
                relation: "session-correlates-commit",
                strength: "observed",
                source: "observed-git-result",
                facts: &serde_json::json!([{ "kind": "unique-abbreviated-commit-hash" }]),
                limitations: &serde_json::json!([
                    "not-authorship",
                    "not-exclusive-line-attribution"
                ]),
            },
        )?;
    }

    let mut turn_direct_statement = connection.prepare(
        "SELECT c.object_id,c.commit_key,t.turn_key FROM observed_git_commits observed
         JOIN history_events he ON he.event_key=observed.event_key
         JOIN turns t ON t.turn_id=he.occurred_turn_id
         JOIN git_commits c ON c.repository_id=?1 AND c.object_id=observed.object_id
         WHERE observed.session_id=?2 AND t.revision IS NOT NULL
           AND t.effective_provider_visibility='active'
         GROUP BY c.object_id,c.commit_key,t.turn_key
         ORDER BY c.object_id,t.turn_key",
    )?;
    let turn_direct = turn_direct_statement
        .query_map(params![repository_id, session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(turn_direct_statement);
    let turn_direct_pairs = turn_direct
        .iter()
        .map(|(object_id, _, turn_key)| (turn_key.clone(), object_id.clone()))
        .collect::<BTreeSet<_>>();
    for (object_id, commit_key, turn_key) in &turn_direct {
        insert_delivery_edge(
            connection,
            DeliveryEdgeSpec {
                repository_id,
                object_id,
                from_kind: "turn",
                from_key: turn_key,
                to_kind: "git-commit",
                to_key: commit_key,
                relation: "turn-observed-commit",
                strength: "direct",
                source: "observed-git-result",
                facts: &serde_json::json!([{ "kind": "full-commit-hash" }]),
                limitations: &serde_json::json!([
                    "not-authorship",
                    "not-exclusive-line-attribution"
                ]),
            },
        )?;
    }

    let mut turn_prefix_statement = connection.prepare(
        "WITH matches AS (
           SELECT observed.object_id_prefix,c.object_id,c.commit_key,t.turn_key,
                  COUNT(*) OVER (
                    PARTITION BY observed.event_key,observed.object_id_prefix
                  ) AS match_count
           FROM observed_git_commit_prefixes observed
           JOIN history_events he ON he.event_key=observed.event_key
           JOIN turns t ON t.turn_id=he.occurred_turn_id
           JOIN git_commits c
             ON c.repository_id=?1 AND c.reachable=1
            AND substr(c.object_id,1,length(observed.object_id_prefix))=observed.object_id_prefix
           WHERE observed.session_id=?2 AND t.revision IS NOT NULL
             AND t.effective_provider_visibility='active'
         )
         SELECT object_id,commit_key,turn_key,object_id_prefix FROM matches
         WHERE match_count=1 ORDER BY object_id,turn_key,object_id_prefix",
    )?;
    let turn_prefix_matches = turn_prefix_statement
        .query_map(params![repository_id, session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(turn_prefix_statement);
    let mut turn_observed_prefixes = BTreeMap::new();
    for (object_id, commit_key, turn_key, prefix) in turn_prefix_matches {
        if turn_direct_pairs.contains(&(turn_key.clone(), object_id.clone())) {
            continue;
        }
        let entry = turn_observed_prefixes
            .entry((turn_key, object_id))
            .or_insert((commit_key, prefix.clone()));
        if prefix.len() > entry.1.len() {
            entry.1 = prefix;
        }
    }
    for ((turn_key, object_id), (commit_key, _prefix)) in &turn_observed_prefixes {
        insert_delivery_edge(
            connection,
            DeliveryEdgeSpec {
                repository_id,
                object_id,
                from_kind: "turn",
                from_key: turn_key,
                to_kind: "git-commit",
                to_key: commit_key,
                relation: "turn-correlates-commit",
                strength: "observed",
                source: "observed-git-result",
                facts: &serde_json::json!([{ "kind": "unique-abbreviated-commit-hash" }]),
                limitations: &serde_json::json!([
                    "not-authorship",
                    "not-exclusive-line-attribution"
                ]),
            },
        )?;
    }

    let mut statement = connection.prepare(
        "WITH paths AS (
           SELECT fa.relative_path AS path,MIN(fa.observed_timestamp) AS first_at,
                  MAX(fa.observed_timestamp) AS last_at,COUNT(*) AS event_count
           FROM file_activity fa JOIN history_events he ON he.event_key=fa.event_key
           WHERE he.session_id=?1 AND he.origin_scope='main' AND fa.phase='confirmed'
             AND fa.is_project_relative=1 AND fa.relative_path IS NOT NULL
             AND fa.observed_timestamp IS NOT NULL
           GROUP BY fa.relative_path
         ), ranked AS (
           SELECT c.object_id,c.commit_key,f.file_key,paths.path,paths.event_count,
                  CASE WHEN c.committer_timestamp>=paths.first_at
                         AND c.committer_timestamp<=paths.last_at THEN 1 ELSE 0 END AS in_window,
                  ROW_NUMBER() OVER (
                    PARTITION BY paths.path
                    ORDER BY CASE WHEN c.committer_timestamp>=paths.first_at
                                    AND c.committer_timestamp<=paths.last_at THEN 0 ELSE 1 END,
                             ABS(julianday(c.committer_timestamp)-julianday(paths.last_at)),
                             c.object_id
                  ) AS candidate_rank
           FROM paths
           JOIN git_commit_files f ON f.repository_id=?2 AND f.path=paths.path
           JOIN git_commits c ON c.repository_id=f.repository_id AND c.object_id=f.object_id
           WHERE c.reachable=1
         )
         SELECT object_id,commit_key,file_key,path,event_count,in_window
         FROM ranked WHERE candidate_rank=1 ORDER BY path",
    )?;
    let matches = statement
        .query_map(params![session_id, repository_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut commit_matches: BTreeMap<String, (Vec<u8>, u64, bool)> = BTreeMap::new();
    for (object_id, commit_key, file_key, _path, count, in_window) in matches {
        insert_delivery_edge(
            connection,
            DeliveryEdgeSpec {
                repository_id,
                object_id: &object_id,
                from_kind: "session",
                from_key: &session_key,
                to_kind: "file",
                to_key: &file_key,
                relation: "session-touched-file",
                strength: "direct",
                source: "normalized-file-event",
                facts: &serde_json::json!([
                    { "kind": "exact-path-overlap", "count": count.to_string() }
                ]),
                limitations: &serde_json::json!(["not-exclusive-line-attribution"]),
            },
        )?;
        let entry = commit_matches
            .entry(object_id)
            .or_insert((commit_key, 0, false));
        entry.1 = entry.1.saturating_add(u64::try_from(count).unwrap_or(0));
        entry.2 |= in_window;
    }
    for (object_id, (commit_key, count, in_window)) in commit_matches {
        if direct_ids.contains(&object_id) || observed_prefixes.contains_key(&object_id) {
            continue;
        }
        let (relation, strength, source, facts, limitations) = if in_window {
            (
                "session-correlates-commit",
                "observed",
                "ordered-exact-path-overlap",
                serde_json::json!([
                    { "kind": "exact-path-overlap", "count": count.to_string() },
                    { "kind": "within-observed-commit-window" }
                ]),
                serde_json::json!(["not-authorship", "not-exclusive-line-attribution"]),
            )
        } else {
            (
                "contextual-same-file",
                "contextual",
                "same-file-history",
                serde_json::json!([{ "kind": "exact-path-overlap", "count": count.to_string() }]),
                serde_json::json!(["not-authorship", "not-causality", "path-only-context"]),
            )
        };
        insert_delivery_edge(
            connection,
            DeliveryEdgeSpec {
                repository_id,
                object_id: &object_id,
                from_kind: "session",
                from_key: &session_key,
                to_kind: "git-commit",
                to_key: &commit_key,
                relation,
                strength,
                source,
                facts: &facts,
                limitations: &limitations,
            },
        )?;
    }
    Ok(())
}

pub(crate) fn refresh_session_delivery_edges(
    connection: &Connection,
    session_id: i64,
) -> Result<(), StorageError> {
    let projection_active = connection
        .query_row(
            "SELECT value=?1 FROM engine_metadata WHERE key='delivery_graph_projection'",
            [DELIVERY_GRAPH_PROJECTION_VERSION],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false);
    if !projection_active {
        return Ok(());
    }
    let mut statement = connection.prepare(
        "SELECT p.repository_id FROM sessions s
         JOIN repository_project_keys p ON p.project_key=s.project_key
         WHERE s.session_id=?1 ORDER BY p.repository_id",
    )?;
    let repositories = statement
        .query_map([session_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for repository_id in repositories {
        refresh_session_repository_edges(connection, &repository_id, session_id)?;
    }
    Ok(())
}

pub(crate) fn refresh_repository_delivery_edges(
    connection: &Connection,
    repository_id: &str,
) -> Result<(), StorageError> {
    let mut statement = connection.prepare(
        "SELECT s.session_id FROM sessions s
         JOIN repository_project_keys p ON p.project_key=s.project_key
         WHERE p.repository_id=?1 AND s.eligibility='eligible' AND s.session_scope='main'
         ORDER BY s.session_id",
    )?;
    let sessions = statement
        .query_map([repository_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for session_id in sessions {
        refresh_session_repository_edges(connection, repository_id, session_id)?;
    }
    Ok(())
}

pub(crate) fn apply_trace_source_delta(
    connection: &mut Connection,
    delta: &TraceSourceDeltaV1,
) -> Result<CommitOutcome, StorageError> {
    delta.validate()?;
    let repository_key = decode_key(&delta.repository.repository_key)?;
    let delta_id = decode_key(&delta.delta_id)?;
    let ref_digest = decode_key(&delta.repository.ref_digest)?;
    let expected = parse_u64(&delta.expected_generation)?;
    let target = parse_u64(&delta.target_generation)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = transaction.query_row(
        "SELECT generation,delta_id,snapshot_seq FROM repository_sources WHERE repository_id=?1",
        [&delta.repository.repository_id],
        |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)?)),
    ).optional()?;
    if let Some((_, current_delta_id, snapshot_seq)) = &current
        && *current_delta_id == delta_id
    {
        return Ok(CommitOutcome {
            snapshot_seq: snapshot_seq.to_string(),
            session_key: delta.repository.repository_key.clone(),
            delta_id: delta.delta_id.clone(),
            idempotent: true,
        });
    }
    let current_generation = match &current {
        None => 0,
        Some((value, _, _)) => u64::from_be_bytes(value.as_slice().try_into().map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "repository generation is invalid",
            )
        })?),
    };
    if current_generation != expected {
        return Err(StorageError::new(
            "TS_INSIGHTS_STALE_GENERATION",
            "trace source generation changed",
        ));
    }
    transaction.execute(
        "INSERT INTO repository_sources(repository_id,repository_key,generation,delta_id,ref_digest,available,scm_provider,web_base_url,repository_path,snapshot_seq)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0)
         ON CONFLICT(repository_id) DO UPDATE SET repository_key=excluded.repository_key,generation=excluded.generation,delta_id=excluded.delta_id,ref_digest=excluded.ref_digest,available=excluded.available,
           scm_provider=CASE WHEN excluded.available=0 AND excluded.scm_provider IS NULL THEN repository_sources.scm_provider ELSE excluded.scm_provider END,
           web_base_url=CASE WHEN excluded.available=0 AND excluded.web_base_url IS NULL THEN repository_sources.web_base_url ELSE excluded.web_base_url END,
           repository_path=CASE WHEN excluded.available=0 AND excluded.repository_path IS NULL THEN repository_sources.repository_path ELSE excluded.repository_path END",
        params![delta.repository.repository_id, repository_key, target.to_be_bytes().to_vec(), delta_id, ref_digest, i64::from(delta.repository.available), delta.repository.scm_provider, delta.repository.web_base_url, delta.repository.repository_path],
    )?;
    replace_repository_project_keys(&transaction, &delta.repository)?;
    replace_intent_source(&transaction, &delta.repository, delta.intent.as_ref())?;
    transaction.execute(
        "DELETE FROM repository_refs WHERE repository_id=?1",
        [&delta.repository.repository_id],
    )?;
    for reference in &delta.refs {
        transaction.execute(
            "INSERT INTO repository_refs(repository_id,ref_name,object_id) VALUES (?1,?2,?3)",
            params![
                delta.repository.repository_id,
                reference.name,
                reference.object_id
            ],
        )?;
    }
    for commit in &delta.commits {
        let commit_key = hex::decode(hash_key(
            "git-commit",
            &[repository_key.clone(), commit.object_id.as_bytes().to_vec()],
        ))
        .map_err(|_| invalid("trace source commit key is invalid"))?;
        transaction.execute(
            "INSERT INTO git_commits(repository_id,object_id,commit_key,parent_object_ids_json,author_timestamp,committer_timestamp,tree_object_id,summary,reachable,revision)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)
             ON CONFLICT(repository_id,object_id) DO UPDATE SET parent_object_ids_json=excluded.parent_object_ids_json,author_timestamp=excluded.author_timestamp,committer_timestamp=excluded.committer_timestamp,tree_object_id=excluded.tree_object_id,summary=excluded.summary,revision=excluded.revision",
            params![delta.repository.repository_id, commit.object_id, commit_key, serde_json::to_string(&commit.parent_object_ids).map_err(|_| invalid("trace source parents are invalid"))?, commit.author_timestamp, commit.committer_timestamp, commit.tree_object_id, commit.summary, revision(commit)?],
        )?;
        transaction.execute(
            "DELETE FROM delivery_trace_edges WHERE repository_id=?1 AND object_id=?2",
            params![delta.repository.repository_id, commit.object_id],
        )?;
        transaction.execute(
            "DELETE FROM git_commit_files WHERE repository_id=?1 AND object_id=?2",
            params![delta.repository.repository_id, commit.object_id],
        )?;
        for file in &commit.files {
            let file_key = hex::decode(hash_key(
                "repository-file",
                &[repository_key.clone(), file.path.as_bytes().to_vec()],
            ))
            .map_err(|_| invalid("trace source file key is invalid"))?;
            transaction.execute(
                "INSERT INTO git_commit_files(repository_id,object_id,path,old_path,status,additions,deletions,file_key,revision) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![delta.repository.repository_id, commit.object_id, file.path, file.old_path, file.status, parse_optional_u64(&file.additions)?, parse_optional_u64(&file.deletions)?, file_key, revision(file)?],
            )?;
            insert_commit_changed_file_edge(
                &transaction,
                &delta.repository.repository_id,
                &repository_key,
                &commit.object_id,
                &file_key,
            )?;
        }
    }
    for node in &delta.intent_nodes {
        insert_intent_node(&transaction, &delta.repository, node)?;
    }
    for reference in &delta.intent_refs {
        insert_intent_ref(&transaction, &delta.repository, reference)?;
    }
    insert_candidate_intent_edges(&transaction, &delta.repository)?;
    transaction.execute(
        "UPDATE git_commits SET reachable=0 WHERE repository_id=?1",
        [&delta.repository.repository_id],
    )?;
    transaction.execute(
        "WITH RECURSIVE reachable(object_id) AS (
           SELECT object_id FROM repository_refs WHERE repository_id=?1
           UNION
           SELECT parent.value FROM git_commits AS commit_row
           JOIN reachable ON reachable.object_id=commit_row.object_id
           JOIN json_each(commit_row.parent_object_ids_json) AS parent
           WHERE commit_row.repository_id=?1
         )
         UPDATE git_commits SET reachable=1 WHERE repository_id=?1 AND object_id IN (SELECT object_id FROM reachable)",
        [&delta.repository.repository_id],
    )?;
    refresh_repository_delivery_edges(&transaction, &delta.repository.repository_id)?;
    let snapshot: String = transaction.query_row(
        "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
        [],
        |row| row.get(0),
    )?;
    let snapshot_seq = parse_u64(&snapshot)?
        .checked_add(1)
        .ok_or_else(|| invalid("snapshot sequence overflow"))?;
    let snapshot_i64 =
        i64::try_from(snapshot_seq).map_err(|_| invalid("snapshot sequence overflow"))?;
    transaction.execute(
        "UPDATE engine_metadata SET value=?1 WHERE key='snapshot_seq'",
        [snapshot_seq.to_string()],
    )?;
    transaction.execute(
        "UPDATE repository_sources SET snapshot_seq=?1 WHERE repository_id=?2",
        params![snapshot_i64, delta.repository.repository_id],
    )?;
    transaction.commit()?;
    Ok(CommitOutcome {
        snapshot_seq: snapshot_seq.to_string(),
        session_key: delta.repository.repository_key.clone(),
        delta_id: delta.delta_id.clone(),
        idempotent: false,
    })
}

pub(crate) fn repository_generation(
    connection: &Connection,
    repository_id: &str,
) -> Result<Option<String>, StorageError> {
    let value = connection
        .query_row(
            "SELECT generation FROM repository_sources WHERE repository_id=?1",
            [repository_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?;
    value
        .map(|value| {
            let bytes: [u8; 8] = value.as_slice().try_into().map_err(|_| {
                StorageError::new(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "repository generation is invalid",
                )
            })?;
            Ok(u64::from_be_bytes(bytes).to_string())
        })
        .transpose()
}

pub(crate) fn repository_state_page(
    connection: &Connection,
    repository_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<RepositoryStatePage, StorageError> {
    if !valid_uuid(repository_id) || limit == 0 || limit > 256 {
        return Err(invalid("repository state request is invalid"));
    }
    let identity = connection
        .query_row(
            "SELECT generation,hex(ref_digest),available,
                    (SELECT lower(hex(revision)) FROM intent_sources intent WHERE intent.repository_id=source.repository_id)
             FROM repository_sources source WHERE repository_id=?1",
            [repository_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let coverage_after = connection.query_row(
        "SELECT MIN(observed_timestamp) FROM turns WHERE observed_timestamp IS NOT NULL",
        [],
        |row| row.get::<_, Option<String>>(0),
    )?;
    let Some((generation, ref_digest, available, intent_revision)) = identity else {
        return Ok(RepositoryStatePage {
            generation: "0".to_owned(),
            available: None,
            ref_digest: None,
            intent_revision: None,
            coverage_after,
            refs: vec![],
            next_cursor: None,
        });
    };
    let generation: [u8; 8] = generation.as_slice().try_into().map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "repository generation is invalid",
        )
    })?;
    let mut statement = connection.prepare(
        "SELECT ref_name,object_id FROM repository_refs
         WHERE repository_id=?1 AND (?2 IS NULL OR ref_name>?2)
         ORDER BY ref_name LIMIT ?3",
    )?;
    let mut refs = statement
        .query_map(
            params![
                repository_id,
                cursor,
                i64::try_from(limit + 1).unwrap_or(257)
            ],
            |row| {
                Ok(RepositoryRefDelta {
                    name: row.get(0)?,
                    object_id: row.get(1)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = if refs.len() > limit {
        refs.truncate(limit);
        refs.last().map(|reference| reference.name.clone())
    } else {
        None
    };
    Ok(RepositoryStatePage {
        generation: u64::from_be_bytes(generation).to_string(),
        available: Some(available),
        ref_digest: Some(ref_digest.to_ascii_lowercase()),
        intent_revision,
        coverage_after,
        refs,
        next_cursor,
    })
}

pub(crate) fn repository_commit_counts(
    connection: &Connection,
    repository_id: &str,
) -> Result<(u64, u64), StorageError> {
    let (total, reachable): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(reachable),0) FROM git_commits WHERE repository_id=?1",
        [repository_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((
        u64::try_from(total).unwrap_or(0),
        u64::try_from(reachable).unwrap_or(0),
    ))
}

pub(crate) fn delivery_graph_digest(connection: &Connection) -> Result<String, StorageError> {
    fn collect_rows(
        connection: &Connection,
        sql: &str,
        map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value>,
    ) -> Result<Vec<serde_json::Value>, StorageError> {
        let mut statement = connection.prepare(sql)?;
        Ok(statement
            .query_map([], map)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    let repositories = collect_rows(
        connection,
        "SELECT repository_id,hex(repository_key),hex(ref_digest),available,scm_provider,web_base_url,repository_path FROM repository_sources ORDER BY repository_id",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "repositoryKey": row.get::<_, String>(1)?.to_ascii_lowercase(),
                "refDigest": row.get::<_, String>(2)?.to_ascii_lowercase(), "available": row.get::<_, i64>(3)?,
                "scmProvider": row.get::<_, Option<String>>(4)?, "webBaseUrl": row.get::<_, Option<String>>(5)?,
                "repositoryPath": row.get::<_, Option<String>>(6)?,
            }))
        },
    )?;
    let refs = collect_rows(
        connection,
        "SELECT repository_id,ref_name,object_id FROM repository_refs ORDER BY repository_id,ref_name",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
                "objectId": row.get::<_, String>(2)?,
            }))
        },
    )?;
    let project_keys = collect_rows(
        connection,
        "SELECT repository_id,hex(project_key) FROM repository_project_keys ORDER BY repository_id,project_key",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?,
                "projectKey": row.get::<_, String>(1)?.to_ascii_lowercase(),
            }))
        },
    )?;
    let commits = collect_rows(
        connection,
        "SELECT repository_id,object_id,parent_object_ids_json,author_timestamp,committer_timestamp,tree_object_id,summary,reachable FROM git_commits ORDER BY repository_id,object_id",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "objectId": row.get::<_, String>(1)?,
                "parents": row.get::<_, String>(2)?, "authorTimestamp": row.get::<_, String>(3)?,
                "committerTimestamp": row.get::<_, String>(4)?, "treeObjectId": row.get::<_, String>(5)?,
                "summary": row.get::<_, String>(6)?, "reachable": row.get::<_, i64>(7)?,
            }))
        },
    )?;
    let files = collect_rows(
        connection,
        "SELECT repository_id,object_id,path,old_path,status,hex(additions),hex(deletions),hex(file_key) FROM git_commit_files ORDER BY repository_id,object_id,path",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "objectId": row.get::<_, String>(1)?,
                "path": row.get::<_, String>(2)?, "oldPath": row.get::<_, Option<String>>(3)?,
                "status": row.get::<_, String>(4)?, "additions": row.get::<_, String>(5)?.to_ascii_lowercase(),
                "deletions": row.get::<_, String>(6)?.to_ascii_lowercase(), "fileKey": row.get::<_, String>(7)?.to_ascii_lowercase(),
            }))
        },
    )?;
    let edges = collect_rows(
        connection,
        "SELECT edge.repository_id,edge.object_id,hex(edge.edge_key),edge.from_kind,
                hex(edge.from_key),edge.to_kind,hex(edge.to_key),edge.relation,edge.strength,
                edge.source,hex(edge.revision),evidence.facts_json,evidence.limitations_json
         FROM delivery_trace_edges edge JOIN delivery_trace_edge_evidence evidence USING(edge_key)
         ORDER BY edge.repository_id,edge.object_id,edge.edge_key",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "objectId": row.get::<_, String>(1)?,
                "edgeKey": row.get::<_, String>(2)?.to_ascii_lowercase(), "fromKind": row.get::<_, String>(3)?,
                "fromKey": row.get::<_, String>(4)?.to_ascii_lowercase(), "toKind": row.get::<_, String>(5)?,
                "toKey": row.get::<_, String>(6)?.to_ascii_lowercase(), "relation": row.get::<_, String>(7)?,
                "strength": row.get::<_, String>(8)?, "source": row.get::<_, String>(9)?,
                "revision": row.get::<_, String>(10)?.to_ascii_lowercase(),
                "facts": row.get::<_, String>(11)?, "limitations": row.get::<_, String>(12)?,
            }))
        },
    )?;
    let observed_commits = collect_rows(
        connection,
        "SELECT hex(event_key),object_id,session_id,observed_timestamp FROM observed_git_commits ORDER BY event_key,object_id",
        |row| {
            Ok(serde_json::json!({
                "eventKey": row.get::<_, String>(0)?.to_ascii_lowercase(),
                "objectId": row.get::<_, String>(1)?, "sessionId": row.get::<_, i64>(2)?,
                "observedAt": row.get::<_, Option<String>>(3)?,
            }))
        },
    )?;
    let observed_commit_prefixes = collect_rows(
        connection,
        "SELECT hex(event_key),object_id_prefix,session_id,observed_timestamp FROM observed_git_commit_prefixes ORDER BY event_key,object_id_prefix",
        |row| {
            Ok(serde_json::json!({
                "eventKey": row.get::<_, String>(0)?.to_ascii_lowercase(),
                "objectIdPrefix": row.get::<_, String>(1)?, "sessionId": row.get::<_, i64>(2)?,
                "observedAt": row.get::<_, Option<String>>(3)?,
            }))
        },
    )?;
    let intent_sources = collect_rows(
        connection,
        "SELECT repository_id,hex(source_key),adapter_version,hex(revision),locator,coverage,diagnostics_json FROM intent_sources ORDER BY repository_id",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "sourceKey": row.get::<_, String>(1)?.to_ascii_lowercase(),
                "adapterVersion": row.get::<_, String>(2)?, "revision": row.get::<_, String>(3)?.to_ascii_lowercase(),
                "locator": row.get::<_, String>(4)?, "coverage": row.get::<_, String>(5)?,
                "diagnostics": row.get::<_, String>(6)?,
            }))
        },
    )?;
    let intent_nodes = collect_rows(
        connection,
        "SELECT repository_id,hex(intent_key),node_id,CASE WHEN parent_intent_key IS NULL THEN NULL ELSE hex(parent_intent_key) END,kind,title,status,stable_id,hex(revision) FROM intent_nodes ORDER BY repository_id,intent_key",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "intentKey": row.get::<_, String>(1)?.to_ascii_lowercase(),
                "nodeId": row.get::<_, String>(2)?, "parentIntentKey": row.get::<_, Option<String>>(3)?.map(|value| value.to_ascii_lowercase()),
                "kind": row.get::<_, String>(4)?, "title": row.get::<_, String>(5)?, "status": row.get::<_, String>(6)?,
                "stableId": row.get::<_, i64>(7)?, "revision": row.get::<_, String>(8)?.to_ascii_lowercase(),
            }))
        },
    )?;
    let intent_refs = collect_rows(
        connection,
        "SELECT repository_id,node_id,ref_kind,ref_value,hex(revision) FROM intent_refs ORDER BY repository_id,node_id,ref_kind,ref_value",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "nodeId": row.get::<_, String>(1)?,
                "kind": row.get::<_, String>(2)?, "value": row.get::<_, String>(3)?,
                "revision": row.get::<_, String>(4)?.to_ascii_lowercase(),
            }))
        },
    )?;
    let intent_edges = collect_rows(
        connection,
        "SELECT repository_id,hex(edge_key),hex(from_key),to_kind,hex(to_key),relation,strength,source,facts_json,limitations_json,hex(revision) FROM intent_trace_edges ORDER BY repository_id,edge_key",
        |row| {
            Ok(serde_json::json!({
                "repositoryId": row.get::<_, String>(0)?, "edgeKey": row.get::<_, String>(1)?.to_ascii_lowercase(),
                "fromKey": row.get::<_, String>(2)?.to_ascii_lowercase(), "toKind": row.get::<_, String>(3)?,
                "toKey": row.get::<_, String>(4)?.to_ascii_lowercase(), "relation": row.get::<_, String>(5)?,
                "strength": row.get::<_, String>(6)?, "source": row.get::<_, String>(7)?,
                "facts": row.get::<_, String>(8)?, "limitations": row.get::<_, String>(9)?,
                "revision": row.get::<_, String>(10)?.to_ascii_lowercase(),
            }))
        },
    )?;
    let canonical = try_canonical_json(&serde_json::json!({
        "repositories": repositories,
        "refs": refs,
        "projectKeys": project_keys,
        "commits": commits,
        "files": files,
        "edges": edges,
        "observedCommits": observed_commits,
        "observedCommitPrefixes": observed_commit_prefixes,
        "intentSources": intent_sources,
        "intentNodes": intent_nodes,
        "intentRefs": intent_refs,
        "intentEdges": intent_edges,
    }))
    .map_err(|_| invalid("delivery graph digest is invalid"))?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}
