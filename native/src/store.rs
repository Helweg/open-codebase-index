use crate::{hasher::xxhash_file, SearchResult};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use usearch::{new_index, Index, IndexOptions, MetricKind, ScalarKind};
use xxhash_rust::xxh3::Xxh3;

// The usearch loader accepts trailing bytes. Embedding the metadata digest here
// makes the vector artifact carry the other half of the publication binding.
const METADATA_BINDING_PREFIX: &[u8] = b"\nOCBI_METADATA_XXH3:";
const METADATA_BINDING_SUFFIX: &[u8] = b"\n";

#[derive(Serialize, Deserialize, Default)]
struct StoredMetadata {
    id_to_key: HashMap<u64, String>,
    key_to_id: HashMap<String, u64>,
    metadata: HashMap<String, String>,
    next_id: u64,
    #[serde(default)]
    vector_fingerprint: Option<String>,
}

pub struct VectorStoreInner {
    index: Index,
    index_path: PathBuf,
    metadata_path: PathBuf,
    stored: StoredMetadata,
    dimensions: usize,
}

fn create_vector_index(dimensions: usize) -> Result<Index> {
    let options = IndexOptions {
        dimensions,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F16,
        connectivity: 16,
        expansion_add: 128,
        expansion_search: 64,
        multi: false,
    };
    Ok(new_index(&options)?)
}

