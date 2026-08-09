use crate::types::Language;
use crate::{CodeChunk, FileInput, ParsedFile, ParsedSymbol};
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
#[cfg(debug_assertions)]
use std::time::Instant;
use tree_sitter::{Parser, Tree};

const MIN_CHUNK_SIZE: usize = 50;
const MAX_CHUNK_SIZE: usize = 2000;
const TARGET_CHUNK_SIZE: usize = 500;
const OVERLAP_LINES: usize = 3;

pub fn parse_file_internal(file_path: &str, content: &str) -> Result<Vec<CodeChunk>> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let language = Language::from_extension(ext);

    if language == Language::Text {
        return Ok(chunk_by_lines(content, &language));
    }

    let mut parser = Parser::new();

    let ts_language = match language {
        Language::TypeScript | Language::TypeScriptTsx => {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        }
        Language::JavaScript | Language::JavaScriptJsx => tree_sitter_javascript::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Swift => tree_sitter_swift::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::Json => tree_sitter_json::LANGUAGE.into(),
        Language::Java => tree_sitter_java::LANGUAGE.into(),
        Language::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
        Language::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        Language::Bash => tree_sitter_bash::LANGUAGE.into(),
        Language::C => tree_sitter_c::LANGUAGE.into(),
        Language::Cpp => tree_sitter_cpp::LANGUAGE.into(),
        Language::Metal => tree_sitter_cpp::LANGUAGE.into(),
        Language::Toml => tree_sitter_toml_ng::LANGUAGE.into(),
        Language::Yaml => tree_sitter_yaml::LANGUAGE.into(),
        Language::Php => tree_sitter_php::LANGUAGE_PHP.into(),
        Language::Zig => tree_sitter_zig::LANGUAGE.into(),
        Language::Gdscript => tree_sitter_gdscript::LANGUAGE.into(),
        Language::Matlab => tree_sitter_matlab::LANGUAGE.into(),
        Language::Apex => tree_sitter_sfapex::apex::LANGUAGE.into(),
        _ => return Ok(chunk_by_lines(content, &language)),
    };

    parser.set_language(&ts_language)?;

    let tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Failed to parse file: {}", file_path))?;

    extract_chunks(&tree, content, &language)
}

pub fn parse_file_as_text_internal(file_path: &str, content: &str) -> Result<Vec<CodeChunk>> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let language = Language::from_extension(ext);
    Ok(chunk_by_lines(content, &language))
}

pub fn parse_files_parallel(files: Vec<FileInput>) -> Result<Vec<ParsedFile>> {
    let results: Vec<ParsedFile> = files
        .par_iter()
        .filter_map(|file| {
            let (chunks, symbols) =
                parse_file_with_symbols_internal(&file.path, &file.content).ok()?;
            let hash = crate::hasher::xxhash_content(&file.content);
            Some(ParsedFile {
                path: file.path.clone(),
                chunks,
                symbols,
                hash,
            })
        })
        .collect();

    Ok(results)
}

fn parse_file_with_symbols_internal(
    file_path: &str,
    content: &str,
) -> Result<(Vec<CodeChunk>, Vec<ParsedSymbol>)> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    let language = Language::from_extension(ext);

    if language == Language::Text {
        return Ok((chunk_by_lines(content, &language), Vec::new()));
    }

    let mut parser = Parser::new();
    let ts_language = match language {
        Language::TypeScript | Language::TypeScriptTsx => {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        }
        Language::JavaScript | Language::JavaScriptJsx => tree_sitter_javascript::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Swift => tree_sitter_swift::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::Json => tree_sitter_json::LANGUAGE.into(),
        Language::Java => tree_sitter_java::LANGUAGE.into(),
        Language::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
        Language::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        Language::Bash => tree_sitter_bash::LANGUAGE.into(),
        Language::C => tree_sitter_c::LANGUAGE.into(),
        Language::Cpp => tree_sitter_cpp::LANGUAGE.into(),
        Language::Metal => tree_sitter_cpp::LANGUAGE.into(),
        Language::Toml => tree_sitter_toml_ng::LANGUAGE.into(),
        Language::Yaml => tree_sitter_yaml::LANGUAGE.into(),
        Language::Php => tree_sitter_php::LANGUAGE_PHP.into(),
        Language::Zig => tree_sitter_zig::LANGUAGE.into(),
        Language::Gdscript => tree_sitter_gdscript::LANGUAGE.into(),
        Language::Matlab => tree_sitter_matlab::LANGUAGE.into(),
        Language::Apex => tree_sitter_sfapex::apex::LANGUAGE.into(),
        _ => return Ok((chunk_by_lines(content, &language), Vec::new())),
    };

    parser.set_language(&ts_language)?;
    let tree = parser
        .parse(content, None)
        .ok_or_else(|| anyhow!("Failed to parse file: {}", file_path))?;
    let chunks = extract_chunks(&tree, content, &language)?;
    let symbols = extract_symbols(&tree, content, &language);
    Ok((chunks, symbols))
}

fn extract_symbols(tree: &Tree, source: &str, language: &Language) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut cursor = tree.root_node().walk();
    extract_symbol_nodes(&mut cursor, source, language, &mut symbols, 0);
    symbols
}

fn extract_symbol_nodes(
    cursor: &mut tree_sitter::TreeCursor,
    source: &str,
    language: &Language,
    symbols: &mut Vec<ParsedSymbol>,
    depth: usize,
) {
    const MAX_RECURSION_DEPTH: usize = 1024;

    loop {
        let node = cursor.node();
        if is_semantic_node(node.kind(), language) && node.kind() != "export_statement" {
            if let Some(name) = extract_name(cursor, source, language) {
                symbols.push(ParsedSymbol {
                    name,
                    kind: semantic_chunk_type(&node, source, language),
                    start_line: node.start_position().row as u32 + 1,
                    start_col: node.start_position().column as u32,
                    end_line: node.end_position().row as u32 + 1,
                    end_col: node.end_position().column as u32,
                    language: language.as_str().to_string(),
                });
            }
        }

        if depth <= MAX_RECURSION_DEPTH && cursor.goto_first_child() {
            extract_symbol_nodes(cursor, source, language, symbols, depth + 1);
            cursor.goto_parent();
        }

        if !cursor.goto_next_sibling() {
            break;
        }
    }
}

fn extract_chunks(tree: &Tree, source: &str, language: &Language) -> Result<Vec<CodeChunk>> {
    let mut chunks = Vec::new();
    let root = tree.root_node();
    let mut cursor = root.walk();

    extract_semantic_nodes(&mut cursor, source, language, &mut chunks, 0);

    if chunks.is_empty() {
        return Ok(chunk_by_lines(source, language));
    }

    merge_small_chunks(&mut chunks);

    Ok(chunks)
}

