use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::ops::Range;
use unicode_normalization::UnicodeNormalization;

pub const ANALYZER_VERSION: &str = "threadshare-fixed-v1";
pub const ANALYZER_CAPABILITY: &str = "mixed-cjk-code@1";
pub const SEARCH_PROJECTION_NAME: &str = "turn-search";
pub const SEARCH_PROJECTION_VERSION: u32 = 2;
pub const PULLDOWN_CMARK_VERSION: &str = "0.13.4";
pub const UNICODE_NORMALIZATION_VERSION: &str = "0.1.25";
pub const CODEC_VERSION: &str = "threadshare-term-v1";

const DOCUMENT_TOKEN_HEAD: usize = 6_144;
const DOCUMENT_TOKEN_TAIL: usize = 2_048;
const DOCUMENT_DISTINCT_HEAD: usize = 3_072;
const DOCUMENT_DISTINCT_TAIL: usize = 1_024;
const CAPABILITY_HEAD: usize = 192;
const CAPABILITY_TAIL: usize = 64;
const QUERY_HEAD: usize = 192;
const QUERY_TAIL: usize = 64;
const QUERY_MAX_BYTES: usize = 8 * 1_024;
const MAX_LOGICAL_TERM_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerIdentity {
    pub analyzer_version: &'static str,
    pub analyzer_capability: &'static str,
    pub search_projection_name: &'static str,
    pub search_projection_version: u32,
    pub pulldown_cmark_version: &'static str,
    pub unicode_normalization_version: &'static str,
    pub unicode_normalization_unicode_version: String,
    pub rust_unicode_version: String,
    pub codec_version: &'static str,
}

