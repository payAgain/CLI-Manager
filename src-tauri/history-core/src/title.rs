//! Session titles use user text, while transcript content stays intact.
pub fn title_candidate_from_text(text: &str) -> Option<String> {
    let mut text = text;
    // Desktop context can be a whole user record or a prefix sharing a line
    // with the real request. Strip only recognized metadata blocks.
    loop {
        let trimmed = text.trim_start();
        let Some(tag) = title_xml_tag_name(trimmed) else {
            break;
        };
        if !is_title_noise_block_tag(&tag) || tag == "codex_internal_context" {
            break;
        }
        let close = format!("</{tag}>");
        let end = find_ascii_ci(trimmed, &close)? + close.len();
        text = &trimmed[end..];
    }
    if let Some(objective) = extract_simple_tag_block(text, "objective") {
        if let Some(candidate) = title_candidate_from_lines(objective) {
            return Some(candidate);
        }
    }
    title_candidate_from_lines(text)
}

fn extract_simple_tag_block<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

fn title_candidate_from_lines(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0usize;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("</image>")
            || is_title_noise_line(trimmed)
        {
            index += 1;
            continue;
        }

        if is_injected_prompt_title_line(trimmed) {
            return None;
        }

        if is_workflow_state_start_line(trimmed) {
            index += 1;
            while index < lines.len() && !is_workflow_state_end_line(lines[index].trim()) {
                index += 1;
            }
            if index < lines.len() {
                index += 1;
            }
            continue;
        }

        if let Some(tag) = title_xml_tag_name(trimmed) {
            if is_title_noise_block_tag(&tag) {
                index += 1;
                if !title_line_closes_tag(trimmed, &tag) {
                    while index < lines.len() && !title_line_closes_tag(lines[index].trim(), &tag) {
                        index += 1;
                    }
                    if index < lines.len() {
                        index += 1;
                    }
                }
                continue;
            }
        }

        if let Some(candidate) = image_title_candidate_from_lines(&lines, index) {
            return Some(candidate);
        }

        return Some(trimmed.to_string());
    }

    None
}

fn image_title_candidate_from_lines(lines: &[&str], start_index: usize) -> Option<String> {
    let mut image_tokens: Vec<String> = Vec::new();
    let mut text_suffix: Option<String> = None;
    let mut index = start_index;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("</image>")
            || is_title_noise_line(trimmed)
        {
            index += 1;
            continue;
        }

        let (line_images, remaining_text) = extract_image_title_parts(trimmed);
        if line_images.is_empty() {
            if image_tokens.is_empty() {
                return None;
            }
            text_suffix = Some(trimmed.to_string());
            break;
        }

        for image in line_images {
            if !image_tokens
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&image))
            {
                image_tokens.push(image);
            }
        }
        if !remaining_text.is_empty() {
            text_suffix = Some(remaining_text);
            break;
        }
        index += 1;
    }

    if image_tokens.is_empty() {
        return None;
    }

    let mut title = image_tokens.join("");
    if let Some(text) = text_suffix {
        if !text.is_empty() {
            title.push(' ');
            title.push_str(&text);
        }
    }
    Some(title)
}

fn extract_image_title_parts(line: &str) -> (Vec<String>, String) {
    let mut rest = line;
    let mut image_tokens = Vec::new();
    let mut remaining_text = String::new();

    while !rest.is_empty() {
        let tag_pos = find_ascii_ci(rest, "<image");
        let label_pos = find_ascii_ci(rest, "[image #");
        let close_pos = find_ascii_ci(rest, "</image>");
        let next_pos = [tag_pos, label_pos, close_pos].into_iter().flatten().min();

        let Some(pos) = next_pos else {
            remaining_text.push_str(rest);
            break;
        };

        remaining_text.push_str(&rest[..pos]);
        rest = &rest[pos..];

        if starts_with_ascii_ci(rest, "</image>") {
            rest = &rest["</image>".len()..];
            continue;
        }

        if starts_with_ascii_ci(rest, "<image") {
            let end = rest.find('>').map(|idx| idx + 1).unwrap_or(rest.len());
            let token = &rest[..end];
            image_tokens.push(extract_image_label(token).unwrap_or_else(|| "[Image]".to_string()));
            rest = &rest[end..];
            continue;
        }

        if starts_with_ascii_ci(rest, "[image #") {
            let end = rest.find(']').map(|idx| idx + 1).unwrap_or(rest.len());
            image_tokens.push(rest[..end].to_string());
            rest = &rest[end..];
            continue;
        }
    }

    (image_tokens, remaining_text.trim().to_string())
}