fn extract_semantic_nodes(
    cursor: &mut tree_sitter::TreeCursor,
    source: &str,
    language: &Language,
    chunks: &mut Vec<CodeChunk>,
    depth: usize,
) {
    #[cfg(debug_assertions)]
    let start = Instant::now();
    #[cfg(debug_assertions)]
    {
        let mut stats = PERF_STATS.lock().unwrap();
        stats.extract_semantic_nodes_calls += 1;
        stats.max_depth_reached = stats.max_depth_reached.max(depth);
    }

    const MAX_RECURSION_DEPTH: usize = 1024;
    let skip_children = depth > MAX_RECURSION_DEPTH;
    if skip_children {
        #[cfg(debug_assertions)]
        {
            PERF_STATS.lock().unwrap().recursion_depth_exceeded_count += 1;
        }
    }
    loop {
        let node = cursor.node();
        let node_type = node.kind();

        let is_semantic = is_semantic_node(node_type, language);

        if is_semantic {
            let semantic_start_node = if *language == Language::Metal {
                node.parent()
                    .filter(|parent| parent.kind() == "template_declaration")
                    .unwrap_or(node)
            } else {
                node
            };
            let mut start_byte = semantic_start_node.start_byte();
            let end_byte = node.end_byte();

            let leading_comment = find_leading_comment(&node, source, language);
            if let Some((comment_start, _comment_text)) = &leading_comment {
                start_byte = *comment_start;
            }

            let content = &source[start_byte..end_byte];
            let name = extract_name(cursor, source, language);
            let preserve_small_declaration = match language {
                Language::Swift => name.is_some(),
                Language::Bash => node_type == "function_definition",
                Language::C => node_type == "function_definition",
                Language::Cpp => matches!(
                    node_type,
                    "function_definition" | "class_specifier" | "struct_specifier"
                ),
                Language::Metal => true,
                _ => false,
            };

            if content.len() >= MIN_CHUNK_SIZE || preserve_small_declaration {
                let (start_line, start_col) = if leading_comment.is_some() {
                    let prefix = &source[..start_byte];
                    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() as u32 + 1;
                    let col = prefix.rsplit('\n').next().unwrap_or_default().len() as u32;
                    (line, col)
                } else {
                    (
                        semantic_start_node.start_position().row as u32 + 1,
                        semantic_start_node.start_position().column as u32,
                    )
                };

                let chunk = CodeChunk {
                    content: content.to_string(),
                    start_line,
                    start_col,
                    end_line: node.end_position().row as u32 + 1,
                    end_col: node.end_position().column as u32,
                    chunk_type: semantic_chunk_type(&node, source, language),
                    name,
                    language: language.as_str().to_string(),
                };

                if content.len() <= MAX_CHUNK_SIZE {
                    chunks.push(chunk);
                } else {
                    split_large_chunk(chunk, chunks);
                }
            }
        }

        let descend_into_metal_type = *language == Language::Metal
            && matches!(
                node_type,
                "class_specifier" | "struct_specifier" | "union_specifier"
            );
        let descend_into_ts_abstract_class =
            matches!(language, Language::TypeScript | Language::TypeScriptTsx)
                && node_type == "abstract_class_declaration";
        let should_descend = !is_semantic
            || *language == Language::Swift
            || descend_into_metal_type
            || descend_into_ts_abstract_class;
        if should_descend && !skip_children && cursor.goto_first_child() {
            extract_semantic_nodes(cursor, source, language, chunks, depth + 1);
            cursor.goto_parent();
        }

        if !cursor.goto_next_sibling() {
            break;
        }
    }

    #[cfg(debug_assertions)]
    {
        let elapsed = start.elapsed().as_micros();
        PERF_STATS.lock().unwrap().extract_semantic_nodes_time += elapsed;
    }
}

fn find_leading_comment(
    node: &tree_sitter::Node,
    source: &str,
    language: &Language,
) -> Option<(usize, String)> {
    #[cfg(debug_assertions)]
    let start = Instant::now();
    #[cfg(debug_assertions)]
    {
        PERF_STATS.lock().unwrap().find_leading_comment_calls += 1;
    }

    let mut prev = node.prev_sibling();
    let mut comments = Vec::new();
    let max_comment_siblings = if *language == Language::Swift {
        usize::MAX
    } else {
        5
    };

    while let Some(sibling) = prev {
        if comments.len() >= max_comment_siblings {
            break;
        }
        if is_comment_node(sibling.kind(), language) {
            let start = sibling.start_byte();
            let end = sibling.end_byte();
            comments.push((start, end));
            prev = sibling.prev_sibling();
        } else {
            break;
        }
    }

    if comments.is_empty() {
        return find_matlab_leading_comment(node, source, language);
    }

    comments.reverse();
    let first_start = comments.first().map(|(s, _)| *s)?;
    let combined: String = comments
        .into_iter()
        .map(|(start, end)| &source[start..end])
        .collect::<Vec<_>>()
        .join("\n");

    #[cfg(debug_assertions)]
    {
        let elapsed = start.elapsed().as_micros();
        PERF_STATS.lock().unwrap().find_leading_comment_time += elapsed;
    }

    Some((first_start, combined))
}

fn find_matlab_leading_comment(
    node: &tree_sitter::Node,
    source: &str,
    language: &Language,
) -> Option<(usize, String)> {
    if *language != Language::Matlab {
        return None;
    }

    let prefix = &source[..node.start_byte()];
    let mut line_start = 0;
    let mut lines = Vec::new();

    for segment in prefix.split_inclusive('\n') {
        let line = segment.trim_end_matches(['\r', '\n']);
        lines.push((line_start, line));
        line_start += segment.len();
    }

    let mut comments = Vec::new();
    for (start, line) in lines.into_iter().rev() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            break;
        }
        if trimmed.starts_with('%') {
            comments.push((start, line));
            continue;
        }
        break;
    }

    if comments.is_empty() {
        return None;
    }

    comments.reverse();
    let first_start = comments.first().map(|(start, _)| *start)?;
    let combined = comments
        .into_iter()
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n");

    Some((first_start, combined))
}

fn is_comment_node(node_type: &str, language: &Language) -> bool {
    match language {
        Language::TypeScript
        | Language::TypeScriptTsx
        | Language::JavaScript
        | Language::JavaScriptJsx => matches!(node_type, "comment"),
        Language::Python => matches!(node_type, "comment"),
        Language::Rust => matches!(node_type, "line_comment" | "block_comment"),
        Language::Swift => matches!(node_type, "comment" | "multiline_comment"),
        Language::Go => matches!(node_type, "comment"),
        Language::Java => matches!(node_type, "line_comment" | "block_comment"),
        Language::CSharp => matches!(node_type, "comment"),
        Language::Ruby => matches!(node_type, "comment"),
        Language::Bash => matches!(node_type, "comment"),
        Language::C | Language::Cpp | Language::Metal => matches!(node_type, "comment"),
        Language::Toml => matches!(node_type, "comment"),
        Language::Yaml => matches!(node_type, "comment"),
        Language::Php => matches!(node_type, "comment"),
        Language::Zig => matches!(node_type, "comment"),
        Language::Gdscript => matches!(node_type, "comment"),
        Language::Matlab => matches!(node_type, "comment"),
        Language::Apex => matches!(node_type, "line_comment" | "block_comment"),
        _ => false,
    }
}

