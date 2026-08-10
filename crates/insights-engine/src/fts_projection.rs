use rusqlite::{
    Connection, OptionalExtension, Transaction, params, params_from_iter, types::Value,
};

pub const DF_PARAMETER_TIERS: [usize; 4] = [8, 32, 128, 256];
pub const REQUIRED_DF_SEEK_INDEX: u16 = 263;
pub const MAX_FTS_CANDIDATES: usize = 300;

pub const FTS_TABLE: &str = "turns_fts";
const FTS_VOCAB_TABLE: &str = "turns_fts_vocab";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FtsField {
    Natural,
    Code,
    Capability,
}

impl FtsField {
    pub const ALL: [Self; 3] = [Self::Natural, Self::Code, Self::Capability];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Natural => "natural",
            Self::Code => "code",
            Self::Capability => "capability",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FtsDocument<'a> {
    pub turn_id: i64,
    pub natural: &'a str,
    pub code: &'a str,
    pub capability: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bm25Weights {
    pub natural: f64,
    pub code: f64,
    pub capability: f64,
}

impl Default for Bm25Weights {
    fn default() -> Self {
        Self {
            natural: 8.0,
            code: 4.0,
            capability: 2.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub turn_id: i64,
    pub bm25: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentFrequency {
    pub term: String,
    pub document_count: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct FieldPresence {
    natural: bool,
    code: bool,
    capability: bool,
}

impl FieldPresence {
    fn from_document(document: &FtsDocument<'_>) -> Self {
        Self {
            natural: has_analyzed_token(document.natural),
            code: has_analyzed_token(document.code),
            capability: has_analyzed_token(document.capability),
        }
    }

    fn get(self, field: FtsField) -> bool {
        match field {
            FtsField::Natural => self.natural,
            FtsField::Code => self.code,
            FtsField::Capability => self.capability,
        }
    }
}

fn has_analyzed_token(value: &str) -> bool {
    value.split_ascii_whitespace().next().is_some()
}

pub fn initialize_fts_projection_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS turn_fts_documents (
           turn_id INTEGER PRIMARY KEY CHECK(turn_id > 0),
           natural_present INTEGER NOT NULL CHECK(natural_present IN (0, 1)),
           code_present INTEGER NOT NULL CHECK(code_present IN (0, 1)),
           capability_present INTEGER NOT NULL CHECK(capability_present IN (0, 1))
         );
         CREATE TABLE IF NOT EXISTS field_stats (
           field TEXT PRIMARY KEY CHECK(field IN ('natural', 'code', 'capability')),
           fts_doc_count INTEGER NOT NULL CHECK(fts_doc_count >= 0)
         ) WITHOUT ROWID;
         INSERT OR IGNORE INTO field_stats(field, fts_doc_count) VALUES
           ('natural', 0), ('code', 0), ('capability', 0);
         CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
           natural,
           code,
           capability,
           content='',
           contentless_delete=1,
           columnsize=1,
           detail=full
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts_vocab USING
           fts5vocab(turns_fts, 'col');",
    )?;
    connection.execute(
        "INSERT INTO turns_fts(turns_fts, rank) VALUES('automerge', 4)",
        [],
    )?;
    connection.execute(
        "INSERT INTO turns_fts(turns_fts, rank) VALUES('deletemerge', 10)",
        [],
    )?;
    Ok(())
}

pub fn upsert_fts_document(
    transaction: &Transaction<'_>,
    document: &FtsDocument<'_>,
) -> rusqlite::Result<()> {
    let previous = read_presence(transaction, document.turn_id)?;
    if previous.is_some() {
        transaction.execute(
            "DELETE FROM turns_fts WHERE rowid=?1",
            params![document.turn_id],
        )?;
    }

    transaction.execute(
        "INSERT INTO turns_fts(rowid, natural, code, capability)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            document.turn_id,
            document.natural,
            document.code,
            document.capability
        ],
    )?;

    let current = FieldPresence::from_document(document);
    transaction.execute(
        "INSERT INTO turn_fts_documents(
           turn_id, natural_present, code_present, capability_present
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(turn_id) DO UPDATE SET
           natural_present=excluded.natural_present,
           code_present=excluded.code_present,
           capability_present=excluded.capability_present",
        params![
            document.turn_id,
            current.natural,
            current.code,
            current.capability
        ],
    )?;
    update_field_stats(transaction, previous.unwrap_or_default(), current)
}

pub fn delete_fts_document(transaction: &Transaction<'_>, turn_id: i64) -> rusqlite::Result<bool> {
    let Some(previous) = read_presence(transaction, turn_id)? else {
        return Ok(false);
    };
    transaction.execute("DELETE FROM turns_fts WHERE rowid=?1", params![turn_id])?;
    transaction.execute(
        "DELETE FROM turn_fts_documents WHERE turn_id=?1",
        params![turn_id],
    )?;
    update_field_stats(transaction, previous, FieldPresence::default())?;
    Ok(true)
}

fn read_presence(connection: &Connection, turn_id: i64) -> rusqlite::Result<Option<FieldPresence>> {
    connection
        .query_row(
            "SELECT natural_present, code_present, capability_present
             FROM turn_fts_documents WHERE turn_id=?1",
            params![turn_id],
            |row| {
                Ok(FieldPresence {
                    natural: row.get(0)?,
                    code: row.get(1)?,
                    capability: row.get(2)?,
                })
            },
        )
        .optional()
}

fn update_field_stats(
    transaction: &Transaction<'_>,
    previous: FieldPresence,
    current: FieldPresence,
) -> rusqlite::Result<()> {
    for field in FtsField::ALL {
        let delta = i64::from(current.get(field)) - i64::from(previous.get(field));
        if delta != 0 {
            let updated = transaction.execute(
                "UPDATE field_stats
                 SET fts_doc_count=fts_doc_count+?1
                 WHERE field=?2",
                params![delta, field.as_str()],
            )?;
            if updated != 1 {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
    }
    Ok(())
}

pub fn search_fts(
    connection: &Connection,
    match_expression: &str,
    weights: Bm25Weights,
    limit: usize,
) -> rusqlite::Result<Vec<SearchHit>> {
    if !(1..=MAX_FTS_CANDIDATES).contains(&limit) {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "FTS candidate limit must be in 1..={MAX_FTS_CANDIDATES}"
        )));
    }
    let limit =
        i64::try_from(limit).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(4, i64::MAX))?;
    let mut statement = connection.prepare(
        "SELECT rowid, bm25(turns_fts, ?1, ?2, ?3)
         FROM turns_fts
         WHERE turns_fts MATCH ?4
         ORDER BY 2 ASC, rowid ASC
         LIMIT ?5",
    )?;
    statement
        .query_map(
            params![
                weights.natural,
                weights.code,
                weights.capability,
                match_expression,
                limit
            ],
            |row| {
                Ok(SearchHit {
                    turn_id: row.get(0)?,
                    bm25: row.get(1)?,
                })
            },
        )?
        .collect()
}