pub fn analyzer_identity() -> AnalyzerIdentity {
    let (major, minor, patch) = std::char::UNICODE_VERSION;
    let (normalization_major, normalization_minor, normalization_patch) =
        unicode_normalization::UNICODE_VERSION;
    AnalyzerIdentity {
        analyzer_version: ANALYZER_VERSION,
        analyzer_capability: ANALYZER_CAPABILITY,
        search_projection_name: SEARCH_PROJECTION_NAME,
        search_projection_version: SEARCH_PROJECTION_VERSION,
        pulldown_cmark_version: PULLDOWN_CMARK_VERSION,
        unicode_normalization_version: UNICODE_NORMALIZATION_VERSION,
        unicode_normalization_unicode_version: format!(
            "{normalization_major}.{normalization_minor}.{normalization_patch}"
        ),
        rust_unicode_version: format!("{major}.{minor}.{patch}"),
        codec_version: CODEC_VERSION,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalyzerField {
    Natural,
    Code,
    Capability,
}

impl AnalyzerField {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Natural => "natural",
            Self::Code => "code",
            Self::Capability => "capability",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTerm {
    pub field: AnalyzerField,
    pub logical: String,
    pub encoded: String,
    pub source_offset: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedField {
    pub terms: Vec<QueryTerm>,
    pub fts_text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerDiagnostics {
    pub input_token_count: usize,
    pub token_count: usize,
    pub input_distinct_field_term_count: usize,
    pub distinct_field_term_count: usize,
    pub capability_input_count: usize,
    pub capability_token_count: usize,
    pub token_truncated: bool,
    pub distinct_truncated: bool,
    pub capability_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedDocument {
    pub identity: AnalyzerIdentity,
    pub natural: AnalyzedField,
    pub code: AnalyzedField,
    pub capability: AnalyzedField,
    pub diagnostics: AnalyzerDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalyzerOriginScope {
    Main,
    Subagent,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub struct CapabilityInput<'a> {
    pub origin_scope: AnalyzerOriginScope,
    pub turn_ordinal: u64,
    pub capability_key: &'a [u8],
    pub canonical_name: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedQuery {
    pub identity: AnalyzerIdentity,
    pub terms: Vec<QueryTerm>,
    pub input_distinct_field_term_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalyzerError {
    QueryTooLong,
    QueryTooBroad,
}

#[derive(Debug, Clone)]
struct Occurrence {
    logical: String,
    offset: usize,
    ordinal: usize,
}

pub fn encode_term(logical: &str) -> String {
    if logical.len() > MAX_LOGICAL_TERM_BYTES {
        return format!("h{}", hex::encode(Sha256::digest(logical.as_bytes())));
    }
    let mut encoded = String::with_capacity(1 + logical.len().div_ceil(5) * 8);
    encoded.push('t');
    encode_base32(logical.as_bytes(), &mut encoded);
    encoded
}

pub fn is_encoded_term(value: &str) -> bool {
    let Some((prefix, body)) = value.split_at_checked(1) else {
        return false;
    };
    match prefix {
        "t" => {
            !body.is_empty()
                && body
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b'2'..=b'7'))
        }
        "h" => {
            body.len() == 64
                && body
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        }
        _ => false,
    }
}

pub fn analyze_document(markdown: &str, capabilities: &[CapabilityInput<'_>]) -> AnalyzedDocument {
    let mut natural = natural_occurrences(markdown);
    let mut code = code_occurrences(markdown);
    let input_token_count = natural.len() + code.len();

    let distinct_streams = [distinct_occurrences(&natural), distinct_occurrences(&code)];
    let input_distinct_field_term_count = distinct_streams[0].len() + distinct_streams[1].len();
    let distinct_selection = select_head_tail(
        &[distinct_streams[0].len(), distinct_streams[1].len()],
        DOCUMENT_DISTINCT_HEAD,
        DOCUMENT_DISTINCT_TAIL,
    );
    let mut allowed = BTreeSet::new();
    for (field, occurrences) in distinct_streams.iter().enumerate() {
        for (index, occurrence) in occurrences.iter().enumerate() {
            if distinct_selection[field][index] {
                allowed.insert((field, occurrence.logical.clone()));
            }
        }
    }
    natural.retain(|occurrence| allowed.contains(&(0, occurrence.logical.clone())));
    code.retain(|occurrence| allowed.contains(&(1, occurrence.logical.clone())));

    let token_selection = select_head_tail(
        &[natural.len(), code.len()],
        DOCUMENT_TOKEN_HEAD,
        DOCUMENT_TOKEN_TAIL,
    );
    natural = retain_selected(natural, &token_selection[0]);
    code = retain_selected(code, &token_selection[1]);

    let (capability, capability_input_count, capability_truncated) =
        capability_occurrences(capabilities);
    let token_count = natural.len() + code.len();
    let distinct_field_term_count = natural
        .iter()
        .map(|occurrence| (0, occurrence.logical.as_str()))
        .chain(
            code.iter()
                .map(|occurrence| (1, occurrence.logical.as_str())),
        )
        .collect::<BTreeSet<_>>()
        .len();
    let capability_token_count = capability.len();
    AnalyzedDocument {
        identity: analyzer_identity(),
        natural: analyzed_field(AnalyzerField::Natural, natural),
        code: analyzed_field(AnalyzerField::Code, code),
        capability: analyzed_field(AnalyzerField::Capability, capability),
        diagnostics: AnalyzerDiagnostics {
            input_token_count,
            token_count,
            input_distinct_field_term_count,
            distinct_field_term_count,
            capability_input_count,
            capability_token_count,
            token_truncated: input_token_count > DOCUMENT_TOKEN_HEAD + DOCUMENT_TOKEN_TAIL,
            distinct_truncated: input_distinct_field_term_count
                > DOCUMENT_DISTINCT_HEAD + DOCUMENT_DISTINCT_TAIL,
            capability_truncated,
        },
    }
}

pub fn analyze_query(query: &str) -> Result<AnalyzedQuery, AnalyzerError> {
    if query.len() > QUERY_MAX_BYTES {
        return Err(AnalyzerError::QueryTooLong);
    }
    if searchable_character_count(query) < 2 {
        return Err(AnalyzerError::QueryTooBroad);
    }

    let natural = distinct_occurrences(&natural_occurrences(query));
    let code = distinct_occurrences(&code_occurrences(query));
    let mut merged = natural
        .iter()
        .chain(code.iter())
        .cloned()
        .collect::<Vec<_>>();
    merged.sort_by_key(|occurrence| (occurrence.offset, occurrence.ordinal));
    let capability = distinct_occurrences(&merged);
    let streams = [natural, code, capability];
    let input_distinct_field_term_count = streams.iter().map(Vec::len).sum();
    let selection = select_head_tail(
        &streams.iter().map(Vec::len).collect::<Vec<_>>(),
        QUERY_HEAD,
        QUERY_TAIL,
    );
    let fields = [
        AnalyzerField::Natural,
        AnalyzerField::Code,
        AnalyzerField::Capability,
    ];
    let mut terms = Vec::new();
    for (field_index, occurrences) in streams.iter().enumerate() {
        for (index, occurrence) in occurrences.iter().enumerate() {
            if selection[field_index][index] {
                terms.push(QueryTerm {
                    field: fields[field_index],
                    logical: occurrence.logical.clone(),
                    encoded: encode_term(&occurrence.logical),
                    source_offset: occurrence.offset,
                });
            }
        }
    }
    terms.sort_by(|left, right| {
        (left.source_offset, left.field, left.logical.as_str()).cmp(&(
            right.source_offset,
            right.field,
            right.logical.as_str(),
        ))
    });
    Ok(AnalyzedQuery {
        identity: analyzer_identity(),
        terms,
        input_distinct_field_term_count,
        truncated: input_distinct_field_term_count > QUERY_HEAD + QUERY_TAIL,
    })
}

fn analyzed_field(field: AnalyzerField, occurrences: Vec<Occurrence>) -> AnalyzedField {
    let terms = occurrences
        .into_iter()
        .map(|occurrence| QueryTerm {
            field,
            encoded: encode_term(&occurrence.logical),
            logical: occurrence.logical,
            source_offset: occurrence.offset,
        })
        .collect::<Vec<_>>();
    let fts_text = terms
        .iter()
        .map(|term| term.encoded.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    AnalyzedField { terms, fts_text }
}

fn natural_occurrences(input: &str) -> Vec<Occurrence> {
    let normalized = stable_lower_nfkc(input);
    let characters = normalized.char_indices().collect::<Vec<_>>();
    let mut occurrences = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let (offset, character) = characters[index];
        if is_cjk(character) {
            let start = index;
            while index < characters.len() && is_cjk(characters[index].1) {
                index += 1;
            }
            let run = &characters[start..index];
            for gram_start in 0..run.len() {
                for gram_length in [2, 3] {
                    if gram_start + gram_length <= run.len() {
                        occurrences.push(Occurrence {
                            logical: run[gram_start..gram_start + gram_length]
                                .iter()
                                .map(|(_, value)| value)
                                .collect(),
                            offset: run[gram_start].0,
                            ordinal: occurrences.len(),
                        });
                    }
                }
            }
            continue;
        }
        if is_latin_or_number(character) {
            let start = offset;
            index += 1;
            while index < characters.len() && is_latin_or_number(characters[index].1) {
                index += 1;
            }
            let end = characters
                .get(index)
                .map_or(normalized.len(), |(offset, _)| *offset);
            occurrences.push(Occurrence {
                logical: normalized[start..end].to_owned(),
                offset: start,
                ordinal: occurrences.len(),
            });
            continue;
        }
        index += 1;
    }
    occurrences
}

fn code_occurrences(markdown: &str) -> Vec<Occurrence> {
    let mut occurrences = Vec::new();
    let mut code_ranges = Vec::<Range<usize>>::new();
    let mut code_block_depth = 0_u32;
    for (event, range) in Parser::new(markdown).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => code_block_depth += 1,
            Event::End(TagEnd::CodeBlock) => code_block_depth -= 1,
            Event::Code(value) => {
                code_ranges.push(range.clone());
                push_ascii_identifiers(&value, range.start, &mut occurrences);
            }
            Event::Text(value) if code_block_depth > 0 => {
                code_ranges.push(range.clone());
                push_ascii_identifiers(&value, range.start, &mut occurrences);
            }
            _ => {}
        }
    }

    let bytes = markdown.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !is_code_shape_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_code_shape_byte(bytes[index]) {
            index += 1;
        }
        if code_ranges
            .iter()
            .any(|range| start < range.end && index > range.start)
        {
            continue;
        }
        let candidate = &markdown[start..index];
        if has_strong_code_shape(candidate) {
            push_code_shape(candidate, start, &mut occurrences);
        }
    }
    occurrences.sort_by_key(|occurrence| (occurrence.offset, occurrence.ordinal));
    for (ordinal, occurrence) in occurrences.iter_mut().enumerate() {
        occurrence.ordinal = ordinal;
    }
    occurrences
}

fn capability_occurrences(capabilities: &[CapabilityInput<'_>]) -> (Vec<Occurrence>, usize, bool) {
    let mut eligible = capabilities
        .iter()
        .filter(|capability| capability.origin_scope == AnalyzerOriginScope::Main)
        .filter_map(|capability| {
            let canonical_name = capability.canonical_name?.trim();
            (!canonical_name.is_empty()).then_some((capability, canonical_name))
        })
        .collect::<Vec<_>>();
    eligible.sort_by(|(left, _), (right, _)| {
        left.turn_ordinal
            .cmp(&right.turn_ordinal)
            .then_with(|| left.capability_key.cmp(right.capability_key))
    });
    let capability_input_count = eligible.len();
    let mut occurrences = Vec::new();
    let mut seen_names = HashSet::new();
    for (index, (_, canonical_name)) in eligible.into_iter().enumerate() {
        if !seen_names.insert(canonical_name.to_owned()) {
            continue;
        }
        push_code_shape(canonical_name, index, &mut occurrences);
    }
    let selection = select_head_tail(&[occurrences.len()], CAPABILITY_HEAD, CAPABILITY_TAIL);
    let truncated = occurrences.len() > CAPABILITY_HEAD + CAPABILITY_TAIL;
    (
        retain_selected(occurrences, &selection[0]),
        capability_input_count,
        truncated,
    )
}

fn push_ascii_identifiers(value: &str, base_offset: usize, output: &mut Vec<Occurrence>) {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !(bytes[index].is_ascii_alphabetic() || bytes[index] == b'_') {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
        {
            index += 1;
        }
        push_code_shape(&value[start..index], base_offset + start, output);
    }
}

fn push_code_shape(value: &str, offset: usize, output: &mut Vec<Occurrence>) {
    let mut logical_terms = Vec::new();
    let full = stable_lower_nfkc(value);
    if !full.is_empty() && full.chars().any(|character| character.is_alphanumeric()) {
        logical_terms.push(full);
    }
    for separated in value.split(|character: char| {
        matches!(character, '.' | '/' | '\\' | '_' | '-' | ':' | '#' | '@')
    }) {
        for part in split_camel(separated) {
            let part = stable_lower_nfkc(part);
            if !part.is_empty() && part.chars().any(|character| character.is_alphanumeric()) {
                logical_terms.push(part);
            }
        }
    }
    let mut seen = HashSet::new();
    for logical in logical_terms {
        if seen.insert(logical.clone()) {
            output.push(Occurrence {
                logical,
                offset,
                ordinal: output.len(),
            });
        }
    }
}

fn split_camel(value: &str) -> Vec<&str> {
    if value.is_empty() {
        return Vec::new();
    }
    let characters = value.char_indices().collect::<Vec<_>>();
    let mut boundaries = vec![0];
    for index in 1..characters.len() {
        let previous = characters[index - 1].1;
        let current = characters[index].1;
        let next = characters.get(index + 1).map(|(_, value)| *value);
        if (previous.is_lowercase() && current.is_uppercase())
            || (previous.is_uppercase()
                && current.is_uppercase()
                && next.is_some_and(char::is_lowercase))
        {
            boundaries.push(characters[index].0);
        }
    }
    boundaries.push(value.len());
    boundaries
        .windows(2)
        .map(|range| &value[range[0]..range[1]])
        .filter(|part| !part.is_empty())
        .collect()
}

fn distinct_occurrences(occurrences: &[Occurrence]) -> Vec<Occurrence> {
    let mut seen = HashSet::new();
    occurrences
        .iter()
        .filter(|occurrence| seen.insert(occurrence.logical.clone()))
        .cloned()
        .collect()
}

fn select_head_tail(lengths: &[usize], head: usize, tail: usize) -> Vec<Vec<bool>> {
    let mut selected = lengths
        .iter()
        .map(|length| vec![false; *length])
        .collect::<Vec<_>>();
    if lengths.iter().sum::<usize>() <= head + tail {
        for field in &mut selected {
            field.fill(true);
        }
        return selected;
    }

    let mut fronts = vec![0; lengths.len()];
    let mut head_remaining = head;
    while head_remaining > 0 {
        let mut progressed = false;
        for field in 0..lengths.len() {
            if fronts[field] < lengths[field] {
                selected[field][fronts[field]] = true;
                fronts[field] += 1;
                head_remaining -= 1;
                progressed = true;
                if head_remaining == 0 {
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }

    let mut backs = lengths.to_vec();
    let mut tail_remaining = tail;
    while tail_remaining > 0 {
        let mut progressed = false;
        for field in 0..lengths.len() {
            if backs[field] > fronts[field] {
                backs[field] -= 1;
                selected[field][backs[field]] = true;
                tail_remaining -= 1;
                progressed = true;
                if tail_remaining == 0 {
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    selected
}

fn retain_selected(values: Vec<Occurrence>, selected: &[bool]) -> Vec<Occurrence> {
    values
        .into_iter()
        .zip(selected)
        .filter_map(|(value, selected)| selected.then_some(value))
        .collect()
}

fn stable_lower_nfkc(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
}

fn searchable_character_count(value: &str) -> usize {
    stable_lower_nfkc(value)
        .chars()
        .filter(|character| is_latin_or_number(*character) || is_cjk(*character))
        .take(2)
        .count()
}

fn is_latin_or_number(value: char) -> bool {
    value.is_numeric()
        || matches!(
            value as u32,
            0x0041..=0x005a
                | 0x0061..=0x007a
                | 0x00c0..=0x024f
                | 0x1d00..=0x1d7f
                | 0x1d80..=0x1dbf
                | 0x1e00..=0x1eff
                | 0x2c60..=0x2c7f
                | 0xa720..=0xa7ff
                | 0xab30..=0xab6f
        )
}

fn is_cjk(value: char) -> bool {
    matches!(
        value as u32,
        0x2e80..=0x2fff
            | 0x3040..=0x30ff
            | 0x3100..=0x312f
            | 0x31a0..=0x31bf
            | 0x31f0..=0x31ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xac00..=0xd7af
            | 0xf900..=0xfaff
            | 0x20000..=0x2fa1f
    )
}

fn is_code_shape_byte(value: u8) -> bool {
    value.is_ascii_alphanumeric()
        || matches!(
            value,
            b'.' | b'/' | b'\\' | b'_' | b'-' | b':' | b'#' | b'@'
        )
}

fn has_strong_code_shape(value: &str) -> bool {
    value.bytes().any(|byte| byte.is_ascii_digit())
        || value
            .bytes()
            .any(|byte| matches!(byte, b'.' | b'/' | b'\\' | b'_' | b'-' | b':' | b'#' | b'@'))
        || (value.starts_with('-') && value.len() > 1)
        || value
            .as_bytes()
            .windows(2)
            .any(|pair| pair[0].is_ascii_lowercase() && pair[1].is_ascii_uppercase())
        || value.as_bytes().windows(3).any(|window| {
            window[0].is_ascii_uppercase()
                && window[1].is_ascii_uppercase()
                && window[2].is_ascii_lowercase()
        })
}

fn encode_base32(bytes: &[u8], output: &mut String) {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((accumulator >> bits) & 0x1f) as usize;
            output.push(char::from(ALPHABET[index]));
        }
    }
    if bits > 0 {
        let index = ((accumulator << (5 - bits)) & 0x1f) as usize;
        output.push(char::from(ALPHABET[index]));
    }
}