struct PerfStats {
    extract_semantic_nodes_calls: usize,
    extract_semantic_nodes_time: u128,
    find_leading_comment_calls: usize,
    find_leading_comment_time: u128,
    extract_name_calls: usize,
    extract_name_time: u128,
    is_semantic_node_calls: usize,
    is_semantic_node_time: u128,
    recursion_depth_exceeded_count: usize,
    max_depth_reached: usize,
}

impl PerfStats {
    fn new() -> Self {
        Self {
            extract_semantic_nodes_calls: 0,
            extract_semantic_nodes_time: 0,
            find_leading_comment_calls: 0,
            find_leading_comment_time: 0,
            extract_name_calls: 0,
            extract_name_time: 0,
            is_semantic_node_calls: 0,
            is_semantic_node_time: 0,
            recursion_depth_exceeded_count: 0,
            max_depth_reached: 0,
        }
    }

    fn print(&self) {
        eprintln!("=== Parser Performance Stats ===");
        eprintln!(
            "extract_semantic_nodes: {} calls, {} us",
            self.extract_semantic_nodes_calls, self.extract_semantic_nodes_time
        );
        eprintln!(
            "find_leading_comment: {} calls, {} us",
            self.find_leading_comment_calls, self.find_leading_comment_time
        );
        eprintln!(
            "extract_name: {} calls, {} us",
            self.extract_name_calls, self.extract_name_time
        );
        eprintln!(
            "is_semantic_node: {} calls, {} us",
            self.is_semantic_node_calls, self.is_semantic_node_time
        );
        eprintln!(
            "recursion_depth_exceeded: {} times",
            self.recursion_depth_exceeded_count
        );
        eprintln!("max_depth_reached: {}", self.max_depth_reached);
    }
}

pub fn print_parser_perf_stats() {
    PERF_STATS.lock().unwrap().print();
}

static PERF_STATS: LazyLock<Mutex<PerfStats>> = LazyLock::new(|| Mutex::new(PerfStats::new()));
static TS_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    // Original 10 types
    set.insert("function_declaration");
    set.insert("function");
    set.insert("arrow_function");
    set.insert("method_definition");
    set.insert("class_declaration");
    set.insert("interface_declaration");
    set.insert("type_alias_declaration");
    set.insert("enum_declaration");
    set.insert("export_statement");
    set.insert("lexical_declaration");
    set.insert("abstract_class_declaration");
    // Added 5 most common statement types
    set.insert("expression_statement");
    set.insert("if_statement");
    set.insert("for_statement");
    set.insert("return_statement");
    set.insert("try_statement");
    set.insert("while_statement");
    set.insert("statement_block");
    set.insert("for_in_statement");
    set
});
static PYTHON_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("class_definition");
    set.insert("decorated_definition");
    set
});
static RUST_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_item");
    set.insert("impl_item");
    set.insert("struct_item");
    set.insert("enum_item");
    set.insert("trait_item");
    set.insert("mod_item");
    set.insert("macro_definition");
    set
});
static SWIFT_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("class_declaration");
    set.insert("protocol_declaration");
    set.insert("function_declaration");
    set.insert("protocol_function_declaration");
    set.insert("init_declaration");
    set.insert("deinit_declaration");
    set.insert("subscript_declaration");
    set
});
static GO_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_declaration");
    set.insert("method_declaration");
    set.insert("type_declaration");
    set.insert("type_spec");
    set
});
static JAVA_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("class_declaration");
    set.insert("method_declaration");
    set.insert("constructor_declaration");
    set.insert("interface_declaration");
    set.insert("enum_declaration");
    set.insert("annotation_type_declaration");
    set
});
static CSHARP_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("class_declaration");
    set.insert("method_declaration");
    set.insert("constructor_declaration");
    set.insert("interface_declaration");
    set.insert("enum_declaration");
    set.insert("struct_declaration");
    set.insert("record_declaration");
    set.insert("property_declaration");
    set
});
static RUBY_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("method");
    set.insert("singleton_method");
    set.insert("class");
    set.insert("module");
    set
});
static BASH_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set
});
static C_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("struct_specifier");
    set.insert("enum_specifier");
    set.insert("type_definition");
    set
});
static CPP_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("class_specifier");
    set.insert("struct_specifier");
    set.insert("enum_specifier");
    set.insert("namespace_definition");
    set.insert("template_declaration");
    set
});
static METAL_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("class_specifier");
    set.insert("struct_specifier");
    set.insert("union_specifier");
    set.insert("enum_specifier");
    set.insert("type_definition");
    set.insert("alias_declaration");
    set
});
static TOML_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("table");
    set.insert("table_array_element");
    set
});
static YAML_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("block_mapping_pair");
    set.insert("block_sequence");
    set
});
static PHP_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("method_declaration");
    set.insert("class_declaration");
    set.insert("interface_declaration");
    set.insert("trait_declaration");
    set.insert("enum_declaration");
    set
});
static ZIG_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_declaration");
    set.insert("test_declaration");
    set.insert("struct_declaration");
    set.insert("enum_declaration");
    set.insert("union_declaration");
    set.insert("opaque_declaration");
    set.insert("error_set_declaration");
    set
});
// GDScript grammar (PrestonKnopp/tree-sitter-gdscript). Declaration-like
// nodes only — variable_statement is intentionally excluded because
// module-level `var foo = ...` lines would generate one chunk per
// variable and drown out real declarations.
static GDSCRIPT_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("constructor_definition");
    set.insert("class_definition");
    set.insert("enum_definition");
    set.insert("signal_statement");
    set.insert("const_statement");
    set.insert("class_name_statement");
    set
});
static MATLAB_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("function_definition");
    set.insert("class_definition");
    set
});
// Apex grammar (tree-sitter-sfapex) is Java-derived: the declaration node
// kinds match Java exactly, plus `trigger_declaration` which is unique to
// Apex (Salesforce database triggers). Verified against tree-sitter-sfapex
// 3.0 by parsing representative classes/triggers/interfaces.
static APEX_SEMANTIC_NODES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    let mut set = HashSet::new();
    set.insert("class_declaration");
    set.insert("method_declaration");
    set.insert("constructor_declaration");
    set.insert("interface_declaration");
    set.insert("enum_declaration");
    set.insert("trigger_declaration");
    set
});