pub fn df_parameter_tier(term_count: usize) -> Option<usize> {
    DF_PARAMETER_TIERS
        .into_iter()
        .find(|tier| term_count <= *tier)
}

pub fn lookup_field_document_frequencies(
    connection: &Connection,
    field: FtsField,
    terms: &[String],
) -> rusqlite::Result<Vec<DocumentFrequency>> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let tier = df_parameter_tier(terms.len()).ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!(
            "document-frequency lookup accepts at most {} terms",
            DF_PARAMETER_TIERS[DF_PARAMETER_TIERS.len() - 1]
        ))
    })?;
    let sql = df_lookup_sql(tier, false);
    let parameters = df_lookup_parameters(terms, tier, field);
    let mut statement = connection.prepare_cached(&sql)?;
    statement
        .query_map(params_from_iter(parameters), |row| {
            let document_count = row.get::<_, i64>(1)?;
            let document_count = u64::try_from(document_count)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(1, document_count))?;
            Ok(DocumentFrequency {
                term: row.get(0)?,
                document_count,
            })
        })?
        .collect()
}

pub fn explain_df_lookup_plan(
    connection: &Connection,
    parameter_count: usize,
) -> rusqlite::Result<Vec<String>> {
    if !DF_PARAMETER_TIERS.contains(&parameter_count) {
        return Err(rusqlite::Error::InvalidParameterName(
            "df plan must use an exact prepared-statement tier".to_owned(),
        ));
    }
    let terms = vec!["threadshare-plan-probe".to_owned(); parameter_count];
    let parameters = df_lookup_parameters(&terms, parameter_count, FtsField::Natural);
    let mut statement = connection.prepare(&df_lookup_sql(parameter_count, true))?;
    statement
        .query_map(params_from_iter(parameters), |row| row.get(3))?
        .collect()
}

