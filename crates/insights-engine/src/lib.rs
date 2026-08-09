use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use unicode_normalization::UnicodeNormalization;

pub fn hash_key(domain: &str, parts: &[Vec<u8>]) -> String {
    assert!(
        !domain.is_empty() && domain.bytes().all(|byte| (0x20..=0x7e).contains(&byte)),
        "hash domain must be printable ASCII"
    );
    let mut hash = Sha256::new();
    hash.update(format!("threadshare:{domain}:v1").as_bytes());
    hash.update([0]);
    for part in parts {
        let length = u32::try_from(part.len()).expect("hash part exceeds uint32 length");
        hash.update(length.to_be_bytes());
        hash.update(part);
    }
    hex::encode(hash.finalize())
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
            let is_safe_integer = value
                .as_i64()
                .is_some_and(|number| number.unsigned_abs() <= MAX_SAFE_INTEGER)
                || value
                    .as_u64()
                    .is_some_and(|number| number <= MAX_SAFE_INTEGER);
            assert!(is_safe_integer, "canonical JSON only permits safe integers");
            value.to_string()
        }
        Value::String(value) => serde_json::to_string(&value.nfc().collect::<String>()).unwrap(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values
                .iter()
                .map(|(key, value)| (key.nfc().collect::<String>(), value))
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| compare_utf16(&left.0, &right.0));
            for pair in entries.windows(2) {
                assert_ne!(
                    pair[0].0, pair[1].0,
                    "canonical JSON keys collide after NFC"
                );
            }
            let body = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(&key).unwrap(),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::{canonical_json, hash_key};
    use serde::Deserialize;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use unicode_normalization::UnicodeNormalization;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        version: u8,
        hash_vectors: Vec<HashVector>,
        canonical_vectors: Vec<CanonicalVector>,
        #[serde(default)]
        canonical_reject_vectors: Vec<CanonicalRejectVector>,
        #[serde(default)]
        well_formed_unicode_vectors: Vec<WellFormedUnicodeVector>,
        #[serde(default)]
        digest_vectors: Vec<DigestVector>,
    }

    #[derive(Deserialize)]
    struct HashVector {
        name: String,
        domain: String,
        parts: Vec<Part>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct Part {
        encoding: String,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        parts: Vec<Part>,
    }

    #[derive(Deserialize)]
    struct CanonicalVector {
        name: String,
        value: Value,
        expected: String,
    }

    #[derive(Deserialize)]
    struct CanonicalRejectVector {
        name: String,
        value: Value,
    }

    #[derive(Deserialize)]
    struct WellFormedUnicodeVector {
        name: String,
        utf16: Vec<u16>,
        expected: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DigestVector {
        name: String,
        value: Value,
        expected_canonical: String,
        expected_sha256: String,
    }

    fn decode_part(part: Part) -> Vec<u8> {
        let Part {
            encoding,
            value,
            parts,
        } = part;
        let value = || value.as_deref().expect("golden part requires value");
        match encoding.as_str() {
            "utf8" => value().as_bytes().to_vec(),
            "nfcUtf8" => value().nfc().collect::<String>().into_bytes(),
            "hex" => hex::decode(value()).unwrap(),
            "u64be" => value().parse::<u64>().unwrap().to_be_bytes().to_vec(),
            "i32be" => value().parse::<i32>().unwrap().to_be_bytes().to_vec(),
            "u16be" => value().parse::<u16>().unwrap().to_be_bytes().to_vec(),
            "u8" => vec![value().parse::<u8>().unwrap()],
            "concat" => parts.into_iter().flat_map(decode_part).collect(),
            other => panic!("unsupported golden part encoding: {other}"),
        }
    }

    #[test]
    fn matches_shared_session_facts_v1_vectors() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../test/fixtures/session-facts-golden.v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);
        for vector in fixture.hash_vectors {
            let parts = vector
                .parts
                .into_iter()
                .map(decode_part)
                .collect::<Vec<_>>();
            assert_eq!(
                hash_key(&vector.domain, &parts),
                vector.expected,
                "{}",
                vector.name
            );
        }
        for vector in fixture.canonical_vectors {
            assert_eq!(
                canonical_json(&vector.value),
                vector.expected,
                "{}",
                vector.name
            );
        }
        for vector in fixture.canonical_reject_vectors {
            assert!(
                std::panic::catch_unwind(|| canonical_json(&vector.value)).is_err(),
                "{}",
                vector.name
            );
        }
        for vector in fixture.well_formed_unicode_vectors {
            assert_eq!(
                String::from_utf16_lossy(&vector.utf16),
                vector.expected,
                "{}",
                vector.name
            );
        }
        for vector in fixture.digest_vectors {
            let canonical = canonical_json(&vector.value);
            assert_eq!(canonical, vector.expected_canonical, "{}", vector.name);
            assert_eq!(
                hex::encode(Sha256::digest(canonical.as_bytes())),
                vector.expected_sha256,
                "{}",
                vector.name
            );
        }
    }
}