fn is_semantic_node(node_type: &str, language: &Language) -> bool {
    #[cfg(debug_assertions)]
    let start = Instant::now();
    #[cfg(debug_assertions)]
    {
        PERF_STATS.lock().unwrap().is_semantic_node_calls += 1;
    }

    let result = match language {
        Language::TypeScript
        | Language::TypeScriptTsx
        | Language::JavaScript
        | Language::JavaScriptJsx => TS_SEMANTIC_NODES.contains(node_type),
        Language::Python => PYTHON_SEMANTIC_NODES.contains(node_type),
        Language::Rust => RUST_SEMANTIC_NODES.contains(node_type),
        Language::Swift => SWIFT_SEMANTIC_NODES.contains(node_type),
        Language::Go => GO_SEMANTIC_NODES.contains(node_type),
        Language::Java => JAVA_SEMANTIC_NODES.contains(node_type),
        Language::CSharp => CSHARP_SEMANTIC_NODES.contains(node_type),
        Language::Ruby => RUBY_SEMANTIC_NODES.contains(node_type),
        Language::Bash => BASH_SEMANTIC_NODES.contains(node_type),
        Language::C => C_SEMANTIC_NODES.contains(node_type),
        Language::Cpp => CPP_SEMANTIC_NODES.contains(node_type),
        Language::Metal => METAL_SEMANTIC_NODES.contains(node_type),
        Language::Toml => TOML_SEMANTIC_NODES.contains(node_type),
        Language::Yaml => YAML_SEMANTIC_NODES.contains(node_type),
        Language::Php => PHP_SEMANTIC_NODES.contains(node_type),
        Language::Zig => ZIG_SEMANTIC_NODES.contains(node_type),
        Language::Gdscript => GDSCRIPT_SEMANTIC_NODES.contains(node_type),
        Language::Matlab => MATLAB_SEMANTIC_NODES.contains(node_type),
        Language::Apex => APEX_SEMANTIC_NODES.contains(node_type),
        _ => false,
    };

    #[cfg(debug_assertions)]
    {
        let elapsed = start.elapsed().as_micros();
        PERF_STATS.lock().unwrap().is_semantic_node_time += elapsed;
    }

    result
}

fn semantic_chunk_type(node: &tree_sitter::Node, source: &str, language: &Language) -> String {
    if matches!(language, Language::TypeScript | Language::TypeScriptTsx)
        && node.kind() == "abstract_class_declaration"
    {
        return "class_declaration".to_string();
    }

    if *language != Language::Swift {
        return node.kind().to_string();
    }

    if node.kind() == "class_declaration" {
        if let Some(declaration_kind) = node.child_by_field_name("declaration_kind") {
            return match &source[declaration_kind.byte_range()] {
                "class" => "class_declaration",
                "struct" => "struct_declaration",
                "enum" => "enum_declaration",
                "actor" => "actor_declaration",
                "extension" => "extension_declaration",
                _ => "class_declaration",
            }
            .to_string();
        }
    }

    if node.kind() == "function_declaration"
        && node
            .parent()
            .map(|parent| matches!(parent.kind(), "class_body" | "enum_class_body"))
            .unwrap_or(false)
    {
        return "method_declaration".to_string();
    }

    node.kind().to_string()
}