pub fn fts5_virtual_table_index(detail: &str) -> Option<u16> {
    let value = detail.split_once("VIRTUAL TABLE INDEX ")?.1;
    let digits = value
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

fn df_lookup_sql(parameter_count: usize, explain: bool) -> String {
    let placeholders = std::iter::repeat_n("?", parameter_count)
        .collect::<Vec<_>>()
        .join(",");
    let explain = if explain { "EXPLAIN QUERY PLAN " } else { "" };
    format!(
        "{explain}SELECT term, doc FROM {FTS_VOCAB_TABLE}
         WHERE term IN ({placeholders}) AND col=?
         ORDER BY term"
    )
}

fn df_lookup_parameters(terms: &[String], tier: usize, field: FtsField) -> Vec<Value> {
    let mut parameters = terms.iter().cloned().map(Value::Text).collect::<Vec<_>>();
    parameters.resize(tier, Value::Null);
    parameters.push(Value::Text(field.as_str().to_owned()));
    parameters
}

#[cfg(test)]
mod tests {
    use super::{
        Bm25Weights, DF_PARAMETER_TIERS, FtsDocument, FtsField, REQUIRED_DF_SEEK_INDEX,
        delete_fts_document, explain_df_lookup_plan, fts5_virtual_table_index,
        initialize_fts_projection_schema, lookup_field_document_frequencies, search_fts,
        upsert_fts_document,
    };
    use rusqlite::{Connection, params};

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;")
            .unwrap();
        initialize_fts_projection_schema(&connection).unwrap();
        connection
    }

    fn insert_documents(connection: &mut Connection, documents: &[FtsDocument<'_>]) {
        let transaction = connection.transaction().unwrap();
        for document in documents {
            upsert_fts_document(&transaction, document).unwrap();
        }
        transaction.commit().unwrap();
    }

    fn matching_count(connection: &Connection, query: &str) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM turns_fts WHERE turns_fts MATCH ?1",
                params![query],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn detail_full_bm25_is_nonzero_and_column_weights_reorder_results() {
        let mut connection = connection();
        insert_documents(
            &mut connection,
            &[
                FtsDocument {
                    turn_id: 1,
                    natural: "alpha alpha alpha",
                    code: "none",
                    capability: "none",
                },
                FtsDocument {
                    turn_id: 2,
                    natural: "none",
                    code: "alpha alpha alpha",
                    capability: "none",
                },
                FtsDocument {
                    turn_id: 3,
                    natural: "none",
                    code: "none",
                    capability: "alpha alpha alpha",
                },
            ],
        );

        let natural_weighted = search_fts(&connection, "alpha", Bm25Weights::default(), 3).unwrap();
        let capability_weighted = search_fts(
            &connection,
            "alpha",
            Bm25Weights {
                natural: 2.0,
                code: 4.0,
                capability: 8.0,
            },
            3,
        )
        .unwrap();

        assert!(natural_weighted.iter().all(|hit| hit.bm25.is_finite()));
        assert!(natural_weighted.iter().all(|hit| hit.bm25 != 0.0));
        assert!(
            natural_weighted
                .windows(2)
                .any(|pair| pair[0].bm25 != pair[1].bm25)
        );
        assert_eq!(natural_weighted[0].turn_id, 1);
        assert_eq!(capability_weighted[0].turn_id, 3);
    }

    #[test]
    fn delete_removes_the_live_fts_row_and_field_stats() {
        let mut connection = connection();
        insert_documents(
            &mut connection,
            &[FtsDocument {
                turn_id: 7,
                natural: "retiredtoken",
                code: "",
                capability: "shelltool",
            }],
        );
        assert_eq!(matching_count(&connection, "retiredtoken"), 1);

        let transaction = connection.transaction().unwrap();
        assert!(delete_fts_document(&transaction, 7).unwrap());
        transaction.commit().unwrap();

        assert_eq!(matching_count(&connection, "retiredtoken"), 0);
        let stats = FtsField::ALL.map(|field| {
            connection
                .query_row(
                    "SELECT fts_doc_count FROM field_stats WHERE field=?1",
                    params![field.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        });
        assert_eq!(stats, [0, 0, 0]);
        connection
            .execute(
                "INSERT INTO turns_fts(turns_fts) VALUES('integrity-check')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn field_stats_track_presence_across_replacement() {
        let mut connection = connection();
        insert_documents(
            &mut connection,
            &[FtsDocument {
                turn_id: 11,
                natural: "alpha",
                code: "",
                capability: "shelltool",
            }],
        );
        insert_documents(
            &mut connection,
            &[FtsDocument {
                turn_id: 11,
                natural: "",
                code: "identifier_token",
                capability: "shelltool",
            }],
        );

        let stats = FtsField::ALL.map(|field| {
            connection
                .query_row(
                    "SELECT fts_doc_count FROM field_stats WHERE field=?1",
                    params![field.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        });
        assert_eq!(stats, [0, 1, 1]);
        assert_eq!(matching_count(&connection, "alpha"), 0);
        assert_eq!(matching_count(&connection, "identifier_token"), 1);
    }

    #[test]
    fn every_parameterized_df_tier_uses_the_required_term_seek_plan() {
        let connection = connection();
        for tier in DF_PARAMETER_TIERS {
            let details = explain_df_lookup_plan(&connection, tier).unwrap();
            let indexes = details
                .iter()
                .filter_map(|detail| fts5_virtual_table_index(detail))
                .collect::<Vec<_>>();
            assert_eq!(
                indexes,
                vec![REQUIRED_DF_SEEK_INDEX],
                "unexpected {tier}-parameter plan: {details:?}"
            );
        }
    }

    #[test]
    fn df_lookup_returns_per_field_counts_without_a_vocab_scan() {
        let mut connection = connection();
        insert_documents(
            &mut connection,
            &[
                FtsDocument {
                    turn_id: 1,
                    natural: "alpha beta",
                    code: "",
                    capability: "",
                },
                FtsDocument {
                    turn_id: 2,
                    natural: "alpha",
                    code: "beta",
                    capability: "",
                },
            ],
        );
        let frequencies = lookup_field_document_frequencies(
            &connection,
            FtsField::Natural,
            &["alpha".to_owned(), "beta".to_owned()],
        )
        .unwrap();
        assert_eq!(
            frequencies,
            vec![
                super::DocumentFrequency {
                    term: "alpha".to_owned(),
                    document_count: 2,
                },
                super::DocumentFrequency {
                    term: "beta".to_owned(),
                    document_count: 1,
                },
            ]
        );
    }

    #[test]
    fn temp_table_join_is_detected_as_the_forbidden_full_vocab_scan() {
        let connection = connection();
        connection
            .execute_batch(
                "CREATE TEMP TABLE query_terms(term TEXT PRIMARY KEY) WITHOUT ROWID;
                 INSERT INTO query_terms(term) VALUES ('alpha'), ('beta');",
            )
            .unwrap();
        let mut statement = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT vocab.doc
                 FROM turns_fts_vocab AS vocab
                 JOIN query_terms AS terms ON terms.term=vocab.term
                 WHERE vocab.col=?1",
            )
            .unwrap();
        let details = statement
            .query_map(params![FtsField::Natural.as_str()], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let indexes = details
            .iter()
            .filter_map(|detail| fts5_virtual_table_index(detail))
            .collect::<Vec<_>>();

        assert!(!indexes.contains(&REQUIRED_DF_SEEK_INDEX));
        assert!(indexes.iter().any(|index| matches!(index, 3 | 7)));
    }

    #[test]
    fn schema_locks_contentless_delete_detail_full_and_column_sizes() {
        let connection = connection();
        let sql = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?1",
                params![super::FTS_TABLE],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(sql.contains("content=''"));
        assert!(sql.contains("contentless_delete=1"));
        assert!(sql.contains("detail=full"));
        assert!(sql.contains("columnsize=1"));
    }

    #[test]
    fn assistant_answer_and_excerpt_are_not_fts_fields() {
        let connection = connection();
        let columns = connection
            .prepare("PRAGMA table_info(turns_fts)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(columns, ["natural", "code", "capability"]);

        for forbidden_column in ["answer", "excerpt"] {
            let query = format!("{forbidden_column}:privateanswer");
            assert!(search_fts(&connection, &query, Bm25Weights::default(), 10).is_err());
        }
    }

    #[test]
    fn schema_initialization_is_idempotent() {
        let connection = connection();
        initialize_fts_projection_schema(&connection).unwrap();
        let fields: i64 = connection
            .query_row("SELECT COUNT(*) FROM field_stats", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fields, 3);
    }
}
