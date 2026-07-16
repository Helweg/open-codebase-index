use crate::CodeChunk;

pub const MIN_CHUNK_SIZE: usize = 50;
pub const MAX_CHUNK_SIZE: usize = 2000;
pub const TARGET_CHUNK_SIZE: usize = 500;

pub fn create_embedding_text(chunk: &CodeChunk) -> String {
    let mut text = String::with_capacity(chunk.content.len() + 100);

    if let Some(ref name) = chunk.name {
        text.push_str(&format!("{} {} ", chunk.chunk_type, name));
    }

    text.push_str(&chunk.content);

    text
}

pub fn estimate_tokens(text: &str) -> usize {
    text.len() / 4
}

pub fn estimate_chunks_tokens(chunks: &[CodeChunk]) -> usize {
    chunks
        .iter()
        .map(|c| estimate_tokens(&create_embedding_text(c)))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_text() {
        let chunk = CodeChunk {
            content: "function greet() { return 'hello'; }".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 1,
            end_col: 36,
            chunk_type: "function_declaration".to_string(),
            name: Some("greet".to_string()),
            language: "typescript".to_string(),
        };

        let text = create_embedding_text(&chunk);
        assert!(text.contains("function_declaration"));
        assert!(text.contains("greet"));
        assert!(text.contains("function greet()"));
    }

    #[test]
    fn test_token_estimation() {
        let text = "This is a test string for token estimation";
        let tokens = estimate_tokens(text);
        assert!(tokens > 0);
        assert!(tokens < text.len());
    }
}
