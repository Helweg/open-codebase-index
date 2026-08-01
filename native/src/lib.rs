#![deny(clippy::all)]

mod bindings;
mod call_extractor;
mod chunker;
mod community;
mod db;
mod hasher;
mod inverted_index;
mod parser;
mod store;
mod types;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;

pub use bindings::database::*;
pub use chunker::*;
pub use hasher::*;
pub use inverted_index::*;
pub use parser::*;
pub use store::*;
pub use types::*;

#[napi]
pub fn parse_file(file_path: String, content: String) -> Result<Vec<CodeChunk>> {
    parser::parse_file_internal(&file_path, &content).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_file_as_text(file_path: String, content: String) -> Result<Vec<CodeChunk>> {
    parser::parse_file_as_text_internal(&file_path, &content)
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_files(files: Vec<FileInput>) -> Result<Vec<ParsedFile>> {
    parser::parse_files_parallel(files).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn hash_content(content: String) -> String {
    hasher::xxhash_content(&content)
}

#[napi]
pub fn hash_file(file_path: String) -> Result<String> {
    hasher::xxhash_file(&file_path).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn extract_calls(content: String, language: String) -> Result<Vec<CallSiteData>> {
    call_extractor::extract_calls(&content, &language)
        .map(|sites| {
            sites
                .into_iter()
                .map(|s| CallSiteData {
                    callee_name: s.callee_name,
                    line: s.line,
                    column: s.column,
                    call_type: format!("{:?}", s.call_type),
                    confidence: format!("{:?}", s.confidence),
                })
                .collect()
        })
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub struct VectorStore {
    inner: store::VectorStoreInner,
}

#[napi]
impl VectorStore {
    #[napi(constructor)]
    pub fn new(index_path: String, dimensions: u32) -> Result<Self> {
        let inner = store::VectorStoreInner::new(PathBuf::from(index_path), dimensions as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self { inner })
    }

    #[napi]
    pub fn add(&mut self, id: String, vector: Vec<f64>, metadata: String) -> Result<()> {
        let vector_f32: Vec<f32> = vector.iter().map(|&x| x as f32).collect();
        self.inner
            .add(&id, &vector_f32, &metadata)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_batch(
        &mut self,
        ids: Vec<String>,
        vectors: Vec<Vec<f64>>,
        metadata: Vec<String>,
    ) -> Result<()> {
        let vectors_f32: Vec<Vec<f32>> = vectors
            .iter()
            .map(|v| v.iter().map(|&x| x as f32).collect())
            .collect();
        self.inner
            .add_batch(&ids, &vectors_f32, &metadata)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn search(&self, query_vector: Vec<f64>, limit: u32) -> Result<Vec<SearchResult>> {
        let query_f32: Vec<f32> = query_vector.iter().map(|&x| x as f32).collect();
        self.inner
            .search(&query_f32, limit as usize)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn remove(&mut self, id: String) -> Result<bool> {
        self.inner
            .remove(&id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save(&mut self) -> Result<()> {
        self.inner
            .save()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn load(&mut self) -> Result<()> {
        self.inner
            .load()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn load_strict(&mut self) -> Result<()> {
        self.inner
            .load_strict()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn has_fingerprint(&self) -> bool {
        self.inner.has_fingerprint()
    }

    #[napi]
    pub fn count(&self) -> u32 {
        self.inner.count() as u32
    }

    #[napi]
    pub fn clear(&mut self) -> Result<()> {
        self.inner
            .clear()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_all_keys(&self) -> Vec<String> {
        self.inner.get_all_keys()
    }

    #[napi]
    pub fn get_all_metadata(&self) -> Vec<KeyMetadataPair> {
        self.inner
            .get_all_metadata()
            .into_iter()
            .map(|(key, metadata)| KeyMetadataPair { key, metadata })
            .collect()
    }

    #[napi]
    pub fn get_metadata(&self, id: String) -> Option<String> {
        self.inner.get_metadata(&id)
    }

    #[napi]
    pub fn get_metadata_batch(&self, ids: Vec<String>) -> Vec<KeyMetadataPair> {
        self.inner
            .get_metadata_batch(&ids)
            .into_iter()
            .map(|(key, metadata)| KeyMetadataPair { key, metadata })
            .collect()
    }
}

#[napi(object)]
pub struct FileInput {
    pub path: String,
    pub content: String,
}

#[napi(object)]
pub struct ParsedFile {
    pub path: String,
    pub chunks: Vec<CodeChunk>,
    pub symbols: Vec<ParsedSymbol>,
    pub hash: String,
}

#[napi(object)]
pub struct ParsedSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub language: String,
}

#[napi(object)]
pub struct CodeChunk {
    pub content: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub chunk_type: String,
    pub name: Option<String>,
    pub language: String,
}

#[napi(object)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
    pub metadata: String,
}

#[napi(object)]
pub struct KeyMetadataPair {
    pub key: String,
    pub metadata: String,
}

#[napi(object)]
pub struct CallSiteData {
    pub callee_name: String,
    pub line: u32,
    pub column: u32,
    pub call_type: String,
    pub confidence: String,
}

#[napi(object)]
pub struct SymbolData {
    pub id: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub language: String,
}

#[napi(object)]
pub struct CallEdgeData {
    pub id: String,
    pub from_symbol_id: String,
    pub from_symbol_name: Option<String>,
    pub from_symbol_file_path: Option<String>,
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub confidence: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

#[napi(object)]
pub struct PathHopData {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub line: u32,
    pub call_type: String,
}

#[napi(object)]
pub struct ReachabilityData {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub depth: u32,
}

#[napi(object)]
pub struct CommunityData {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub community_id: u32,
    pub community_label: String,
    pub cross_community_connections: u32,
}

#[napi(object)]
pub struct CentralityData {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub caller_count: u32,
    pub callee_count: u32,
    pub total_connections: u32,
}

#[napi(object)]
pub struct KeywordSearchResult {
    pub chunk_id: String,
    pub score: f64,
}

#[napi]
pub struct InvertedIndex {
    inner: inverted_index::InvertedIndexInner,
}

#[napi]
impl InvertedIndex {
    #[napi(constructor)]
    pub fn new(index_path: String) -> Self {
        let inner = inverted_index::InvertedIndexInner::new(PathBuf::from(index_path));
        Self { inner }
    }

    #[napi]
    pub fn load(&mut self) -> Result<()> {
        self.inner
            .load()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save(&self) -> Result<()> {
        self.inner
            .save()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_chunk(&mut self, chunk_id: String, content: String) {
        self.inner.add_chunk(&chunk_id, &content);
    }

    #[napi]
    pub fn remove_chunk(&mut self, chunk_id: String) -> bool {
        self.inner.remove_chunk(&chunk_id)
    }

    #[napi]
    pub fn search(&self, query: String, limit: Option<u32>) -> Vec<KeywordSearchResult> {
        let results = self.inner.search(&query);
        let limit = limit.unwrap_or(100) as usize;
        results
            .into_iter()
            .take(limit)
            .map(|(chunk_id, score)| KeywordSearchResult { chunk_id, score })
            .collect()
    }

    #[napi]
    pub fn has_chunk(&self, chunk_id: String) -> bool {
        self.inner.has_chunk(&chunk_id)
    }

    #[napi]
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    #[napi]
    pub fn document_count(&self) -> u32 {
        self.inner.document_count() as u32
    }

    #[napi]
    pub fn serialize(&self) -> Result<String> {
        self.inner
            .serialize()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn deserialize(&mut self, json: String) -> Result<()> {
        self.inner
            .deserialize(&json)
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}