impl VectorStoreInner {
    fn update_fingerprint_bytes(hasher: &mut Xxh3, value: &[u8]) {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value);
    }

    fn metadata_binding(stored: &StoredMetadata) -> String {
        let mut hasher = Xxh3::new();

        let mut id_to_key: Vec<_> = stored.id_to_key.iter().collect();
        id_to_key.sort_unstable_by_key(|(id, _)| **id);
        Self::update_fingerprint_bytes(&mut hasher, b"id_to_key");
        hasher.update(&(id_to_key.len() as u64).to_le_bytes());
        for (id, key) in id_to_key {
            hasher.update(&id.to_le_bytes());
            Self::update_fingerprint_bytes(&mut hasher, key.as_bytes());
        }

        let mut key_to_id: Vec<_> = stored.key_to_id.iter().collect();
        key_to_id.sort_unstable_by_key(|(key, _)| *key);
        Self::update_fingerprint_bytes(&mut hasher, b"key_to_id");
        hasher.update(&(key_to_id.len() as u64).to_le_bytes());
        for (key, id) in key_to_id {
            Self::update_fingerprint_bytes(&mut hasher, key.as_bytes());
            hasher.update(&id.to_le_bytes());
        }

        let mut metadata: Vec<_> = stored.metadata.iter().collect();
        metadata.sort_unstable_by_key(|(key, _)| *key);
        Self::update_fingerprint_bytes(&mut hasher, b"metadata");
        hasher.update(&(metadata.len() as u64).to_le_bytes());
        for (key, value) in metadata {
            Self::update_fingerprint_bytes(&mut hasher, key.as_bytes());
            Self::update_fingerprint_bytes(&mut hasher, value.as_bytes());
        }

        Self::update_fingerprint_bytes(&mut hasher, b"next_id");
        hasher.update(&stored.next_id.to_le_bytes());
        format!("{:016x}", hasher.digest())
    }

    fn append_metadata_binding(index_path: &Path, binding: &str) -> Result<()> {
        let mut index_file = fs::OpenOptions::new().append(true).open(index_path)?;
        index_file.write_all(METADATA_BINDING_PREFIX)?;
        index_file.write_all(binding.as_bytes())?;
        index_file.write_all(METADATA_BINDING_SUFFIX)?;
        Ok(())
    }

    fn verify_metadata_binding(index_path: &Path, stored: &StoredMetadata) -> Result<()> {
        let binding = Self::metadata_binding(stored);
        let expected = [
            METADATA_BINDING_PREFIX,
            binding.as_bytes(),
            METADATA_BINDING_SUFFIX,
        ]
        .concat();
        let mut index_file = fs::File::open(index_path)?;
        if index_file.metadata()?.len() < expected.len() as u64 {
            return Err(anyhow!(
                "Vector fingerprint mismatch: vectors and vectors.meta.json do not belong to the same publication"
            ));
        }
        index_file.seek(SeekFrom::End(-(expected.len() as i64)))?;
        let mut actual = vec![0; expected.len()];
        index_file.read_exact(&mut actual)?;
        if actual != expected {
            return Err(anyhow!(
                "Vector fingerprint mismatch: vectors and vectors.meta.json do not belong to the same publication"
            ));
        }
        Ok(())
    }

    pub fn new(index_path: PathBuf, dimensions: usize) -> Result<Self> {
        let index = create_vector_index(dimensions)?;

        let metadata_path = index_path.with_extension("meta.json");

        let store = Self {
            index,
            index_path,
            metadata_path,
            stored: StoredMetadata::default(),
            dimensions,
        };

        Ok(store)
    }

    pub fn add(&mut self, key: &str, vector: &[f32], metadata: &str) -> Result<()> {
        if vector.len() != self.dimensions {
            return Err(anyhow!(
                "Vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                vector.len()
            ));
        }

        if let Some(&existing_id) = self.stored.key_to_id.get(key) {
            self.index.remove(existing_id)?;
            self.stored.id_to_key.remove(&existing_id);
        }

        let id = self.stored.next_id;
        self.stored.next_id += 1;

        if self.index.capacity() <= self.index.size() {
            let new_capacity = std::cmp::max(self.index.capacity() * 2, 1024);
            self.index.reserve(new_capacity)?;
        }

        self.index.add(id, vector)?;

        self.stored.id_to_key.insert(id, key.to_string());
        self.stored.key_to_id.insert(key.to_string(), id);
        self.stored
            .metadata
            .insert(key.to_string(), metadata.to_string());

        Ok(())
    }

    pub fn add_batch(
        &mut self,
        keys: &[String],
        vectors: &[Vec<f32>],
        metadata: &[String],
    ) -> Result<()> {
        if keys.len() != vectors.len() || keys.len() != metadata.len() {
            return Err(anyhow!("Mismatched batch sizes"));
        }

        let batch_size = keys.len();
        if batch_size == 0 {
            return Ok(());
        }

        for (i, vector) in vectors.iter().enumerate() {
            if vector.len() != self.dimensions {
                return Err(anyhow!(
                    "Vector {} dimension mismatch: expected {}, got {}",
                    i,
                    self.dimensions,
                    vector.len()
                ));
            }
        }

        let existing_ids: Vec<u64> = keys
            .iter()
            .filter_map(|key| self.stored.key_to_id.get(key).copied())
            .collect();

        for id in existing_ids {
            self.index.remove(id)?;
            if let Some(key) = self.stored.id_to_key.remove(&id) {
                self.stored.key_to_id.remove(&key);
            }
        }

        let current_size = self.index.size();
        let needed_capacity = current_size + batch_size;
        if self.index.capacity() < needed_capacity {
            let new_capacity = std::cmp::max(self.index.capacity() * 2, needed_capacity);
            self.index.reserve(new_capacity)?;
        }

        let start_id = self.stored.next_id;
        let mut failure_count = 0usize;

        for (i, vector) in vectors.iter().enumerate() {
            let id = start_id + i as u64;
            if self.index.add(id, vector).is_err() {
                failure_count += 1;
            }
        }

        if failure_count > 0 {
            return Err(anyhow!("Failed to add {} vectors to index", failure_count));
        }

        for (i, key) in keys.iter().enumerate() {
            let id = start_id + i as u64;
            self.stored.id_to_key.insert(id, key.clone());
            self.stored.key_to_id.insert(key.clone(), id);
            self.stored
                .metadata
                .insert(key.clone(), metadata[i].clone());
        }
        self.stored.next_id = start_id + batch_size as u64;

        Ok(())
    }

    pub fn search(&self, query_vector: &[f32], limit: usize) -> Result<Vec<SearchResult>> {
        if query_vector.len() != self.dimensions {
            return Err(anyhow!(
                "Query vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                query_vector.len()
            ));
        }

        let results = self.index.search(query_vector, limit)?;

        let mut search_results = Vec::with_capacity(results.keys.len());

        for (i, &id) in results.keys.iter().enumerate() {
            if let Some(key) = self.stored.id_to_key.get(&id) {
                let metadata = self.stored.metadata.get(key).cloned().unwrap_or_default();

                let score = 1.0 - results.distances[i] as f64;

                search_results.push(SearchResult {
                    id: key.clone(),
                    score,
                    metadata,
                });
            }
        }

        Ok(search_results)
    }

    pub fn remove(&mut self, key: &str) -> Result<bool> {
        if let Some(&id) = self.stored.key_to_id.get(key) {
            self.index.remove(id)?;
            self.stored.id_to_key.remove(&id);
            self.stored.key_to_id.remove(key);
            self.stored.metadata.remove(key);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn save(&mut self) -> Result<()> {
        self.validate_structure()?;
        self.stored.vector_fingerprint = None;

        if let Some(parent) = self.index_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let index_path_str = self
            .index_path
            .to_str()
            .ok_or_else(|| anyhow!("Index path contains invalid UTF-8: {:?}", self.index_path))?;
        self.index.save(index_path_str)?;
        let metadata_binding = Self::metadata_binding(&self.stored);
        Self::append_metadata_binding(&self.index_path, &metadata_binding)?;
        let fingerprint = xxhash_file(index_path_str)?;

        self.stored.vector_fingerprint = Some(fingerprint);
        let publication = (|| -> Result<()> {
            let metadata_json = serde_json::to_string(&self.stored)?;
            fs::write(&self.metadata_path, metadata_json)?;
            Ok(())
        })();
        if let Err(error) = publication {
            self.stored.vector_fingerprint = None;
            return Err(error);
        }

        Ok(())
    }

    pub fn load(&mut self) -> Result<()> {
        self.load_with_fingerprint_requirement(false)
    }

    pub fn load_strict(&mut self) -> Result<()> {
        self.load_with_fingerprint_requirement(true)
    }

    fn load_with_fingerprint_requirement(&mut self, require_fingerprint: bool) -> Result<()> {
        let index_exists = self.index_path.exists();
        let metadata_exists = self.metadata_path.exists();
        if index_exists != metadata_exists {
            return Err(anyhow!(
                "Incomplete vector publication: vectors and vectors.meta.json must both exist"
            ));
        }
        if !index_exists {
            if require_fingerprint {
                return Err(anyhow!(
                    "Missing vector fingerprint: a leased writer must publish this legacy vector pair before readers can load it"
                ));
            }
            self.index = create_vector_index(self.dimensions)?;
            self.stored = StoredMetadata::default();
            return Ok(());
        }

        let metadata_json = Some(fs::read_to_string(&self.metadata_path)?);
        let stored: StoredMetadata = metadata_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();

        // Structural validation cannot prove that an unfingerprinted legacy pair is
        // semantically matched. A leased writer may only establish a new baseline,
        // while readers require an existing fingerprint.
        if stored.vector_fingerprint.is_none() && require_fingerprint {
            return Err(anyhow!(
                "Missing vector fingerprint: a leased writer must publish this legacy vector pair before readers can load it"
            ));
        }

        let index_path_str = self
            .index_path
            .to_str()
            .ok_or_else(|| anyhow!("Index path contains invalid UTF-8: {:?}", self.index_path))?;
        let vector_fingerprint_before = xxhash_file(index_path_str)?;
        if let Some(expected) = stored.vector_fingerprint.as_deref() {
            Self::verify_metadata_binding(&self.index_path, &stored)?;
            if vector_fingerprint_before != expected {
                return Err(anyhow!(
                    "Vector fingerprint mismatch: vectors and vectors.meta.json do not belong to the same publication"
                ));
            }
        }

        let index = create_vector_index(self.dimensions)?;
        index.load(index_path_str)?;

        let vector_fingerprint_after = xxhash_file(index_path_str)?;
        if vector_fingerprint_before != vector_fingerprint_after {
            return Err(anyhow!(
                "Vector publication changed while it was being loaded; retry after the active writer finishes"
            ));
        }
        if let Some(metadata_before) = metadata_json.as_deref() {
            let metadata_after = fs::read_to_string(&self.metadata_path)?;
            if metadata_after != metadata_before {
                return Err(anyhow!(
                    "Vector metadata changed while it was being loaded; retry after the active writer finishes"
                ));
            }
        }

        Self::validate_structure_parts(&index, &stored)?;
        self.index = index;
        self.stored = stored;

        Ok(())
    }

    fn validate_structure(&self) -> Result<()> {
        Self::validate_structure_parts(&self.index, &self.stored)
    }

    fn validate_structure_parts(index: &Index, stored: &StoredMetadata) -> Result<()> {
        let vector_count = index.size();
        let id_count = stored.id_to_key.len();
        let key_count = stored.key_to_id.len();
        let metadata_count = stored.metadata.len();
        if vector_count != id_count || id_count != key_count || key_count != metadata_count {
            return Err(anyhow!(
                "Vector store structure mismatch: vectors={}, ids={}, keys={}, metadata={}",
                vector_count,
                id_count,
                key_count,
                metadata_count
            ));
        }

        for (&id, key) in &stored.id_to_key {
            if stored.key_to_id.get(key) != Some(&id) {
                return Err(anyhow!(
                    "Vector store structure mismatch: key '{}' does not map back to ID {}",
                    key,
                    id
                ));
            }
            if !index.contains(id) {
                return Err(anyhow!(
                    "Vector store structure mismatch: vector ID {} is missing from the index",
                    id
                ));
            }
            if !stored.metadata.contains_key(key) {
                return Err(anyhow!(
                    "Vector store structure mismatch: metadata is missing for key '{}'",
                    key
                ));
            }
        }

        if let Some(max_id) = stored.id_to_key.keys().max() {
            if stored.next_id <= *max_id {
                return Err(anyhow!(
                    "Vector store structure mismatch: next ID {} is not greater than persisted ID {}",
                    stored.next_id,
                    max_id
                ));
            }
        }

        Ok(())
    }

    pub fn has_fingerprint(&self) -> bool {
        self.stored.vector_fingerprint.is_some()
    }

    pub fn count(&self) -> usize {
        self.stored.key_to_id.len()
    }

    pub fn clear(&mut self) -> Result<()> {
        self.index = create_vector_index(self.dimensions)?;
        self.stored = StoredMetadata::default();

        if self.index_path.exists() {
            fs::remove_file(&self.index_path)?;
        }
        if self.metadata_path.exists() {
            fs::remove_file(&self.metadata_path)?;
        }

        Ok(())
    }

    pub fn get_all_keys(&self) -> Vec<String> {
        self.stored.key_to_id.keys().cloned().collect()
    }

    pub fn get_all_metadata(&self) -> Vec<(String, String)> {
        self.stored
            .metadata
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Get metadata for a single key. O(1) lookup.
    pub fn get_metadata(&self, key: &str) -> Option<String> {
        self.stored.metadata.get(key).cloned()
    }

    /// Get metadata for multiple keys. More efficient than calling get_metadata in a loop
    /// when you need metadata for many specific keys (avoids cloning unused entries).
    pub fn get_metadata_batch(&self, keys: &[String]) -> Vec<(String, String)> {
        keys.iter()
            .filter_map(|k| self.stored.metadata.get(k).map(|v| (k.clone(), v.clone())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_vector_store_basic() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();

        store
            .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store
            .add("vec2", &[0.0, 1.0, 0.0], r#"{"file": "b.ts"}"#)
            .unwrap();
        store
            .add("vec3", &[0.0, 0.0, 1.0], r#"{"file": "c.ts"}"#)
            .unwrap();

        assert_eq!(store.count(), 3);

        let results = store.search(&[1.0, 0.0, 0.0], 2).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "vec1");
    }

    #[test]
    fn test_vector_store_persistence() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        {
            let mut store = VectorStoreInner::new(index_path.clone(), 3).unwrap();
            store
                .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
                .unwrap();
            store.save().unwrap();
        }

        {
            let mut store = VectorStoreInner::new(index_path, 3).unwrap();
            store.load().unwrap();
            assert_eq!(store.count(), 1);
        }
    }
}
