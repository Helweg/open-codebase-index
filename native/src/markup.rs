use crate::types::Language;
use crate::CodeChunk;
use anyhow::{anyhow, Result};
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesDecl, BytesRef, BytesStart, Event};
use quick_xml::name::{NamespaceResolver, ResolveResult};
use quick_xml::reader::{NsReader, Reader};
use std::collections::HashSet;

const MAX_MARKUP_DEPTH: usize = 1024;
const MAX_ATTRIBUTES_PER_ELEMENT: usize = 256;
const MAX_ELEMENT_NAME_BYTES: usize = 256;
const MAX_ATTRIBUTE_VALUE_BYTES: usize = 512;
const MAX_ATTRIBUTE_SOURCE_BYTES: usize = 4096;
const MAX_ENTITY_REFERENCE_BYTES: usize = 256;
const MAX_RENDERED_ATTRIBUTES_BYTES: usize = 1200;
const MAX_RENDERED_PATH_BYTES: usize = 700;
const MAX_MARKUP_CHUNK_BYTES: usize = 2000;
const MAX_PATH_COMPONENTS: usize = 8;
const MAX_PART_LABEL_BYTES: usize = 32;
const MAX_EXTRACTED_MARKUP_CHUNKS: usize = 10_000;
const SVG_NAMESPACE_URI: &str = "http://www.w3.org/2000/svg";

struct ElementFrame {
    qualified_name: String,
    local_name: String,
    path: String,
    attributes: Vec<(String, String)>,
    text: String,
    pending_space: bool,
    has_direct_text: bool,
    has_element_children: bool,
    capture_descendant_text: bool,
    hard_suppressed: bool,
    visibility_hidden: bool,
    suppressed: bool,
    start_offset: usize,
    start_tag_end_offset: usize,
}

#[derive(Clone, Copy, Default)]
enum SvgVisibility {
    #[default]
    Inherit,
    Visible,
    Hidden,
}

#[derive(Default)]
struct SvgAttributeState {
    hard_suppressed: bool,
    visibility: SvgVisibility,
}

#[derive(Default)]
struct SvgStyleState {
    display_none: Option<(bool, bool)>,
    visibility: Option<(SvgVisibility, bool)>,
}

enum CollectionMode<'a> {
    Prefix(usize),
    Selected(&'a [usize]),
}

struct ChunkCollector<'a> {
    mode: CollectionMode<'a>,
    next_selected: usize,
    candidate_count: usize,
    chunks: Vec<CodeChunk>,
}

impl<'a> ChunkCollector<'a> {
    fn prefix(limit: usize) -> Self {
        Self {
            mode: CollectionMode::Prefix(limit),
            next_selected: 0,
            candidate_count: 0,
            chunks: Vec::with_capacity(limit),
        }
    }

    fn selected(indices: &'a [usize]) -> Self {
        Self {
            mode: CollectionMode::Selected(indices),
            next_selected: 0,
            candidate_count: 0,
            chunks: Vec::with_capacity(indices.len()),
        }
    }

    fn push(&mut self, create_chunk: impl FnOnce() -> CodeChunk) {
        let candidate_index = self.candidate_count;
        self.candidate_count += 1;
        let (should_collect, advance_selection) = match &self.mode {
            CollectionMode::Prefix(limit) => (candidate_index < *limit, false),
            CollectionMode::Selected(indices) => (
                indices.get(self.next_selected) == Some(&candidate_index),
                true,
            ),
        };
        if should_collect {
            self.chunks.push(create_chunk());
            if advance_selection {
                self.next_selected += 1;
            }
        }
    }
}

pub fn extract_markup_chunks(
    content: &str,
    language: &Language,
    max_chunks: Option<usize>,
) -> Result<Vec<CodeChunk>> {
    validate_xml_characters(content)?;
    validate_namespace_declarations(content)?;
    let line_starts = collect_line_starts(content);
    let limit = max_chunks
        .unwrap_or(MAX_EXTRACTED_MARKUP_CHUNKS)
        .min(MAX_EXTRACTED_MARKUP_CHUNKS);
    let mut first_pass = ChunkCollector::prefix(limit);
    parse_markup(content, language, &line_starts, &mut first_pass)?;
    if first_pass.candidate_count <= limit {
        return Ok(first_pass.chunks);
    }
    if limit == 0 {
        return Ok(Vec::new());
    }

    let selected_indices = representative_indices(first_pass.candidate_count, limit);
    let mut collector = ChunkCollector::selected(&selected_indices);
    parse_markup(content, language, &line_starts, &mut collector)?;
    debug_assert_eq!(collector.candidate_count, first_pass.candidate_count);
    Ok(collector.chunks)
}

