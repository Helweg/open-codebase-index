use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

const TOKENIZER_VERSION: u32 = 1;

#[derive(Debug)]
pub struct UnsupportedTokenizerVersionError(u32);

impl std::fmt::Display for UnsupportedTokenizerVersionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Keyword index uses an unsupported tokenizer version ({}, supported: {})",
            self.0, TOKENIZER_VERSION
        )
    }
}

impl std::error::Error for UnsupportedTokenizerVersionError {}

fn validate_tokenizer_version(version: u32) -> Result<()> {
    if version > TOKENIZER_VERSION {
        return Err(UnsupportedTokenizerVersionError(version).into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct InvertedIndexVersion {
    #[serde(default)]
    tokenizer_version: u32,
}

#[derive(Serialize, Deserialize, Default)]
struct InvertedIndexData {
    term_to_chunks: HashMap<String, Vec<String>>,
    chunk_tokens: HashMap<String, HashMap<String, u32>>,
    avg_doc_length: f64,
    #[serde(default)]
    tokenizer_version: u32,
    #[serde(default)]
    legacy_chunks: HashSet<String>,
}

#[derive(Serialize)]
struct InvertedIndexSnapshot<'a> {
    term_to_chunks: &'a HashMap<String, HashSet<String>>,
    chunk_tokens: &'a HashMap<String, HashMap<String, u32>>,
    avg_doc_length: f64,
    tokenizer_version: u32,
    legacy_chunks: &'a HashSet<String>,
}

pub struct InvertedIndexInner {
    index_path: PathBuf,
    term_to_chunks: HashMap<String, HashSet<String>>,
    chunk_tokens: HashMap<String, HashMap<String, u32>>,
    total_token_count: u64,
    legacy_chunks: HashSet<String>,
}

impl InvertedIndexInner {
    pub fn new(index_path: PathBuf) -> Self {
        Self {
            index_path,
            term_to_chunks: HashMap::new(),
            chunk_tokens: HashMap::new(),
            total_token_count: 0,
            legacy_chunks: HashSet::new(),
        }
    }

    pub fn load(&mut self) -> Result<()> {
        if !self.index_path.exists() {
            return Ok(());
        }

        let content = fs::read_to_string(&self.index_path)?;
        self.restore(serde_json::from_str(&content)?)
    }

    pub fn validate_snapshot_version(&self) -> Result<()> {
        if !self.index_path.exists() {
            return Ok(());
        }
        let reader = BufReader::new(fs::File::open(&self.index_path)?);
        let version: InvertedIndexVersion = serde_json::from_reader(reader)?;
        validate_tokenizer_version(version.tokenizer_version)
    }

    pub fn save(&self) -> Result<()> {
        self.save_to(&self.index_path)
    }

    pub fn save_to(&self, destination: &Path) -> Result<()> {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut writer = BufWriter::new(fs::File::create(destination)?);
        serde_json::to_writer(&mut writer, &self.snapshot())?;
        // BufWriter's drop ignores errors; publication must observe flush failures.
        writer.flush()?;
        Ok(())
    }

    pub fn serialize(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.snapshot())?)
    }

    fn snapshot(&self) -> InvertedIndexSnapshot<'_> {
        InvertedIndexSnapshot {
            term_to_chunks: &self.term_to_chunks,
            chunk_tokens: &self.chunk_tokens,
            avg_doc_length: self.get_avg_doc_length(),
            tokenizer_version: TOKENIZER_VERSION,
            legacy_chunks: &self.legacy_chunks,
        }
    }

    pub fn deserialize(&mut self, json: &str) -> Result<()> {
        self.restore(serde_json::from_str(json)?)
    }

    fn restore(&mut self, data: InvertedIndexData) -> Result<()> {
        validate_tokenizer_version(data.tokenizer_version)?;
        let legacy_chunks = if data.tokenizer_version < TOKENIZER_VERSION {
            data.chunk_tokens.keys().cloned().collect()
        } else {
            data.legacy_chunks
        };
        self.term_to_chunks.clear();
        for (term, chunk_ids) in data.term_to_chunks {
            self.term_to_chunks
                .insert(term, chunk_ids.into_iter().collect());
        }
        self.total_token_count = data
            .chunk_tokens
            .values()
            .flat_map(|tokens| tokens.values())
            .map(|count| *count as u64)
            .sum();
        self.chunk_tokens = data.chunk_tokens;
        self.legacy_chunks = legacy_chunks;
        Ok(())
    }

    pub fn has_current_tokenizer(&self, chunk_ids: Option<&[String]>) -> bool {
        if self.legacy_chunks.is_empty() {
            return true;
        }
        match chunk_ids {
            Some(ids) => ids.iter().all(|id| !self.legacy_chunks.contains(id)),
            None => false,
        }
    }

    pub fn outdated_tokenizer_chunk_ids(&self, chunk_ids: Option<&[String]>) -> Vec<String> {
        let mut ids: Vec<String> = match chunk_ids {
            Some(ids) => ids
                .iter()
                .filter(|id| self.legacy_chunks.contains(*id))
                .cloned()
                .collect(),
            None => self.legacy_chunks.iter().cloned().collect(),
        };
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    pub fn add_chunk(&mut self, chunk_id: &str, content: &str) {
        let tokens = self.tokenize(content);
        let token_count = tokens.len() as u64;
        let mut term_freq: HashMap<String, u32> = HashMap::new();
        for token in tokens {
            *term_freq.entry(token).or_insert(0) += 1;
        }
        for token in term_freq.keys() {
            if let Some(chunks) = self.term_to_chunks.get_mut(token) {
                chunks.insert(chunk_id.to_string());
            } else {
                self.term_to_chunks
                    .insert(token.clone(), HashSet::from([chunk_id.to_string()]));
            }
        }
        self.legacy_chunks.remove(chunk_id);
        self.chunk_tokens.insert(chunk_id.to_string(), term_freq);
        self.total_token_count += token_count;
    }

    pub fn remove_chunk(&mut self, chunk_id: &str) -> bool {
        let tokens = match self.chunk_tokens.remove(chunk_id) {
            Some(t) => t,
            None => return false,
        };
        self.legacy_chunks.remove(chunk_id);

        for (token, count) in &tokens {
            self.total_token_count = self.total_token_count.saturating_sub(*count as u64);

            if let Some(chunks) = self.term_to_chunks.get_mut(token) {
                chunks.remove(chunk_id);
                if chunks.is_empty() {
                    self.term_to_chunks.remove(token);
                }
            }
        }

        true
    }

    pub fn search(&self, query: &str) -> Vec<(String, f64)> {
        let query_tokens: Vec<String> = Self::words(query).map(str::to_lowercase).collect();
        if query_tokens.is_empty() {
            return Vec::new();
        }

        let mut candidate_chunks: HashSet<String> = HashSet::new();
        for token in &query_tokens {
            if let Some(chunks) = self.term_to_chunks.get(token) {
                for chunk_id in chunks {
                    candidate_chunks.insert(chunk_id.clone());
                }
            }
        }

        let k1: f64 = 1.2;
        let b: f64 = 0.75;
        let n = self.chunk_tokens.len() as f64;
        let avg_doc_length = self.get_avg_doc_length();

        let mut scores: Vec<(String, f64)> = Vec::new();

        for chunk_id in candidate_chunks {
            let term_freq = match self.chunk_tokens.get(&chunk_id) {
                Some(tf) => tf,
                None => continue,
            };

            let doc_length: u32 = term_freq.values().sum();
            let mut score: f64 = 0.0;

            for term in &query_tokens {
                let tf = *term_freq.get(term).unwrap_or(&0) as f64;
                if tf == 0.0 {
                    continue;
                }

                let df = self.term_to_chunks.get(term).map(|s| s.len()).unwrap_or(0) as f64;
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();

                let tf_norm = (tf * (k1 + 1.0))
                    / (tf + k1 * (1.0 - b + b * (doc_length as f64 / avg_doc_length)));
                score += idf * tf_norm;
            }

            if score > 0.0 {
                scores.push((chunk_id, score));
            }
        }

        let max_score = scores.iter().map(|(_, s)| *s).fold(1.0_f64, f64::max);
        for (_, score) in &mut scores {
            *score /= max_score;
        }

        scores.sort_unstable_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        scores
    }

    pub fn has_chunk(&self, chunk_id: &str) -> bool {
        self.chunk_tokens.contains_key(chunk_id)
    }

    pub fn clear(&mut self) {
        self.term_to_chunks.clear();
        self.chunk_tokens.clear();
        self.total_token_count = 0;
        self.legacy_chunks.clear();
    }

    pub fn document_count(&self) -> usize {
        self.chunk_tokens.len()
    }

    fn get_avg_doc_length(&self) -> f64 {
        let count = self.chunk_tokens.len();
        if count > 0 {
            self.total_token_count as f64 / count as f64
        } else {
            100.0
        }
    }

    fn words(text: &str) -> impl Iterator<Item = &str> {
        text.split(|character: char| !character.is_alphanumeric())
            .filter(|word| word.len() > 2)
    }

    fn tokenize(&self, text: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        for word in Self::words(text) {
            tokens.push(word.to_lowercase());
            let mut start = 0;
            let mut previous: Option<char> = None;
            let mut characters = word.char_indices().peekable();
            while let Some((offset, character)) = characters.next() {
                let boundary = offset > 0
                    && character.is_uppercase()
                    && previous.is_some_and(|previous| {
                        previous.is_lowercase()
                            || previous.is_numeric()
                            || (previous.is_uppercase()
                                && characters
                                    .peek()
                                    .is_some_and(|(_, next)| next.is_lowercase()))
                    });
                if boundary {
                    let part = &word[start..offset];
                    if part.len() > 2 {
                        tokens.push(part.to_lowercase());
                    }
                    start = offset;
                }
                previous = Some(character);
            }
            if start > 0 {
                let part = &word[start..];
                if part.len() > 2 {
                    tokens.push(part.to_lowercase());
                }
            }
        }
        tokens
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_inverted_index_basic() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);

        index.add_chunk("chunk1", "function handleError throws exception");
        index.add_chunk("chunk2", "class UserController handles requests");
        index.add_chunk("chunk3", "error logging and debugging");

        assert_eq!(index.document_count(), 3);

        let results = index.search("error handling");
        assert!(!results.is_empty());

        let chunk_ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
        assert!(chunk_ids.contains(&"chunk1") || chunk_ids.contains(&"chunk3"));
    }

    #[test]
    fn test_inverted_index_remove() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);

        index.add_chunk("chunk1", "function handleError");
        index.add_chunk("chunk2", "class UserController");

        assert_eq!(index.document_count(), 2);

        index.remove_chunk("chunk1");
        assert_eq!(index.document_count(), 1);
        assert!(!index.has_chunk("chunk1"));
        assert!(index.has_chunk("chunk2"));
    }

    #[test]
    fn test_inverted_index_persistence() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        {
            let mut index = InvertedIndexInner::new(index_path.clone());
            index.add_chunk("chunk1", "function handleError throws exception");
            index.save().unwrap();
        }

        {
            let mut index = InvertedIndexInner::new(index_path);
            index.load().unwrap();
            assert_eq!(index.document_count(), 1);
            assert!(index.has_chunk("chunk1"));
        }
    }
}
