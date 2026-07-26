use anyhow::Result;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use xxhash_rust::xxh3::{xxh3_64, Xxh3};

pub fn xxhash_content(content: &str) -> String {
    format!("{:016x}", xxh3_64(content.as_bytes()))
}

pub fn xxhash_file(file_path: &str) -> Result<String> {
    let file = fs::File::open(Path::new(file_path))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Xxh3::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:016x}", hasher.digest()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_content() {
        let hash1 = xxhash_content("hello world");
        let hash2 = xxhash_content("hello world");
        let hash3 = xxhash_content("different content");

        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
        assert_eq!(hash1.len(), 16);
    }
}