fn parse_markup(
    content: &str,
    language: &Language,
    line_starts: &[usize],
    collector: &mut ChunkCollector<'_>,
) -> Result<()> {
    let is_svg = *language == Language::Svg;
    let bom_offset = usize::from(content.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    let mut reader = NsReader::from_str(content);
    reader.config_mut().check_comments = true;
    let mut stack: Vec<ElementFrame> = Vec::new();
    let mut active_svg_text_index: Option<usize> = None;
    let mut root_seen = false;
    let mut implicit_svg_namespace = false;
    let mut declaration_allowed = true;
    let mut doctype_seen = false;
    let mut doctype_root_name: Option<String> = None;

    loop {
        let event_start =
            source_offset(reader.buffer_position() as usize, bom_offset, content.len());
        let (namespace, event) = reader.read_resolved_event()?;
        if let Event::Start(start) | Event::Empty(start) = &event {
            validate_name(start.name().into_inner(), "element")?;
        }
        let root_element_event =
            !root_seen && stack.is_empty() && matches!(&event, Event::Start(_) | Event::Empty(_));
        let (namespace_is_svg, namespace_is_unbound) = match namespace {
            ResolveResult::Bound(_) if !is_svg => (false, false),
            ResolveResult::Bound(namespace) => {
                let raw_namespace = namespace.as_ref();
                let matches_svg = raw_namespace == SVG_NAMESPACE_URI
                    || (raw_namespace.contains('&')
                        && decode_attribute_value(raw_namespace)? == SVG_NAMESPACE_URI);
                (matches_svg, false)
            }
            ResolveResult::Unbound => (implicit_svg_namespace || root_element_event, true),
            ResolveResult::Unknown(_) => {
                return Err(anyhow!(
                    "Markup element uses an undeclared namespace prefix"
                ));
            }
        };
        let event_end = source_offset(reader.buffer_position() as usize, bom_offset, content.len());

        match event {
            Event::Start(start) => {
                declaration_allowed = false;
                let namespace_is_svg = namespace_is_svg
                    && !(is_svg
                        && !root_element_event
                        && namespace_is_unbound
                        && declares_empty_default_namespace(&start)?);
                validate_start(
                    &start,
                    &stack,
                    &mut root_seen,
                    is_svg,
                    namespace_is_svg,
                    doctype_root_name.as_deref(),
                )?;
                if root_element_event && is_svg && namespace_is_unbound {
                    implicit_svg_namespace = true;
                }
                if stack.len() >= MAX_MARKUP_DEPTH {
                    return Err(anyhow!(
                        "Markup nesting exceeds the supported depth of {MAX_MARKUP_DEPTH}"
                    ));
                }
                if let Some(parent) = stack.last_mut() {
                    parent.has_element_children = true;
                }
                let frame = create_frame(
                    &start,
                    &stack,
                    reader.resolver(),
                    is_svg,
                    namespace_is_svg,
                    active_svg_text_index.is_some(),
                    (event_start, event_end),
                )?;
                stack.push(frame);
                if stack
                    .last()
                    .is_some_and(|frame| frame.capture_descendant_text)
                {
                    active_svg_text_index = Some(stack.len() - 1);
                }
            }
            Event::Empty(start) => {
                declaration_allowed = false;
                let namespace_is_svg = namespace_is_svg
                    && !(is_svg
                        && !root_element_event
                        && namespace_is_unbound
                        && declares_empty_default_namespace(&start)?);
                validate_start(
                    &start,
                    &stack,
                    &mut root_seen,
                    is_svg,
                    namespace_is_svg,
                    doctype_root_name.as_deref(),
                )?;
                if root_element_event && is_svg && namespace_is_unbound {
                    implicit_svg_namespace = true;
                }
                if stack.len() >= MAX_MARKUP_DEPTH {
                    return Err(anyhow!(
                        "Markup nesting exceeds the supported depth of {MAX_MARKUP_DEPTH}"
                    ));
                }
                if let Some(parent) = stack.last_mut() {
                    parent.has_element_children = true;
                }
                let frame = create_frame(
                    &start,
                    &stack,
                    reader.resolver(),
                    is_svg,
                    namespace_is_svg,
                    active_svg_text_index.is_some(),
                    (event_start, event_end),
                )?;
                finish_frame(
                    frame,
                    event_end,
                    line_starts,
                    content.len(),
                    language,
                    is_svg,
                    collector,
                );
            }
            Event::End(end) => {
                declaration_allowed = false;
                let frame = stack
                    .pop()
                    .ok_or_else(|| anyhow!("Markup contains an unexpected closing element"))?;
                if end.name().into_inner() != frame.qualified_name {
                    return Err(anyhow!(
                        "Markup closing element </{}> does not match <{}>",
                        end.name().into_inner(),
                        frame.qualified_name
                    ));
                }
                if frame.capture_descendant_text {
                    active_svg_text_index = None;
                }
                finish_frame(
                    frame,
                    event_end,
                    line_starts,
                    content.len(),
                    language,
                    is_svg,
                    collector,
                );
            }
            Event::Text(text) => {
                let value = text.xml10_content();
                if value.contains("]]>") {
                    return Err(anyhow!(
                        "Markup character data contains the forbidden sequence ]]>"
                    ));
                }
                if !value.is_empty() {
                    declaration_allowed = false;
                }
                if stack.is_empty() {
                    if !trim_xml_whitespace(&value).is_empty() {
                        return Err(anyhow!("Markup contains text outside the root element"));
                    }
                } else {
                    append_event_text(&mut stack, is_svg, active_svg_text_index, &value);
                }
            }
            Event::CData(text) => {
                declaration_allowed = false;
                if stack.is_empty() {
                    return Err(anyhow!("Markup contains CDATA outside the root element"));
                }
                append_event_text(
                    &mut stack,
                    is_svg,
                    active_svg_text_index,
                    &text.xml10_content(),
                );
            }
            Event::GeneralRef(reference) => {
                declaration_allowed = false;
                stack.last().ok_or_else(|| {
                    anyhow!("Markup contains an entity reference outside the root element")
                })?;
                let value = resolve_reference(&reference)?;
                append_event_text(&mut stack, is_svg, active_svg_text_index, &value);
            }
            Event::Decl(declaration) => {
                if !declaration_allowed || root_seen || !stack.is_empty() {
                    return Err(anyhow!(
                        "Markup XML declaration must be the first document construct"
                    ));
                }
                validate_xml_declaration(&declaration)?;
                declaration_allowed = false;
            }
            Event::DocType(doctype) => {
                declaration_allowed = false;
                if doctype_seen || root_seen || !stack.is_empty() {
                    return Err(anyhow!(
                        "Markup document type must appear at most once before the root element"
                    ));
                }
                doctype_seen = true;
                doctype_root_name = Some(parse_doctype_root_name(&doctype.xml10_content())?);
            }
            Event::PI(instruction) => {
                declaration_allowed = false;
                validate_name(instruction.target(), "processing instruction target")?;
                if instruction.target().eq_ignore_ascii_case("xml") {
                    return Err(anyhow!(
                        "Markup processing instruction target XML is reserved"
                    ));
                }
            }
            Event::Comment(_) => {
                declaration_allowed = false;
            }
            Event::Eof => {
                if !stack.is_empty() {
                    return Err(anyhow!("Markup ended before all elements were closed"));
                }
                if !root_seen {
                    return Err(anyhow!("Markup does not contain a root element"));
                }
                break;
            }
        }
    }

    Ok(())
}

fn validate_start(
    start: &BytesStart<'_>,
    stack: &[ElementFrame],
    root_seen: &mut bool,
    is_svg: bool,
    namespace_is_svg: bool,
    doctype_root_name: Option<&str>,
) -> Result<()> {
    if !stack.is_empty() {
        return Ok(());
    }
    if *root_seen {
        return Err(anyhow!("Markup contains more than one root element"));
    }
    if doctype_root_name.is_some_and(|name| name != start.name().into_inner()) {
        return Err(anyhow!(
            "Markup document type root does not match the document root element"
        ));
    }
    if is_svg {
        if start.local_name().into_inner() != "svg" {
            return Err(anyhow!("SVG documents must use <svg> as the root element"));
        }
        validate_svg_root_namespace(start)?;
        if !namespace_is_svg {
            return Err(anyhow!("SVG root namespace must be {SVG_NAMESPACE_URI}"));
        }
    }
    *root_seen = true;
    Ok(())
}

fn create_frame(
    start: &BytesStart<'_>,
    stack: &[ElementFrame],
    namespace_resolver: &NamespaceResolver,
    is_svg: bool,
    namespace_is_svg: bool,
    has_active_svg_text: bool,
    source_offsets: (usize, usize),
) -> Result<ElementFrame> {
    let qualified_name = start.name().into_inner();
    let qualified_name = qualified_name.to_string();
    let local_name = start.local_name().into_inner().to_string();
    let (attributes, attribute_state) =
        collect_attributes(start, namespace_resolver, is_svg, namespace_is_svg)?;
    let parent_hard_suppressed = stack.last().is_some_and(|parent| parent.hard_suppressed);
    let parent_visibility_hidden = stack.last().is_some_and(|parent| parent.visibility_hidden);
    let hard_suppressed = is_svg
        && (parent_hard_suppressed
            || !namespace_is_svg
            || is_non_rendered_svg_container(&local_name)
            || attribute_state.hard_suppressed);
    let visibility_hidden = is_svg
        && match attribute_state.visibility {
            SvgVisibility::Inherit => parent_visibility_hidden,
            SvgVisibility::Visible => false,
            SvgVisibility::Hidden => true,
        };
    let suppressed = hard_suppressed || visibility_hidden;
    let capture_descendant_text =
        is_svg && !hard_suppressed && is_svg_text_element(&local_name) && !has_active_svg_text;
    let path = if is_svg {
        String::new()
    } else {
        render_path(stack, &qualified_name)
    };

    Ok(ElementFrame {
        qualified_name,
        local_name,
        path,
        attributes,
        text: String::new(),
        pending_space: false,
        has_direct_text: false,
        has_element_children: false,
        capture_descendant_text,
        hard_suppressed,
        visibility_hidden,
        suppressed,
        start_offset: source_offsets.0,
        start_tag_end_offset: source_offsets.1,
    })
}

fn collect_attributes(
    start: &BytesStart<'_>,
    namespace_resolver: &NamespaceResolver,
    is_svg: bool,
    namespace_is_svg: bool,
) -> Result<(Vec<(String, String)>, SvgAttributeState)> {
    let mut attributes = Vec::new();
    let mut seen_names = HashSet::new();
    let mut rendered_bytes = 0;
    let mut state = SvgAttributeState::default();
    let mut presentation_display_none = false;
    let mut inline_style = SvgStyleState::default();

    for (index, attribute) in start.attributes().with_checks(false).enumerate() {
        if index >= MAX_ATTRIBUTES_PER_ELEMENT {
            return Err(anyhow!(
                "Markup element exceeds the supported limit of {MAX_ATTRIBUTES_PER_ELEMENT} attributes"
            ));
        }

        let attribute = attribute?;
        let name = attribute.key.into_inner();
        if attribute.value.contains('<') {
            return Err(anyhow!(
                "Markup attribute {name:?} contains a literal < character"
            ));
        }
        validate_name(name, "attribute")?;
        if !is_namespace_attribute(name)
            && matches!(
                namespace_resolver.resolve_attribute(attribute.key).0,
                ResolveResult::Unknown(_)
            )
        {
            return Err(anyhow!(
                "Markup attribute uses an undeclared namespace prefix"
            ));
        }
        if !seen_names.insert(name.to_string()) {
            return Err(anyhow!(
                "Markup element contains duplicate attribute {name:?}"
            ));
        }
        validate_attribute_references(&attribute.value)?;
        let suppression_attribute =
            is_svg && namespace_is_svg && is_svg_suppression_attribute_name(name);
        let retained_attribute = !is_namespace_attribute(name)
            && (!is_svg || (namespace_is_svg && is_svg_accessibility_attribute(name)));
        if !suppression_attribute && !retained_attribute {
            continue;
        }
        if attribute.value.len() > MAX_ATTRIBUTE_SOURCE_BYTES {
            state.hard_suppressed |= suppression_attribute;
            continue;
        }

        let decoded_value = decode_attribute_value(&attribute.value)?;
        if suppression_attribute {
            match name {
                "aria-hidden" => {
                    state.hard_suppressed |= is_svg_aria_hidden(&decoded_value);
                }
                "display" => {
                    presentation_display_none = is_svg_display_none(&decoded_value);
                }
                "visibility" => {
                    state.visibility = parse_svg_visibility(&decoded_value).unwrap_or_default();
                }
                "style" => {
                    inline_style = parse_svg_style(&decoded_value);
                }
                _ => {}
            }
        }
        if !retained_attribute {
            continue;
        }

        let value = normalize_whitespace(&decoded_value);
        if value.is_empty() || value.len() > MAX_ATTRIBUTE_VALUE_BYTES {
            continue;
        }
        let value = escape_rendered_attribute_value(&value);
        let rendered_length = name.len() + value.len() + 4;
        if rendered_bytes + rendered_length > MAX_RENDERED_ATTRIBUTES_BYTES {
            continue;
        }
        rendered_bytes += rendered_length;
        attributes.push((name.to_string(), value));
    }

    state.hard_suppressed |= inline_style
        .display_none
        .map(|(display_none, _)| display_none)
        .unwrap_or(presentation_display_none);
    state.visibility = inline_style
        .visibility
        .map(|(visibility, _)| visibility)
        .unwrap_or(state.visibility);

    Ok((attributes, state))
}

#[allow(clippy::too_many_arguments)]
fn finish_frame(
    frame: ElementFrame,
    end_offset: usize,
    line_starts: &[usize],
    content_length: usize,
    language: &Language,
    is_svg: bool,
    collector: &mut ChunkCollector<'_>,
) {
    let should_emit = if frame.hard_suppressed {
        false
    } else if is_svg {
        (frame.capture_descendant_text && !frame.text.is_empty())
            || (!frame.visibility_hidden && !frame.attributes.is_empty())
    } else {
        frame.has_direct_text || !frame.attributes.is_empty() || !frame.has_element_children
    };

    if should_emit {
        let label = if is_svg {
            frame.local_name.as_str()
        } else {
            frame.path.as_str()
        };
        let prefix = render_prefix(label, &frame.attributes);
        let semantic_text = if !is_svg || frame.capture_descendant_text {
            frame.text.as_str()
        } else {
            ""
        };
        let source_end = if is_svg && !frame.capture_descendant_text {
            frame.start_tag_end_offset
        } else {
            end_offset
        };
        push_record_chunks(
            &prefix,
            semantic_text,
            frame.start_offset,
            source_end,
            line_starts,
            content_length,
            language,
            &frame.local_name,
            collector,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn push_record_chunks(
    prefix: &str,
    text: &str,
    start_offset: usize,
    end_offset: usize,
    line_starts: &[usize],
    content_length: usize,
    language: &Language,
    name: &str,
    collector: &mut ChunkCollector<'_>,
) {
    let (start_line, start_col) = source_position(line_starts, start_offset, content_length);
    let (end_line, end_col) = source_position(line_starts, end_offset, content_length);
    let available_text_bytes = MAX_MARKUP_CHUNK_BYTES
        .saturating_sub(prefix.len() + 2 + MAX_PART_LABEL_BYTES)
        .max(1);
    let text_parts = split_text(text, available_text_bytes);

    if text_parts.is_empty() {
        collector.push(|| {
            create_chunk(
                prefix.to_string(),
                start_line,
                start_col,
                end_line,
                end_col,
                language,
                name,
            )
        });
        return;
    }

    let part_count = text_parts.len();
    for (part_index, part) in text_parts.into_iter().enumerate() {
        collector.push(|| {
            let content = if part_count == 1 {
                format!("{prefix}: {part}")
            } else {
                format!("{prefix} [part {}/{}]: {part}", part_index + 1, part_count)
            };
            create_chunk(
                content, start_line, start_col, end_line, end_col, language, name,
            )
        });
    }
}

fn create_chunk(
    content: String,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
    language: &Language,
    name: &str,
) -> CodeChunk {
    CodeChunk {
        content,
        start_line,
        start_col,
        end_line,
        end_col,
        chunk_type: "element".to_string(),
        name: Some(name.to_string()),
        language: language.as_str().to_string(),
    }
}

fn render_path(stack: &[ElementFrame], qualified_name: &str) -> String {
    let mut components = vec![qualified_name];
    let mut rendered_bytes = qualified_name.len();
    for frame in stack.iter().rev().take(MAX_PATH_COMPONENTS - 1) {
        let additional_bytes = frame.qualified_name.len() + 1;
        if rendered_bytes + additional_bytes > MAX_RENDERED_PATH_BYTES {
            break;
        }
        components.push(&frame.qualified_name);
        rendered_bytes += additional_bytes;
    }
    components.reverse();
    components.join("/")
}

fn render_prefix(label: &str, attributes: &[(String, String)]) -> String {
    if attributes.is_empty() {
        return label.to_string();
    }

    let attributes = attributes
        .iter()
        .map(|(name, value)| format!("{name}=\"{value}\""))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{label} [{attributes}]")
}

fn parse_doctype_root_name(value: &str) -> Result<String> {
    let value = trim_xml_whitespace(value);
    let name = value
        .split(|character| is_xml_whitespace(character) || character == '[')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow!("Markup document type must name a root element"))?;
    validate_name(name, "document type root")?;
    Ok(name.to_string())
}

fn validate_xml_declaration(declaration: &BytesDecl<'_>) -> Result<()> {
    let declaration = BytesStart::from_content(declaration.as_ref(), 3);
    let mut attribute_index = 0;
    let mut encoding_seen = false;

    for attribute in declaration.attributes().with_checks(false) {
        if attribute_index >= 3 {
            return Err(anyhow!(
                "Markup XML declaration contains too many attributes"
            ));
        }
        let attribute = attribute?;
        let name = attribute.key.into_inner();
        if attribute.value.contains('<') {
            return Err(anyhow!(
                "Markup XML declaration attribute {name:?} contains a literal < character"
            ));
        }
        if attribute.value.len() > MAX_ATTRIBUTE_VALUE_BYTES {
            return Err(anyhow!(
                "Markup XML declaration attribute value exceeds the supported limit"
            ));
        }
        validate_attribute_references(&attribute.value)?;
        let value = decode_attribute_value(&attribute.value)?;

        match (attribute_index, name) {
            (0, "version") if value == "1.0" => {}
            (0, "version") => {
                return Err(anyhow!("Markup supports XML version 1.0 declarations only"));
            }
            (0, _) => {
                return Err(anyhow!(
                    "Markup XML declaration must begin with version=\"1.0\""
                ));
            }
            (1, "encoding") if is_valid_xml_encoding_name(&value) => {
                encoding_seen = true;
            }
            (1, "encoding") => {
                return Err(anyhow!("Markup XML declaration encoding name is invalid"));
            }
            (1, "standalone") if matches!(value.as_str(), "yes" | "no") => {}
            (2, "standalone") if encoding_seen && matches!(value.as_str(), "yes" | "no") => {}
            (_, "standalone") if !matches!(value.as_str(), "yes" | "no") => {
                return Err(anyhow!(
                    "Markup XML declaration standalone value must be yes or no"
                ));
            }
            _ => {
                return Err(anyhow!(
                    "Markup XML declaration attributes are invalid or out of order"
                ));
            }
        }
        attribute_index += 1;
    }

    if attribute_index == 0 {
        return Err(anyhow!(
            "Markup XML declaration must begin with version=\"1.0\""
        ));
    }
    Ok(())
}

fn is_valid_xml_encoding_name(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn validate_xml_characters(content: &str) -> Result<()> {
    if let Some(character) = content
        .chars()
        .find(|character| !is_valid_xml_character(*character))
    {
        return Err(anyhow!(
            "Markup contains the literal character U+{:04X}, which is invalid in XML 1.0",
            character as u32
        ));
    }
    Ok(())
}

fn validate_name(name: &str, kind: &str) -> Result<()> {
    if name.len() > MAX_ELEMENT_NAME_BYTES {
        return Err(anyhow!(
            "Markup {kind} name exceeds the supported limit of {MAX_ELEMENT_NAME_BYTES} bytes"
        ));
    }
    let mut parts = name.split(':');
    let first = parts.next().unwrap_or("");
    let second = parts.next();
    if first.is_empty()
        || second.is_some_and(str::is_empty)
        || parts.next().is_some()
        || !is_valid_xml_name_part(first)
        || second.is_some_and(|part| !is_valid_xml_name_part(part))
    {
        return Err(anyhow!(
            "Markup {kind} name {name:?} is not a valid XML qualified name"
        ));
    }
    Ok(())
}

fn is_valid_xml_name_part(name: &str) -> bool {
    let mut characters = name.chars();
    characters.next().is_some_and(is_xml_name_start_character)
        && characters.all(is_xml_name_character)
}

fn is_xml_name_start_character(character: char) -> bool {
    matches!(character, 'A'..='Z' | '_' | 'a'..='z')
        || matches!(
            character as u32,
            0xc0..=0xd6
                | 0xd8..=0xf6
                | 0xf8..=0x2ff
                | 0x370..=0x37d
                | 0x37f..=0x1fff
                | 0x200c..=0x200d
                | 0x2070..=0x218f
                | 0x2c00..=0x2fef
                | 0x3001..=0xd7ff
                | 0xf900..=0xfdcf
                | 0xfdf0..=0xfffd
                | 0x10000..=0xeffff
        )
}

fn is_xml_name_character(character: char) -> bool {
    is_xml_name_start_character(character)
        || matches!(character, '-' | '.' | '0'..='9' | '\u{b7}')
        || matches!(character as u32, 0x300..=0x36f | 0x203f..=0x2040)
}

fn is_valid_xml_entity_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|character| character == ':' || is_xml_name_start_character(character))
        && characters.all(|character| character == ':' || is_xml_name_character(character))
}

enum ResolvedReference<'a> {
    Character(char),
    Predefined(&'static str),
    Entity(&'a str),
}

fn validate_attribute_references(value: &str) -> Result<()> {
    let mut cursor = 0;
    while let Some(relative_ampersand) = value[cursor..].find('&') {
        let reference_start = cursor + relative_ampersand + 1;
        let relative_semicolon = value[reference_start..]
            .find(';')
            .ok_or_else(|| anyhow!("Markup attribute contains an unterminated entity reference"))?;
        let semicolon = reference_start + relative_semicolon;
        let reference = &value[reference_start..semicolon];
        if reference.is_empty() {
            return Err(anyhow!(
                "Markup attribute contains an empty entity reference"
            ));
        }
        parse_reference(reference)?;
        cursor = semicolon + 1;
    }
    Ok(())
}

fn decode_attribute_value(value: &str) -> Result<String> {
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0;

    while let Some(relative_ampersand) = value[cursor..].find('&') {
        let ampersand = cursor + relative_ampersand;
        decoded.push_str(&value[cursor..ampersand]);
        let reference_start = ampersand + 1;
        let relative_semicolon = value[reference_start..]
            .find(';')
            .ok_or_else(|| anyhow!("Markup attribute contains an unterminated entity reference"))?;
        let semicolon = reference_start + relative_semicolon;
        let reference = &value[reference_start..semicolon];
        if reference.is_empty() {
            return Err(anyhow!(
                "Markup attribute contains an empty entity reference"
            ));
        }
        decoded.push_str(&resolve_reference_str(reference)?);
        cursor = semicolon + 1;
    }

    decoded.push_str(&value[cursor..]);
    Ok(decoded)
}

fn resolve_reference(reference: &BytesRef<'_>) -> Result<String> {
    resolve_reference_str(reference.as_ref())
}

fn resolve_reference_str(reference: &str) -> Result<String> {
    match parse_reference(reference)? {
        ResolvedReference::Character(character) => Ok(character.to_string()),
        ResolvedReference::Predefined(value) => Ok(value.to_string()),
        ResolvedReference::Entity(name) => Ok(format!("&{name};")),
    }
}

fn parse_reference(reference: &str) -> Result<ResolvedReference<'_>> {
    if reference.len() > MAX_ENTITY_REFERENCE_BYTES {
        return Err(anyhow!(
            "Markup entity reference exceeds the supported limit of {MAX_ENTITY_REFERENCE_BYTES} bytes"
        ));
    }
    let encoded_reference = BytesRef::new(reference);
    if let Some(character) = encoded_reference.resolve_char_ref()? {
        if !is_valid_xml_character(character) {
            return Err(anyhow!(
                "Markup contains a character reference that is invalid in XML 1.0"
            ));
        }
        return Ok(ResolvedReference::Character(character));
    }
    if let Some(value) = resolve_predefined_entity(encoded_reference.as_ref()) {
        return Ok(ResolvedReference::Predefined(value));
    }
    if !is_valid_xml_entity_name(reference) {
        return Err(anyhow!("Markup entity reference name is invalid"));
    }
    Ok(ResolvedReference::Entity(reference))
}

fn is_valid_xml_character(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{a}' | '\u{d}')
        || matches!(character as u32, 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)
}

fn append_event_text(
    stack: &mut [ElementFrame],
    is_svg: bool,
    active_svg_text_index: Option<usize>,
    value: &str,
) {
    if is_svg {
        if stack.last().is_some_and(|frame| frame.suppressed) {
            return;
        }
        if let Some(frame) = active_svg_text_index.and_then(|index| stack.get_mut(index)) {
            append_raw_text(frame, value);
        }
    } else if let Some(frame) = stack.last_mut() {
        append_raw_text(frame, value);
    }
}

fn append_raw_text(frame: &mut ElementFrame, value: &str) {
    let leading_space = value.chars().next().is_some_and(is_xml_whitespace);
    let trailing_space = value.chars().next_back().is_some_and(is_xml_whitespace);
    let normalized = normalize_whitespace(value);
    if !normalized.is_empty() {
        frame.has_direct_text = true;
    }
    append_text_piece(frame, &normalized, leading_space, trailing_space);
}

fn append_text_piece(
    frame: &mut ElementFrame,
    value: &str,
    leading_space: bool,
    trailing_space: bool,
) {
    if value.is_empty() {
        if !frame.text.is_empty() {
            frame.pending_space |= leading_space || trailing_space;
        }
        return;
    }

    if !frame.text.is_empty() && (frame.pending_space || leading_space) {
        frame.text.push(' ');
    }
    frame.text.push_str(value);
    frame.pending_space = trailing_space;
}

fn normalize_whitespace(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if is_xml_whitespace(character) {
            pending_space = !normalized.is_empty();
        } else {
            if pending_space {
                normalized.push(' ');
                pending_space = false;
            }
            normalized.push(character);
        }
    }
    normalized
}

fn split_text(value: &str, max_bytes: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut remaining = trim_xml_whitespace(value);
    while remaining.len() > max_bytes {
        let mut split_at = remaining
            .char_indices()
            .take_while(|(index, _)| *index <= max_bytes)
            .filter_map(|(index, character)| is_xml_whitespace(character).then_some(index))
            .last()
            .unwrap_or_else(|| {
                remaining
                    .char_indices()
                    .take_while(|(index, _)| *index <= max_bytes)
                    .map(|(index, _)| index)
                    .last()
                    .unwrap_or(remaining.len())
            });
        if split_at == 0 {
            split_at = remaining
                .char_indices()
                .nth(1)
                .map(|(index, _)| index)
                .unwrap_or(remaining.len());
        }
        parts.push(trim_xml_whitespace(&remaining[..split_at]));
        remaining = trim_xml_whitespace_start(&remaining[split_at..]);
    }
    if !remaining.is_empty() {
        parts.push(remaining);
    }
    parts
}

fn is_xml_whitespace(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\r' | '\n')
}

fn trim_xml_whitespace(value: &str) -> &str {
    value.trim_matches(is_xml_whitespace)
}

fn trim_xml_whitespace_start(value: &str) -> &str {
    value.trim_start_matches(is_xml_whitespace)
}

fn escape_rendered_attribute_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '"') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn representative_indices(candidate_count: usize, limit: usize) -> Vec<usize> {
    if candidate_count == 0 || limit == 0 {
        return Vec::new();
    }
    if candidate_count <= limit {
        return (0..candidate_count).collect();
    }
    if limit == 1 {
        return vec![(candidate_count - 1) / 2];
    }

    let source_span = (candidate_count - 1) as u128;
    let selected_span = (limit - 1) as u128;
    (0..limit)
        .map(|index| {
            let numerator = index as u128 * source_span;
            ((numerator * 2 + selected_span) / (selected_span * 2)) as usize
        })
        .collect()
}