fn extract_image_label(token: &str) -> Option<String> {
    let start = find_ascii_ci(token, "[image #")?;
    let end = token[start..].find(']')? + start + 1;
    Some(token[start..end].to_string())
}

fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(needle)
}

fn starts_with_ascii_ci(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .map(|start| start.eq_ignore_ascii_case(prefix))
        .unwrap_or(false)
}

fn title_xml_tag_name(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix('<')?;
    if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
        return None;
    }
    let name: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    (!name.is_empty()).then(|| name.to_lowercase())
}

fn is_title_noise_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "codex_internal_context"
            | "external_codex_apps_open_page"
            | "send_user_message_question_reply"
            | "current-state"
            | "instructions"
            | "session-context"
            | "system-reminder"
            | "local-command-caveat"
            | "local-command-stdout"
            | "local-command-stderr"
            | "command-name"
            | "command-message"
            | "command-args"
            | "bash-input"
            | "bash-stdout"
            | "bash-stderr"
            | "workflow"
    )
}

fn title_line_closes_tag(line: &str, tag: &str) -> bool {
    line.to_lowercase().contains(&format!("</{tag}>"))
}

fn is_workflow_state_start_line(line: &str) -> bool {
    line.starts_with("[workflow-state:")
}

fn is_workflow_state_end_line(line: &str) -> bool {
    line.starts_with("[/workflow-state")
}

fn is_title_noise_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower == "<objective>"
        || lower == "</objective>"
        || lower.starts_with("knowledge cutoff:")
        || lower.starts_with("current date:")
        || lower.starts_with("continuation behavior:")
        || lower.starts_with("budget:")
}

fn is_injected_prompt_title_line(line: &str) -> bool {
    let normalized = line.trim_start_matches('#').trim().to_lowercase();
    normalized.starts_with("agents.md instructions for ")
        || normalized.starts_with("system prompt")
        || normalized.starts_with("developer instructions")
}

#[cfg(test)]
mod tests {
    use super::title_candidate_from_text;

    #[test]
    fn claude_local_command_records_are_not_session_titles() {
        for tag in [
            "local-command-caveat",
            "local-command-stdout",
            "local-command-stderr",
            "command-name",
            "command-message",
            "command-args",
            "bash-input",
            "bash-stdout",
            "bash-stderr",
        ] {
            let block = format!("<{tag}>internal command content</{tag}>");
            assert_eq!(title_candidate_from_text(&block), None, "{tag}");
            for separator in ["", "\n", "\n\n"] {
                assert_eq!(
                    title_candidate_from_text(&format!("{block}{separator}修复会话标题")),
                    Some("修复会话标题".into()),
                    "{tag}"
                );
            }
            assert_eq!(
                title_candidate_from_text(&format!("<{tag}>unfinished command")),
                None,
                "{tag}"
            );
        }
        assert_eq!(
            title_candidate_from_text("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
            None
        );
        assert_eq!(
            title_candidate_from_text("解释 <local-command-caveat> 的用途"),
            Some("解释 <local-command-caveat> 的用途".into())
        );
    }

    #[test]
    fn desktop_open_page_context_is_not_a_session_title() {
        let context =
            r#"<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>"#;
        assert_eq!(title_candidate_from_text(context), None);
        for separator in ["", "\n", "\n\n"] {
            assert_eq!(
                title_candidate_from_text(&format!("{context}{separator}修复会话标题")),
                Some("修复会话标题".into())
            );
        }
    }

    #[test]
    fn context_blocks_do_not_hide_following_user_text_or_replace_it_with_json() {
        assert_eq!(title_candidate_from_text("<external_codex_apps_open_page>\n{\"page_id\":null}\n</external_codex_apps_open_page>\n<send_user_message_question_reply>[]</send_user_message_question_reply>\n继续开发"), Some("继续开发".into()));
        assert_eq!(
            title_candidate_from_text(
                "<external_codex_apps_open_page>\nmetadata without closing tag"
            ),
            None
        );
        assert_eq!(
            title_candidate_from_text("解释 external_codex_apps_open_page 的用途"),
            Some("解释 external_codex_apps_open_page 的用途".into())
        );
        assert_eq!(
            title_candidate_from_text("<custom-task>用户的 XML 请求</custom-task>"),
            Some("<custom-task>用户的 XML 请求</custom-task>".into())
        );
    }
}