fn extract_name(
    cursor: &tree_sitter::TreeCursor,
    source: &str,
    language: &Language,
) -> Option<String> {
    #[cfg(debug_assertions)]
    let start = Instant::now();
    #[cfg(debug_assertions)]
    {
        PERF_STATS.lock().unwrap().extract_name_calls += 1;
    }

    let node = cursor.node();

    let fixed_name = match node.kind() {
        "init_declaration" => Some("init"),
        "deinit_declaration" => Some("deinit"),
        "subscript_declaration" => Some("subscript"),
        _ => None,
    };
    if let Some(name) = fixed_name {
        #[cfg(debug_assertions)]
        {
            let elapsed = start.elapsed().as_micros();
            PERF_STATS.lock().unwrap().extract_name_time += elapsed;
        }
        return Some(name.to_string());
    }

    if node.kind() == "arrow_function" {
        let name = extract_arrow_binding_name(node, source);
        #[cfg(debug_assertions)]
        {
            let elapsed = start.elapsed().as_micros();
            PERF_STATS.lock().unwrap().extract_name_time += elapsed;
        }
        return name;
    }

    if *language == Language::Metal {
        if matches!(node.kind(), "function_definition" | "type_definition") {
            if let Some(declarator) = node.child_by_field_name("declarator") {
                if let Some(name) = extract_declarator_name(declarator, source) {
                    #[cfg(debug_assertions)]
                    {
                        let elapsed = start.elapsed().as_micros();
                        PERF_STATS.lock().unwrap().extract_name_time += elapsed;
                    }
                    return Some(name);
                }
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Some(name) = extract_declarator_name(name_node, source) {
                #[cfg(debug_assertions)]
                {
                    let elapsed = start.elapsed().as_micros();
                    PERF_STATS.lock().unwrap().extract_name_time += elapsed;
                }
                return Some(name);
            }
        }
        if let Some(name) = extract_declarator_name(node, source) {
            #[cfg(debug_assertions)]
            {
                let elapsed = start.elapsed().as_micros();
                PERF_STATS.lock().unwrap().extract_name_time += elapsed;
            }
            return Some(name);
        }
    }

    let extract_identifier = |n: tree_sitter::Node| -> Option<String> {
        let kind = n.kind();
        if kind == "identifier"
            || kind == "simple_identifier"
            || kind == "property_identifier"
            || kind == "property_name"
            || kind == "type_identifier"
            || kind == "namespace_identifier"
            || kind == "custom_operator"
            || kind == "name"
            || kind == "word"
        {
            return Some(source[n.start_byte()..n.end_byte()].to_string());
        }

        if kind == "user_type" {
            for index in (0..n.named_child_count()).rev() {
                let Some(child) = n.named_child(index.try_into().unwrap()) else {
                    continue;
                };
                if child.kind() == "type_identifier" {
                    return Some(source[child.start_byte()..child.end_byte()].to_string());
                }
            }
        }
        None
    };

    if let Some(name_node) = node.child_by_field_name("name") {
        if let Some(name) = extract_identifier(name_node) {
            #[cfg(debug_assertions)]
            {
                let elapsed = start.elapsed().as_micros();
                PERF_STATS.lock().unwrap().extract_name_time += elapsed;
            }
            return Some(name);
        }

        if matches!(
            node.kind(),
            "function_declaration" | "protocol_function_declaration"
        ) && !name_node.is_named()
        {
            #[cfg(debug_assertions)]
            {
                let elapsed = start.elapsed().as_micros();
                PERF_STATS.lock().unwrap().extract_name_time += elapsed;
            }
            return Some(source[name_node.byte_range()].to_string());
        }
    }

    if node.kind() == "function_definition" {
        if let Some(declarator) = node.child_by_field_name("declarator") {
            if let Some(name) = extract_declarator_name(declarator, source) {
                #[cfg(debug_assertions)]
                {
                    let elapsed = start.elapsed().as_micros();
                    PERF_STATS.lock().unwrap().extract_name_time += elapsed;
                }
                return Some(name);
            }
        }
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i.try_into().unwrap()) {
            if let Some(name) = extract_identifier(child) {
                #[cfg(debug_assertions)]
                {
                    let elapsed = start.elapsed().as_micros();
                    PERF_STATS.lock().unwrap().extract_name_time += elapsed;
                }
                return Some(name);
            }
        }
    }

    if node.kind() == "export_statement" {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i.try_into().unwrap()) {
                let child_kind = child.kind();
                if matches!(
                    child_kind,
                    "function_declaration"
                        | "class_declaration"
                        | "interface_declaration"
                        | "type_alias_declaration"
                        | "enum_declaration"
                        | "lexical_declaration"
                        | "abstract_class_declaration"
                ) {
                    for j in 0..child.child_count() {
                        if let Some(grandchild) = child.child(j.try_into().unwrap()) {
                            if let Some(name) = extract_identifier(grandchild) {
                                #[cfg(debug_assertions)]
                                {
                                    let elapsed = start.elapsed().as_micros();
                                    PERF_STATS.lock().unwrap().extract_name_time += elapsed;
                                }
                                return Some(name);
                            }
                        }
                    }

                    if child_kind == "lexical_declaration" {
                        for j in 0..child.child_count() {
                            if let Some(declarator) = child.child(j.try_into().unwrap()) {
                                if declarator.kind() == "variable_declarator" {
                                    for k in 0..declarator.child_count() {
                                        if let Some(name_node) =
                                            declarator.child(k.try_into().unwrap())
                                        {
                                            if name_node.kind() == "identifier" {
                                                #[cfg(debug_assertions)]
                                                {
                                                    let elapsed = start.elapsed().as_micros();
                                                    PERF_STATS.lock().unwrap().extract_name_time +=
                                                        elapsed;
                                                }
                                                return Some(
                                                    source[name_node.start_byte()
                                                        ..name_node.end_byte()]
                                                        .to_string(),
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(debug_assertions)]
    {
        let elapsed = start.elapsed().as_micros();
        PERF_STATS.lock().unwrap().extract_name_time += elapsed;
    }

    None
}

fn extract_declarator_name(node: tree_sitter::Node<'_>, source: &str) -> Option<String> {
    if matches!(
        node.kind(),
        "identifier" | "field_identifier" | "type_identifier" | "operator_name"
    ) {
        return Some(source[node.start_byte()..node.end_byte()].to_string());
    }

    if let Some(name) = node.child_by_field_name("name") {
        if let Some(result) = extract_declarator_name(name, source) {
            return Some(result);
        }
    }

    if let Some(declarator) = node.child_by_field_name("declarator") {
        if let Some(result) = extract_declarator_name(declarator, source) {
            return Some(result);
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(result) = extract_declarator_name(child, source) {
            return Some(result);
        }
    }

    None
}

fn extract_arrow_binding_name(node: tree_sitter::Node<'_>, source: &str) -> Option<String> {
    let parent = node.parent()?;
    if parent.kind() != "variable_declarator" {
        return None;
    }

    if let Some(name_node) = parent.child_by_field_name("name") {
        if let Some(name) = extract_declarator_name(name_node, source) {
            return Some(name);
        }
    }

    extract_declarator_name(parent, source)
}

fn split_large_chunk(chunk: CodeChunk, chunks: &mut Vec<CodeChunk>) {
    let lines: Vec<&str> = chunk.content.lines().collect();
    let total_lines = lines.len();

    if total_lines <= 1 {
        chunks.push(chunk);
        return;
    }

    let lines_per_chunk = TARGET_CHUNK_SIZE / 40;
    let step_size = if lines_per_chunk > OVERLAP_LINES {
        lines_per_chunk - OVERLAP_LINES
    } else {
        lines_per_chunk
    };
    let mut start = 0;

    while start < total_lines {
        let end = std::cmp::min(start + lines_per_chunk, total_lines);
        let sub_content: String = lines[start..end].join("\n");

        if sub_content.len() >= MIN_CHUNK_SIZE {
            chunks.push(CodeChunk {
                content: sub_content,
                start_line: chunk.start_line + start as u32,
                start_col: if start == 0 { chunk.start_col } else { 0 },
                end_line: chunk.start_line + end as u32 - 1,
                end_col: if end == total_lines {
                    chunk.end_col
                } else {
                    lines[end - 1].len() as u32
                },
                chunk_type: chunk.chunk_type.clone(),
                name: chunk.name.clone(),
                language: chunk.language.clone(),
            });
        }

        if end >= total_lines {
            break;
        }
        start += step_size;
    }
}

fn merge_small_chunks(chunks: &mut Vec<CodeChunk>) {
    if chunks.len() < 2 {
        return;
    }

    let mut merged = Vec::with_capacity(chunks.len());
    let mut current: Option<CodeChunk> = None;

    for chunk in chunks.drain(..) {
        let Some(mut cur) = current.take() else {
            current = Some(chunk);
            continue;
        };

        let is_preserved_call_graph_symbol =
            |candidate: &CodeChunk| match candidate.language.as_str() {
                "bash" | "c" => candidate.chunk_type == "function_definition",
                "cpp" => matches!(
                    candidate.chunk_type.as_str(),
                    "function_definition" | "class_specifier" | "struct_specifier"
                ),
                "swift" => candidate.name.is_some(),
                "metal" => true,
                _ => false,
            };
        let can_merge_without_losing_symbol =
            !is_preserved_call_graph_symbol(&cur) && !is_preserved_call_graph_symbol(&chunk);

        if can_merge_without_losing_symbol
            && cur.content.len() < MIN_CHUNK_SIZE * 2
            && cur.content.len() + chunk.content.len() <= MAX_CHUNK_SIZE
            && cur.end_line + 1 >= chunk.start_line
        {
            cur.content.push_str("\n\n");
            cur.content.push_str(&chunk.content);
            cur.end_line = chunk.end_line;
            cur.end_col = chunk.end_col;
            current = Some(cur);
        } else {
            merged.push(cur);
            current = Some(chunk);
        }
    }

    if let Some(cur) = current {
        merged.push(cur);
    }

    *chunks = merged;
}

fn chunk_by_lines(content: &str, language: &Language) -> Vec<CodeChunk> {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    if total_lines == 0 {
        return Vec::new();
    }

    let lines_per_chunk = 30;
    let step_size = if lines_per_chunk > OVERLAP_LINES {
        lines_per_chunk - OVERLAP_LINES
    } else {
        lines_per_chunk
    };
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < total_lines {
        let end = std::cmp::min(start + lines_per_chunk, total_lines);
        let sub_content: String = lines[start..end].join("\n");

        if !sub_content.trim().is_empty() {
            chunks.push(CodeChunk {
                content: sub_content,
                start_line: start as u32 + 1,
                start_col: 0,
                end_line: end as u32,
                end_col: lines[end - 1].len() as u32,
                chunk_type: "block".to_string(),
                name: None,
                language: language.as_str().to_string(),
            });
        }

        if end >= total_lines {
            break;
        }
        start += step_size;
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_php_parses_without_errors(content: &str) {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_php::LANGUAGE_PHP.into())
            .unwrap();
        let tree = parser.parse(content, None).unwrap();

        assert!(
            !tree.root_node().has_error(),
            "Expected valid PHP syntax without ERROR nodes, got: {}",
            tree.root_node().to_sexp()
        );
    }

    const MODERN_SWIFT_FIXTURE: &str =
        include_str!("../../tests/fixtures/swift/ModernService.swift");

    fn parse_swift_syntax(source: &str) -> Tree {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_swift::LANGUAGE.into())
            .expect("tree-sitter-swift 0.7.3 should load");
        let tree = parser
            .parse(source, None)
            .expect("Swift parsing should return a tree");
        assert!(
            !tree.root_node().has_error(),
            "Unexpected Swift ERROR/MISSING node:\n{}",
            tree.root_node().to_sexp()
        );
        tree
    }

    fn collect_swift_declaration_kinds(
        node: tree_sitter::Node<'_>,
        source: &str,
        kinds: &mut Vec<String>,
    ) {
        if node.kind() == "class_declaration" {
            let declaration_kind = node
                .child_by_field_name("declaration_kind")
                .expect("Swift class_declaration should expose declaration_kind");
            kinds.push(source[declaration_kind.byte_range()].to_string());
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            collect_swift_declaration_kinds(child, source, kinds);
        }
    }

    #[test]
    fn test_swift_grammar_node_types_contract() {
        let node_types: Vec<serde_json::Value> =
            serde_json::from_str(tree_sitter_swift::NODE_TYPES).unwrap();

        for expected in [
            "class_declaration",
            "protocol_declaration",
            "function_declaration",
            "protocol_function_declaration",
            "init_declaration",
            "deinit_declaration",
            "subscript_declaration",
            "call_expression",
            "navigation_expression",
            "constructor_expression",
            "import_declaration",
            "inheritance_specifier",
            "simple_identifier",
            "type_identifier",
            "comment",
            "multiline_comment",
        ] {
            assert!(
                node_types.iter().any(|node| node["type"] == expected),
                "tree-sitter-swift 0.7.3 NODE_TYPES is missing {expected}"
            );
        }

        let class_declaration = node_types
            .iter()
            .find(|node| node["type"] == "class_declaration")
            .unwrap();
        let declaration_kinds = class_declaration["fields"]["declaration_kind"]["types"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["type"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            declaration_kinds,
            ["actor", "class", "enum", "extension", "struct"]
        );
    }

    #[test]
    fn test_swift_grammar_parses_modern_fixture_without_errors() {
        let tree = parse_swift_syntax(MODERN_SWIFT_FIXTURE);
        let syntax = tree.root_node().to_sexp();

        for expected in [
            "protocol_declaration",
            "protocol_function_declaration",
            "function_declaration",
            "init_declaration",
            "deinit_declaration",
            "subscript_declaration",
            "await_expression",
            "try_expression",
            "lambda_literal",
        ] {
            assert!(syntax.contains(expected), "AST should contain {expected}");
        }

        let mut declaration_kinds = Vec::new();
        collect_swift_declaration_kinds(
            tree.root_node(),
            MODERN_SWIFT_FIXTURE,
            &mut declaration_kinds,
        );
        for expected in ["actor", "class", "enum", "extension", "struct"] {
            assert!(
                declaration_kinds.iter().any(|kind| kind == expected),
                "AST should contain Swift declaration kind {expected}: {declaration_kinds:?}"
            );
        }
    }

    #[test]
    fn test_swift_call_syntax_shapes_have_no_errors() {
        let source = r#"
import Foundation
import struct Foundation.Date

class Child: Base, Runnable {
    func run() async throws {
        direct()
        self.method()
        super.method()
        object?.method()
        Type()
        Module.Type()
        generic<Int>()
        object.method<Int>()
        Type.init()
        try await asyncWork()
        withTaskGroup { group in group.cancelAll() }
    }
}
"#;
        let tree = parse_swift_syntax(source);
        let syntax = tree.root_node().to_sexp();

        for expected in [
            "call_expression",
            "navigation_expression",
            "constructor_expression",
            "await_expression",
            "try_expression",
            "lambda_literal",
            "import_declaration",
            "inheritance_specifier",
        ] {
            assert!(syntax.contains(expected), "AST should contain {expected}");
        }
    }

    #[test]
    fn test_parse_typescript() {
        let content = r#"
	function greet(name: string): string {
	    return `Hello, ${name}!`;
}

class Greeter {
    private name: string;

    constructor(name: string) {
        this.name = name;
    }

    greet(): string {
        return `Hello, ${this.name}!`;
    }
}
"#;

        let chunks = parse_file_internal("test.ts", content).unwrap();
        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_extract_arrow_function_name_uses_variable_binding() {
        let content = r#"
	const handle = (event: string) => {
	  return event.toLowerCase();
	};

	const normalize = (value: number) => value * 2;
	const values = [1, 2].map(item => item * 2);
	"#;

        let (_chunks, symbols) = parse_file_with_symbols_internal("arrows.ts", content)
            .expect("should parse TypeScript arrow functions");

        let arrow_names: Vec<String> = symbols
            .iter()
            .filter(|symbol| symbol.kind == "arrow_function")
            .map(|symbol| symbol.name.clone())
            .collect();

        assert!(arrow_names.iter().any(|name| name == "handle"));
        assert!(arrow_names.iter().any(|name| name == "normalize"));
        assert!(!arrow_names.iter().any(|name| name == "event"));
        assert!(!arrow_names.iter().any(|name| name == "value"));
        assert!(!arrow_names.iter().any(|name| name == "item"));
    }

    #[test]
    fn test_extracts_exported_abstract_class_declaration_and_methods() {
        let content = r#"
	export abstract class AbstractAnimal {
	  identify(): string {
	    return "animal";
	  }

	  describe(): string {
	    return this.identify();
	  }
	}
	"#;

        let (_chunks, symbols) = parse_file_with_symbols_internal("animal.ts", content)
            .expect("should parse exported abstract class");

        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "class_declaration" && symbol.name == "AbstractAnimal"
        }));

        let method_names: Vec<String> = symbols
            .iter()
            .filter(|symbol| symbol.kind == "method_definition")
            .map(|symbol| symbol.name.clone())
            .collect();

        assert!(method_names.iter().any(|name| name == "identify"));
        assert!(method_names.iter().any(|name| name == "describe"));
    }

    #[test]
    fn test_parse_python() {
        let content = r#"
	def greet(name: str) -> str:
    return f"Hello, {name}!"

class Greeter:
    def __init__(self, name: str):
        self.name = name

    def greet(self) -> str:
        return f"Hello, {self.name}!"
"#;

        let chunks = parse_file_internal("test.py", content).unwrap();
        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_parse_php_8_syntax_without_errors() {
        let content = include_str!("../../tests/fixtures/call-graph/php-8-features.php");

        assert_php_parses_without_errors(content);
    }

    #[test]
    fn test_parse_php_8_semantic_chunks_have_names() {
        let content = include_str!("../../tests/fixtures/call-graph/php-8-features.php");
        let chunks = parse_file_internal("php-8-features.php", content).unwrap();

        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "class_declaration" && chunk.name.as_deref() == Some("Job")
        }));
        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "interface_declaration"
                && chunk.name.as_deref() == Some("Cacheable")
        }));
        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "trait_declaration" && chunk.name.as_deref() == Some("Timestamps")
        }));
        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "enum_declaration" && chunk.name.as_deref() == Some("Status")
        }));
        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "function_definition" && chunk.name.as_deref() == Some("pipeline")
        }));
    }

    #[test]
    fn test_chunk_overlap() {
        let lines: Vec<String> = (0..100)
            .map(|i| format!("line {} content here", i))
            .collect();
        let content = lines.join("\n");

        let chunks = chunk_by_lines(&content, &Language::Text);

        assert!(chunks.len() >= 2, "Should have multiple chunks");

        if chunks.len() >= 2 {
            let first_end = chunks[0].end_line;
            let second_start = chunks[1].start_line;
            assert!(
                second_start <= first_end,
                "Chunks should overlap: first ends at {}, second starts at {}",
                first_end,
                second_start
            );
        }
    }

    #[test]
    fn test_jsdoc_extraction() {
        let content = r#"
/**
 * Validates a user's email address format.
 * @param email The email to validate
 * @returns true if valid, false otherwise
 */
function validateEmail(email: string): boolean {
    return email.includes('@') && email.includes('.');
}
"#;

        let chunks = parse_file_internal("test.ts", content).unwrap();
        assert!(!chunks.is_empty(), "Should have at least one chunk");

        let chunk = &chunks[0];
        assert!(
            chunk.content.contains("Validates a user's email"),
            "Chunk should include JSDoc comment: {}",
            chunk.content
        );
        assert!(
            chunk.content.contains("function validateEmail"),
            "Chunk should include function: {}",
            chunk.content
        );
    }

    #[test]
    fn test_rust_doc_comment_extraction() {
        let content = r#"
/// Calculates the factorial of a number.
/// Returns None if the input would cause overflow.
fn factorial(n: u64) -> Option<u64> {
    if n <= 1 { Some(1) } else { n.checked_mul(factorial(n - 1)?) }
}
"#;

        let chunks = parse_file_internal("test.rs", content).unwrap();
        assert!(!chunks.is_empty(), "Should have at least one chunk");

        let chunk = &chunks[0];
        assert!(
            chunk.content.contains("Calculates the factorial"),
            "Chunk should include doc comment: {}",
            chunk.content
        );
    }

    #[test]
    fn test_parse_java() {
        let content = r#"
public class Calculator {
    private int value;

    public Calculator() {
        this.value = 0;
    }

    public int add(int a, int b) {
        return a + b;
    }
}

public interface Computable {
    int compute(int input);
}

public enum Operation {
    ADD, SUBTRACT, MULTIPLY, DIVIDE
}
"#;

        let chunks = parse_file_internal("Calculator.java", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Java");

        let has_class = chunks.iter().any(|c| c.chunk_type == "class_declaration");
        assert!(has_class, "Should find class_declaration");
    }

    #[test]
    fn test_parse_csharp() {
        let content = r#"
public class Person
{
    public string Name { get; set; }

    public Person(string name)
    {
        Name = name;
    }

    public void Greet()
    {
        Console.WriteLine($"Hello, {Name}!");
    }
}

public interface IGreeter
{
    void Greet();
}

public struct Point
{
    public int X;
    public int Y;
}
"#;

        let chunks = parse_file_internal("Person.cs", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for C#");
    }

    #[test]
    fn test_parse_ruby() {
        let content = r#"
class Greeter
  def initialize(name)
    @name = name
  end

  def greet
    puts "Hello, #{@name}!"
  end

  def self.default_greeting
    "Hello, World!"
  end
end

module Utils
  def self.format(str)
    str.strip.downcase
  end
end
"#;

        let chunks = parse_file_internal("greeter.rb", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Ruby");

        let has_class = chunks.iter().any(|c| c.chunk_type == "class");
        assert!(has_class, "Should find class");
    }

    #[test]
    fn test_parse_bash() {
        let content = r#"
#!/bin/bash

function greet() {
    local name=$1
    echo "Hello, $name!"
}

function add() {
    local a=$1
    local b=$2
    echo $((a + b))
}

greet "World"
"#;

        let chunks = parse_file_internal("script.sh", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Bash");

        let has_function = chunks.iter().any(|c| c.chunk_type == "function_definition");
        assert!(has_function, "Should find function_definition");
        let names: Vec<&str> = chunks
            .iter()
            .filter_map(|chunk| chunk.name.as_deref())
            .collect();
        assert!(names.contains(&"add"), "Should extract the C function name");
        assert!(
            names.contains(&"greet"),
            "Should preserve adjacent C functions"
        );
    }

    #[test]
    fn test_parse_c() {
        let content = r#"
#include <stdio.h>

struct Point {
    int x;
    int y;
};

enum Color {
    RED,
    GREEN,
    BLUE
};

int add(int a, int b) {
    return a + b;
}

void greet(const char* name) {
    printf("Hello, %s!\n", name);
}
"#;

        let chunks = parse_file_internal("main.c", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for C");

        let has_function = chunks.iter().any(|c| c.chunk_type == "function_definition");
        assert!(has_function, "Should find function_definition");
    }

    #[test]
    fn test_parse_cpp() {
        let content = r#"
#include <iostream>
#include <string>

namespace Math {
    int add(int a, int b) {
        return a + b;
    }
}

class Greeter {
private:
    std::string name;

public:
    Greeter(const std::string& n) : name(n) {}

    void greet() const {
        std::cout << "Hello, " << name << "!" << std::endl;
    }
};

struct Point {
    int x;
    int y;
};

template<typename T>
T max(T a, T b) {
    return (a > b) ? a : b;
}

int main() {
    return Math::add(1, 2);
}
"#;

        let chunks = parse_file_internal("main.cpp", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for C++");

        let has_class = chunks.iter().any(|c| c.chunk_type == "class_specifier");
        let has_namespace = chunks
            .iter()
            .any(|c| c.chunk_type == "namespace_definition");
        assert!(
            has_class || has_namespace,
            "Should find class_specifier or namespace_definition"
        );
        assert!(
            chunks
                .iter()
                .any(|chunk| chunk.name.as_deref() == Some("main")),
            "Should extract and preserve the C++ function name"
        );
    }

    #[test]
    fn test_parse_cpp_preserves_small_type_symbols() {
        let chunks = parse_file_internal("small.cpp", "class Tag {};\nstruct Point {};\n").unwrap();

        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "class_specifier" && chunk.name.as_deref() == Some("Tag")
        }));
        assert!(chunks.iter().any(|chunk| {
            chunk.chunk_type == "struct_specifier" && chunk.name.as_deref() == Some("Point")
        }));
    }

    #[test]
    fn test_parse_metal_template_function_uses_template_start() {
        let content = r#"template <typename T>
inline T scaled_value(T value, constant float& scale) {
    return value * T(scale);
}
"#;

        let chunks = parse_file_internal("shader.metal", content).unwrap();
        let function = chunks
            .iter()
            .find(|chunk| chunk.name.as_deref() == Some("scaled_value"))
            .expect("Metal template function should be a semantic chunk");

        assert_eq!(function.chunk_type, "function_definition");
        assert_eq!(function.start_line, 1);
        assert!(function.content.starts_with("template <typename T>"));
        assert!(!chunks
            .iter()
            .any(|chunk| chunk.chunk_type == "template_declaration"));
    }

    #[test]
    fn test_parse_toml() {
        let content = r#"
# This is a TOML configuration file

[package]
name = "my-project"
version = "1.0.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = "1.0"

[[bin]]
name = "my-app"
path = "src/main.rs"

[profile.release]
lto = true
opt-level = 3
"#;

        let chunks = parse_file_internal("Cargo.toml", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for TOML");

        let has_table = chunks.iter().any(|c| c.chunk_type == "table");
        let has_table_array = chunks.iter().any(|c| c.chunk_type == "table_array_element");
        assert!(
            has_table || has_table_array,
            "Should find table or table_array_element"
        );
    }

    #[test]
    fn test_parse_yaml() {
        let content = r#"
# Kubernetes deployment config
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: my-app:latest
          ports:
            - containerPort: 8080
"#;

        let chunks = parse_file_internal("deployment.yaml", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for YAML");
    }

    #[test]
    fn test_parse_markdown_fallback() {
        let content = r#"
# My Project

This is a **markdown** file with various content.

## Installation

```bash
npm install my-project
```

## Usage

Here's how to use the library:

```typescript
import { myFunction } from 'my-project';
myFunction();
```

## Contributing

Please read CONTRIBUTING.md for details.
"#;

        let chunks = parse_file_internal("README.md", content).unwrap();
        // Markdown falls back to line-based chunking
        assert!(!chunks.is_empty(), "Should have chunks for Markdown");
        // Should be block type since we use line-based chunking
        let has_block = chunks.iter().any(|c| c.chunk_type == "block");
        assert!(has_block, "Markdown should use block chunking");
    }

    #[test]
    fn test_parse_apex() {
        let content = r#"
public with sharing class AccountService {
    public AccountService() {}

    public static Account createAccount(String name) {
        Account a = new Account(Name = name);
        insert a;
        return a;
    }

    public Integer countActive() {
        return [SELECT COUNT() FROM Account WHERE Active__c = TRUE];
    }
}
"#;

        let chunks = parse_file_internal("AccountService.cls", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Apex");

        let has_class = chunks.iter().any(|c| c.chunk_type == "class_declaration");
        assert!(has_class, "Should find class_declaration");
    }

    #[test]
    fn test_parse_apex_trigger() {
        let content = r#"
trigger AccountTrigger on Account (before insert, before update, after delete) {
    for (Account a : Trigger.new) {
        a.Description = 'Updated by trigger';
    }
}
"#;

        let chunks = parse_file_internal("AccountTrigger.trigger", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for Apex trigger");

        let has_trigger = chunks.iter().any(|c| c.chunk_type == "trigger_declaration");
        assert!(has_trigger, "Should find trigger_declaration");
    }

    #[test]
    fn test_parse_gdscript() {
        let content = r#"
extends Node

class_name Player

signal health_changed(new_health)

const MAX_HEALTH := 100

enum State { IDLE, RUNNING, JUMPING }

# Initialises the player on scene-enter.
func _ready() -> void:
    print("ready")

func take_damage(amount: int) -> void:
    health -= amount
    health_changed.emit(health)

class InnerThing:
    func do_thing() -> void:
        pass
"#;

        let chunks = parse_file_internal("player.gd", content).unwrap();
        assert!(!chunks.is_empty(), "Should have chunks for GDScript");

        let chunk_types: Vec<&str> = chunks.iter().map(|c| c.chunk_type.as_str()).collect();
        assert!(
            chunk_types.contains(&"function_definition"),
            "Should find function_definition. Got: {:?}",
            chunk_types
        );
        assert!(
            chunk_types.contains(&"class_definition"),
            "Should find class_definition (InnerThing). Got: {:?}",
            chunk_types
        );

        // Leading `#` comment should attach to _ready.
        let ready = chunks
            .iter()
            .find(|c| c.chunk_type == "function_definition" && c.content.contains("_ready"));
        assert!(ready.is_some(), "Should find _ready chunk");
        assert!(
            ready.unwrap().content.contains("Initialises the player"),
            "GDScript leading # comment should attach to its function: {}",
            ready.unwrap().content
        );

        // Language label is consistent.
        assert!(chunks.iter().all(|c| c.language == "gdscript"));
    }

    #[test]
    fn test_apex_doc_comment_extraction() {
        let content = r#"
/**
 * Service for managing Account records.
 * Used by Aura controllers and batch jobs.
 */
public class AccountService {
    public void doWork() {}
}
"#;

        let chunks = parse_file_internal("AccountService.cls", content).unwrap();
        let class_chunk = chunks.iter().find(|c| c.chunk_type == "class_declaration");
        assert!(class_chunk.is_some(), "Should find class_declaration");
        assert!(
            class_chunk
                .unwrap()
                .content
                .contains("Service for managing Account"),
            "Class chunk should include leading block comment: {}",
            class_chunk.unwrap().content
        );
    }
}