fn collect_line_starts(content: &str) -> Vec<usize> {
    let bytes = content.as_bytes();
    let mut starts = vec![0];
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                index += 1;
                if bytes.get(index) == Some(&b'\n') {
                    index += 1;
                }
                starts.push(index);
            }
            b'\n' => {
                index += 1;
                starts.push(index);
            }
            _ => index += 1,
        }
    }
    starts
}

fn source_offset(reader_offset: usize, bom_offset: usize, content_length: usize) -> usize {
    reader_offset.saturating_add(bom_offset).min(content_length)
}

fn source_position(line_starts: &[usize], offset: usize, content_length: usize) -> (u32, u32) {
    let offset = offset.min(content_length);
    let line_index = line_starts
        .partition_point(|line_start| *line_start <= offset)
        .saturating_sub(1);
    (
        line_index as u32 + 1,
        (offset - line_starts[line_index]) as u32,
    )
}

fn is_namespace_attribute(name: &str) -> bool {
    name == "xmlns" || name.starts_with("xmlns:")
}

fn validate_namespace_declarations(content: &str) -> Result<()> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().check_comments = true;

    loop {
        match reader.read_event()? {
            Event::Start(start) | Event::Empty(start) => {
                for attribute in start.attributes().with_checks(false) {
                    let attribute = attribute?;
                    let name = attribute.key.into_inner();
                    if !is_namespace_attribute(name) {
                        continue;
                    }
                    validate_name(name, "attribute")?;
                    if attribute.value.len() > MAX_ATTRIBUTE_SOURCE_BYTES {
                        return Err(anyhow!("Markup namespace URI exceeds the supported limit"));
                    }
                    if attribute.value.contains('<') {
                        return Err(anyhow!(
                            "Markup namespace attribute {name:?} contains a literal < character"
                        ));
                    }
                    validate_attribute_references(&attribute.value)?;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(())
}

fn declares_empty_default_namespace(start: &BytesStart<'_>) -> Result<bool> {
    for attribute in start.attributes().with_checks(false) {
        let attribute = attribute?;
        if attribute.key.into_inner() == "xmlns" && attribute.value.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_svg_root_namespace(start: &BytesStart<'_>) -> Result<()> {
    let qualified_name = start.name().into_inner();
    let namespace_attribute = qualified_name
        .split_once(':')
        .map(|(prefix, _)| format!("xmlns:{prefix}"))
        .unwrap_or_else(|| "xmlns".to_string());
    let mut declared_namespace = None;

    for attribute in start.attributes().with_checks(false) {
        let attribute = attribute?;
        if attribute.key.into_inner() != namespace_attribute {
            continue;
        }
        if attribute.value.len() > MAX_ATTRIBUTE_SOURCE_BYTES {
            return Err(anyhow!(
                "SVG root namespace URI exceeds the supported limit"
            ));
        }
        declared_namespace = Some(decode_attribute_value(&attribute.value)?);
        break;
    }

    if qualified_name.contains(':') && declared_namespace.is_none() {
        return Err(anyhow!(
            "Prefixed SVG root elements must declare the SVG namespace"
        ));
    }
    if declared_namespace
        .as_deref()
        .is_some_and(|namespace| namespace != SVG_NAMESPACE_URI)
    {
        return Err(anyhow!("SVG root namespace must be {SVG_NAMESPACE_URI}"));
    }
    Ok(())
}

fn is_svg_suppression_attribute_name(name: &str) -> bool {
    matches!(name, "aria-hidden" | "display" | "visibility" | "style")
}

fn is_svg_aria_hidden(value: &str) -> bool {
    trim_xml_whitespace(value).eq_ignore_ascii_case("true")
}

fn is_svg_display_none(value: &str) -> bool {
    trim_xml_whitespace(value).eq_ignore_ascii_case("none")
}

fn parse_svg_visibility(value: &str) -> Option<SvgVisibility> {
    match trim_xml_whitespace(value).to_ascii_lowercase().as_str() {
        "visible" | "initial" => Some(SvgVisibility::Visible),
        "inherit" | "unset" | "revert" | "revert-layer" => Some(SvgVisibility::Inherit),
        "hidden" | "collapse" => Some(SvgVisibility::Hidden),
        _ => None,
    }
}

// Validate literal display values before applying the inline cascade. Unknown
// values must not erase an earlier declaration or presentation attribute.
fn parse_svg_display(value: &str) -> Option<bool> {
    let value = trim_xml_whitespace(value).to_ascii_lowercase();
    match value.as_str() {
        "none" => return Some(true),
        "contents"
        | "inherit"
        | "initial"
        | "unset"
        | "revert"
        | "revert-layer"
        | "inline-block"
        | "inline-table"
        | "inline-flex"
        | "inline-grid"
        | "grid-lanes"
        | "inline-grid-lanes"
        | "table-row-group"
        | "table-header-group"
        | "table-footer-group"
        | "table-row"
        | "table-cell"
        | "table-column-group"
        | "table-column"
        | "table-caption"
        | "ruby-base"
        | "ruby-text"
        | "ruby-base-container"
        | "ruby-text-container" => return Some(false),
        _ => {}
    }
    let mut outside = None;
    let mut inside = None;
    let mut list_item = false;
    for keyword in value.split_ascii_whitespace() {
        match keyword {
            "block" | "inline" | "run-in" if outside.is_none() => outside = Some(keyword),
            "flow" | "flow-root" | "table" | "flex" | "grid" | "ruby" | "math"
                if inside.is_none() =>
            {
                inside = Some(keyword)
            }
            "list-item" if !list_item => list_item = true,
            _ => return None,
        }
    }
    if outside.is_none() && inside.is_none() && !list_item {
        return None;
    }
    if list_item && !matches!(inside, None | Some("flow" | "flow-root")) {
        return None;
    }
    Some(false)
}

fn parse_svg_style(value: &str) -> SvgStyleState {
    let mut state = SvgStyleState::default();
    for declaration in mask_css_strings_and_comments(value).split(';') {
        let Some((property, value, important)) = css_declaration_parts(declaration) else {
            continue;
        };
        if property.eq_ignore_ascii_case("display") {
            if let Some(display_none) = parse_svg_display(value) {
                set_css_property(&mut state.display_none, display_none, important);
            }
        } else if property.eq_ignore_ascii_case("visibility") {
            if let Some(visibility) = parse_svg_visibility(value) {
                set_css_property(&mut state.visibility, visibility, important);
            }
        }
    }
    state
}

fn css_declaration_parts(declaration: &str) -> Option<(&str, &str, bool)> {
    let (property, value) = declaration.split_once(':')?;
    let property = trim_xml_whitespace(property);
    let value = trim_xml_whitespace(value);
    let (value, important) = match value.rsplit_once('!') {
        Some((before, suffix)) if trim_xml_whitespace(suffix).eq_ignore_ascii_case("important") => {
            (trim_xml_whitespace(before), true)
        }
        _ => (value, false),
    };
    Some((property, value, important))
}

fn set_css_property<T: Copy>(slot: &mut Option<(T, bool)>, value: T, important: bool) {
    if slot.is_none_or(|(_, existing_important)| !existing_important || important) {
        *slot = Some((value, important));
    }
}

fn mask_css_strings_and_comments(value: &str) -> String {
    let mut masked = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    let mut quote = None;
    let mut escaped = false;
    let mut in_comment = false;

    while let Some(character) = characters.next() {
        if in_comment {
            masked.push(' ');
            if character == '*' && characters.next_if_eq(&'/').is_some() {
                masked.push(' ');
                in_comment = false;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            masked.push(' ');
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
            }
            continue;
        }
        if matches!(character, '\'' | '"') {
            masked.push(' ');
            quote = Some(character);
            continue;
        }
        if character == '/' && characters.next_if_eq(&'*').is_some() {
            masked.push_str("  ");
            in_comment = true;
            continue;
        }
        if character == '\\' {
            masked.push(' ');
            if characters.next().is_some() {
                masked.push(' ');
            }
            continue;
        }
        masked.push(character);
    }

    masked
}

fn is_non_rendered_svg_container(name: &str) -> bool {
    matches!(name, "defs" | "metadata" | "script" | "style")
}

fn is_svg_accessibility_attribute(name: &str) -> bool {
    name == "role" || name == "title" || name.starts_with("aria-")
}

fn is_svg_text_element(name: &str) -> bool {
    matches!(name, "text" | "title" | "desc")
}
