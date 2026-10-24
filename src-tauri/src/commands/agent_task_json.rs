//! Incremental, validating projection of JSONL task records. Unknown payloads
//! (notably image data and request snapshots) cost time, never retained memory.
use serde_json::{Map, Value};

const TEXT_BYTES: usize = 16 * 1024;
const ITEM_TEXT_BYTES: usize = 512;
const PROJECTED_BYTES: usize = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_ARRAY: usize = 129; // retain an overflow witness for the task limit
const MAX_BLOCKS: usize = 128;
const NOTIFICATION_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq)]
enum Spec {
    Skip,
    Root,
    Payload,
    Source,
    Subagent,
    Spawn,
    Message,
    Blocks,
    Block,
    ResultBlocks,
    ResultBlock,
    Input,
    Items,
    Item,
    Structured,
    Task,
    File,
    Attachment,
    Exact,
    Text,
    ItemText,
    Notification,
    Arguments,
}
impl Spec {
    fn key(self, key: &str) -> Self {
        use Spec::*;
        match (self, key) {
            (Root, "type" | "sessionId" | "isSidechain" | "agentId" | "operation") => Exact,
            (Root, "payload") => Payload,
            (Root, "message") => Message,
            (Root, "toolUseResult") => Structured,
            (Root, "attachment") => Attachment,
            (Root, "content") => Notification,
            (
                Payload,
                "type" | "id" | "name" | "call_id" | "parent_thread_id" | "forked_from_id",
            ) => Exact,
            (Payload, "source") => Source,
            (Payload, "arguments") => Arguments,
            (Payload, "output") => ResultBlocks,
            (Source, "subagent") => Subagent,
            (Subagent, "thread_spawn") => Spawn,
            (Spawn, "parent_thread_id") => Exact,
            (Message, "role") => Exact,
            (Message, "content") => Blocks,
            (Block | ResultBlock, "type" | "id" | "name" | "tool_use_id" | "is_error") => Exact,
            (Block, "input") => Input,
            (Block, "content") => ResultBlocks,
            (Block, "text") => Notification,
            (ResultBlock, "text") => Text,
            (Input, "todos" | "plan") => Items,
            (
                Input,
                "status" | "taskId" | "task_id" | "session_id" | "run_in_background" | "file_path",
            ) => Exact,
            (
                Input,
                "subject" | "description" | "activeForm" | "command" | "cmd" | "justification"
                | "content" | "explanation",
            ) => Text,
            (Item, "status") => Exact,
            (Item, "content" | "activeForm" | "step") => ItemText,
            (Structured, "task") => Task,
            (Structured, "file") => File,
            (Structured, "taskId" | "backgroundTaskId" | "task_id" | "task_type" | "filePath") => {
                Exact
            }
            (Structured, "message" | "plan") => Text,
            (Task, "id" | "task_id" | "status" | "exitCode" | "exit_code") => Exact,
            (Task, "output") => Text,
            (File, "content") => Text,
            (Attachment, "type" | "commandMode") => Exact,
            (Attachment, "prompt") => Notification,
            _ => Skip,
        }
    }
    fn element(self) -> Self {
        match self {
            Self::Blocks => Self::Block,
            Self::ResultBlocks => Self::ResultBlock,
            Self::Items => Self::Item,
            _ => Self::Skip,
        }
    }
    fn string_mode(self) -> Self {
        match self {
            Self::Blocks => Self::Notification,
            Self::ResultBlocks | Self::Items => Self::Text, // plan may be a string
            Self::Source => Self::Exact,
            Self::Exact | Self::Text | Self::ItemText | Self::Notification | Self::Arguments => {
                self
            }
            _ => Self::Skip,
        }
    }
}

#[derive(Clone, Copy)]
enum Phase {
    KeyOrEnd,
    Key,
    Colon,
    ValueOrEnd,
    Value,
    CommaOrEnd,
}
struct Frame {
    spec: Spec,
    object: bool,
    phase: Phase,
    key: String,
    map: Map<String, Value>,
    array: Vec<Value>,
    retained_before: usize,
}
impl Frame {
    fn new(spec: Spec, object: bool, retained_before: usize) -> Self {
        Self {
            spec,
            object,
            phase: if object {
                Phase::KeyOrEnd
            } else {
                Phase::ValueOrEnd
            },
            key: String::new(),
            map: Map::new(),
            array: Vec::new(),
            retained_before,
        }
    }
    fn value_spec(&self) -> Spec {
        if self.object {
            self.spec.key(&self.key)
        } else {
            self.spec.element()
        }
    }
    fn finish(self) -> Option<Value> {
        if self.spec == Spec::Skip {
            return None;
        }
        let value = if self.object {
            Value::Object(self.map)
        } else {
            Value::Array(self.array)
        };
        if self.spec == Spec::Block {
            let keep = match value.get("type").and_then(Value::as_str) {
                Some("tool_result") => true,
                Some("text") => value
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty()),
                Some("tool_use") => value.get("name").and_then(Value::as_str).is_some_and(|s| {
                    matches!(
                        s,
                        "TodoWrite"
                            | "TaskCreate"
                            | "TaskUpdate"
                            | "Bash"
                            | "TaskOutput"
                            | "TaskStop"
                            | "EnterPlanMode"
                            | "ExitPlanMode"
                            | "Write"
                            | "Read"
                    )
                }),
                _ => false,
            };
            if !keep {
                return None;
            }
        }
        if self.spec == Spec::ResultBlock
            && value.get("type").and_then(Value::as_str) != Some("text")
        {
            return None;
        }
        Some(value)
    }
}

/// Only protocol notifications are retained from ordinary messages, including
/// ones appearing after megabytes of prose. Display cropping never hides state.
#[derive(Default)]
struct Notifications {
    matched: usize,
    active: Option<String>,
    close_matched: usize,
    output: String,
    count: usize,
    limited: bool,
}
impl Notifications {
    fn push(&mut self, c: char) {
        const OPEN: &[u8] = b"<task-notification>";
        const CLOSE: &[u8] = b"</task-notification>";
        if let Some(active) = self.active.as_mut() {
            if !self.limited
                && active.len() + c.len_utf8() <= NOTIFICATION_BYTES
                && self.output.len() + active.len() + c.len_utf8() <= PROJECTED_BYTES
            {
                active.push(c);
            } else {
                self.limited = true;
                active.clear();
            }
            self.close_matched = if c as u32 == CLOSE[self.close_matched] as u32 {
                self.close_matched + 1
            } else {
                usize::from(c == '<')
            };
            if self.close_matched == CLOSE.len() {
                if self.count < MAX_BLOCKS
                    && !self.limited
                    && self.output.len() + active.len() <= PROJECTED_BYTES
                {
                    self.output.push_str(active);
                    self.count += 1;
                } else {
                    self.limited = true;
                }
                self.active = None;
                self.close_matched = 0;
            }
            return;
        }
        self.matched = if c as u32 == OPEN[self.matched] as u32 {
            self.matched + 1
        } else {
            usize::from(c == '<')
        };
        if self.matched == OPEN.len() {
            self.active = Some(String::from_utf8(OPEN.to_vec()).unwrap());
            self.matched = 0;
        }
    }
}

struct Capture {
    spec: Spec,
    text: String,
    notifications: Notifications,
    arguments: Option<Box<Projector>>,
    limited: bool,
}
impl Capture {
    fn new(spec: Spec) -> Self {
        Self {
            spec,
            text: String::new(),
            notifications: Notifications::default(),
            arguments: (spec == Spec::Arguments)
                .then(|| Box::new(Projector::with_spec(Spec::Input))),
            limited: false,
        }
    }
    fn push(&mut self, c: char) {
        if let Some(args) = self.arguments.as_mut() {
            let mut bytes = [0; 4];
            for byte in c.encode_utf8(&mut bytes).bytes() {
                args.push(byte);
            }
            return;
        }
        if self.spec == Spec::Notification {
            self.notifications.push(c);
            return;
        }
        let limit = match self.spec {
            Spec::Skip => 0,
            Spec::ItemText => ITEM_TEXT_BYTES,
            _ => TEXT_BYTES,
        };
        if self.text.len() + c.len_utf8() <= limit {
            self.text.push(c);
        } else if self.spec == Spec::Exact {
            self.limited = true;
        }
    }
    fn finish(self) -> (Option<Value>, bool) {
        if let Some(args) = self.arguments {
            return match args.finish() {
                Ok(value) => (Some(value), false),
                Err(Error::Invalid) => (Some(Value::Null), false),
                Err(Error::Limit) => (None, true),
            };
        }
        if self.spec == Spec::Skip {
            return (None, false);
        }
        if self.spec == Spec::Notification {
            // An unclosed marker was never authoritative in the old parser.
            return (
                Some(Value::String(self.notifications.output)),
                self.notifications.limited,
            );
        }
        (Some(Value::String(self.text)), self.limited)
    }
}

#[derive(Clone, Copy)]
enum Escape {
    Normal,
    Slash,
    Unicode(u16, u8),
    LowSlash(u16),
    LowU(u16),
    LowUnicode(u16, u16, u8),
}
struct StringToken {
    key: bool,
    capture: Capture,
    escape: Escape,
    utf8: Vec<u8>,
    utf8_len: usize,
}
impl StringToken {
    fn new(key: bool, spec: Spec) -> Self {
        Self {
            key,
            capture: Capture::new(spec),
            escape: Escape::Normal,
            utf8: Vec::with_capacity(4),
            utf8_len: 0,
        }
    }
    // Ok(true) means the closing quote. No token grows with raw string length.
    fn push(&mut self, b: u8) -> Result<bool, ()> {
        if self.utf8_len > 0 {
            if b & 0xc0 != 0x80 {
                return Err(());
            }
            self.utf8.push(b);
            if self.utf8.len() == self.utf8_len {
                let c = std::str::from_utf8(&self.utf8)
                    .map_err(|_| ())?
                    .chars()
                    .next()
                    .ok_or(())?;
                self.capture.push(c);
                self.utf8.clear();
                self.utf8_len = 0;
            }
            return Ok(false);
        }
        match self.escape {
            Escape::Normal => match b {
                b'"' => return Ok(true),
                b'\\' => self.escape = Escape::Slash,
                0..=31 => return Err(()),
                32..=127 => self.capture.push(b as char),
                _ => {
                    self.utf8_len = match b {
                        0xc2..=0xdf => 2,
                        0xe0..=0xef => 3,
                        0xf0..=0xf4 => 4,
                        _ => return Err(()),
                    };
                    self.utf8.push(b);
                }
            },
            Escape::Slash => {
                match b {
                    b'"' | b'\\' | b'/' => self.capture.push(b as char),
                    b'b' => self.capture.push('\u{8}'),
                    b'f' => self.capture.push('\u{c}'),
                    b'n' => self.capture.push('\n'),
                    b'r' => self.capture.push('\r'),
                    b't' => self.capture.push('\t'),
                    b'u' => {
                        self.escape = Escape::Unicode(0, 0);
                        return Ok(false);
                    }
                    _ => return Err(()),
                }
                self.escape = Escape::Normal;
            }
            Escape::Unicode(mut n, digits) | Escape::LowUnicode(_, mut n, digits) => {
                let digit = (b as char).to_digit(16).ok_or(())? as u16;
                n = n * 16 + digit;
                if digits < 3 {
                    self.escape = match self.escape {
                        Escape::LowUnicode(high, _, _) => Escape::LowUnicode(high, n, digits + 1),
                        _ => Escape::Unicode(n, digits + 1),
                    };
                } else if let Escape::LowUnicode(high, _, _) = self.escape {
                    if !(0xdc00..=0xdfff).contains(&n) {
                        return Err(());
                    }
                    self.capture.push(
                        char::from_u32(
                            0x10000 + (((high - 0xd800) as u32) << 10) + (n - 0xdc00) as u32,
                        )
                        .ok_or(())?,
                    );
                    self.escape = Escape::Normal;
                } else if (0xd800..=0xdbff).contains(&n) {
                    self.escape = Escape::LowSlash(n);
                } else if (0xdc00..=0xdfff).contains(&n) {
                    return Err(());
                } else {
                    self.capture.push(char::from_u32(n as u32).ok_or(())?);
                    self.escape = Escape::Normal;
                }
            }
            Escape::LowSlash(high) => {
                if b != b'\\' {
                    return Err(());
                }
                self.escape = Escape::LowU(high);
            }
            Escape::LowU(high) => {
                if b != b'u' {
                    return Err(());
                }
                self.escape = Escape::LowUnicode(high, 0, 0);
            }
        }
        Ok(false)
    }
}

#[derive(Clone, Copy)]
enum NumberPhase {
    Minus,
    Zero,
    Int,
    Dot,
    Frac,
    Exp,
    ExpSign,
    ExpDigits,
}
struct NumberToken {
    phase: NumberPhase,
    text: String,
    spec: Spec,
    overflow: bool,
}
impl NumberToken {
    fn new(b: u8, spec: Spec) -> Self {
        Self {
            phase: match b {
                b'-' => NumberPhase::Minus,
                b'0' => NumberPhase::Zero,
                _ => NumberPhase::Int,
            },
            text: (b as char).to_string(),
            spec,
            overflow: false,
        }
    }
    fn push(&mut self, b: u8) -> Result<bool, ()> {
        use NumberPhase::*;
        let next = match (self.phase, b) {
            (Minus, b'0') => Some(Zero),
            (Minus, b'1'..=b'9') => Some(Int),
            (Int, b'0'..=b'9') => Some(Int),
            (Zero | Int, b'.') => Some(Dot),
            (Zero | Int | Frac, b'e' | b'E') => Some(Exp),
            (Dot | Frac, b'0'..=b'9') => Some(Frac),
            (Exp, b'+' | b'-') => Some(ExpSign),
            (Exp | ExpSign | ExpDigits, b'0'..=b'9') => Some(ExpDigits),
            _ => None,
        };
        if let Some(next) = next {
            self.phase = next;
            if self.text.len() < 128 {
                self.text.push(b as char);
            } else {
                self.overflow = true;
            }
            Ok(false)
        } else if matches!(self.phase, Zero | Int | Frac | ExpDigits) {
            Ok(true)
        } else {
            Err(())
        }
    }
    fn finish(self) -> (Option<Value>, bool) {
        if self.spec == Spec::Skip {
            return (None, false);
        }
        let value = (!self.overflow)
            .then(|| serde_json::from_str(&self.text).ok())
            .flatten();
        let limited = value.is_none();
        (value, limited)
    }
}
enum Token {
    String(StringToken),
    Number(NumberToken),
    Literal {
        expected: &'static [u8],
        at: usize,
        spec: Spec,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Error {
    Invalid,
    Limit,
}
/// The retained projection is capped independently of the 2 MiB I/O budget.
/// Unknown values still pass the full grammar/UTF-8 validator.
pub(super) struct Projector {
    root_spec: Spec,
    stack: Vec<Frame>,
    token: Option<Token>,
    root: Option<Value>,
    root_done: bool,
    retained: usize,
    error: Option<Error>,
    seen: bool,
    limited: bool,
}
impl Default for Projector {
    fn default() -> Self {
        Self::with_spec(Spec::Root)
    }
}
impl Projector {
    fn with_spec(root_spec: Spec) -> Self {
        Self {
            root_spec,
            stack: Vec::new(),
            token: None,
            root: None,
            root_done: false,
            retained: 0,
            error: None,
            seen: false,
            limited: false,
        }
    }
    pub(super) fn is_empty(&self) -> bool {
        !self.seen
    }
    fn fail(&mut self, error: Error) {
        self.error = Some(error);
        self.stack.clear();
        self.token = None;
        self.root = None;
    }
    fn limit(&mut self) {
        self.limited = true;
        // Keep parsing/validating after a retained-data limit. The record type
        // may occur last: an api-request-blob must remain a harmless snapshot.
        for (index, frame) in self.stack.iter_mut().enumerate() {
            if index == 0 && frame.spec == Spec::Root {
                frame.map.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "type" | "sessionId" | "isSidechain" | "agentId"
                    )
                });
            } else {
                frame.spec = Spec::Skip;
                frame.map.clear();
                frame.array.clear();
            }
        }
        self.retained = 0;
    }
    fn accept(&mut self, value: Option<Value>) {
        if let Some(frame) = self.stack.last_mut() {
            // A selected key with the wrong JSON type must overwrite an old
            // duplicate value. Missing and explicitly invalid are different.
            let selected_key = frame.object && frame.spec.key(&frame.key) != Spec::Skip;
            let value = if value.is_none() && (frame.spec == Spec::Items || selected_key) {
                Some(Value::Null)
            } else {
                value
            };
            if let Some(value) = value {
                if frame.object {
                    frame.map.insert(std::mem::take(&mut frame.key), value);
                } else {
                    let limit = if frame.spec == Spec::Blocks {
                        MAX_BLOCKS
                    } else {
                        MAX_ARRAY
                    };
                    if frame.array.len() >= limit {
                        frame.phase = Phase::CommaOrEnd;
                        self.limit();
                        return;
                    }
                    frame.array.push(value);
                }
            }
            frame.phase = Phase::CommaOrEnd;
        } else {
            self.root = value;
            self.root_done = true;
        }
    }
    fn scalar(&mut self, value: Option<Value>, limited: bool) {
        if limited {
            self.limit();
            self.accept(None);
            return;
        }
        // String payloads dominate the projection; keys/container count is
        // bounded separately by the fixed schema and retained array limits.
        if let Some(Value::String(s)) = &value {
            self.retained = self.retained.saturating_add(s.len());
        }
        if self.retained > PROJECTED_BYTES {
            self.limit();
            self.accept(None);
            return;
        }
        self.accept(value);
    }
    pub(super) fn push(&mut self, b: u8) {
        if self.error.is_some() {
            return;
        }
        if !matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
            self.seen = true;
        }
        if let Some(mut token) = self.token.take() {
            match &mut token {
                Token::String(string) => match string.push(b) {
                    Ok(false) => {
                        self.token = Some(token);
                        return;
                    }
                    Ok(true) => {
                        let Token::String(string) = token else {
                            unreachable!()
                        };
                        let key = string.key;
                        let (value, limited) = string.capture.finish();
                        if key {
                            // Unknown giant keys are skipped without poisoning
                            // a record. They cannot equal a selected schema key.
                            if let Some(frame) = self.stack.last_mut() {
                                frame.key = if limited {
                                    String::new()
                                } else {
                                    value
                                        .and_then(|v| v.as_str().map(str::to_owned))
                                        .unwrap_or_default()
                                };
                                frame.phase = Phase::Colon;
                            } else {
                                self.fail(Error::Invalid);
                            }
                        } else {
                            self.scalar(value, limited);
                        }
                        return;
                    }
                    Err(()) => {
                        self.fail(Error::Invalid);
                        return;
                    }
                },
                Token::Number(number) => match number.push(b) {
                    Ok(false) => {
                        self.token = Some(token);
                        return;
                    }
                    Ok(true) => {
                        let Token::Number(number) = token else {
                            unreachable!()
                        };
                        let (v, limit) = number.finish();
                        self.scalar(v, limit);
                    }
                    Err(()) => {
                        self.fail(Error::Invalid);
                        return;
                    }
                },
                Token::Literal { expected, at, spec } => {
                    if *at < expected.len() {
                        if b != expected[*at] {
                            self.fail(Error::Invalid);
                            return;
                        }
                        *at += 1;
                        self.token = Some(token);
                        return;
                    }
                    let value = if *spec == Spec::Skip {
                        None
                    } else {
                        serde_json::from_slice::<Value>(expected).ok()
                    };
                    self.scalar(value, false);
                }
            }
            if self.error.is_some() {
                return;
            }
        }
        if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
            return;
        }
        if let Some(frame) = self.stack.last_mut() {
            match frame.phase {
                Phase::KeyOrEnd if b == b'}' => {
                    self.close(true);
                    return;
                }
                Phase::KeyOrEnd | Phase::Key => {
                    if b != b'"' {
                        self.fail(Error::Invalid);
                        return;
                    }
                    self.token = Some(Token::String(StringToken::new(true, Spec::Exact)));
                    return;
                }
                Phase::Colon => {
                    if b == b':' {
                        frame.phase = Phase::Value;
                    } else {
                        self.fail(Error::Invalid);
                    }
                    return;
                }
                Phase::CommaOrEnd => {
                    if (frame.object && b == b'}') || (!frame.object && b == b']') {
                        let object = frame.object;
                        self.close(object);
                    } else if b == b',' {
                        frame.phase = if frame.object {
                            Phase::Key
                        } else {
                            Phase::Value
                        };
                    } else {
                        self.fail(Error::Invalid);
                    }
                    return;
                }
                Phase::ValueOrEnd if b == b']' => {
                    self.close(false);
                    return;
                }
                Phase::ValueOrEnd | Phase::Value => {}
            }
        } else if self.root_done {
            self.fail(Error::Invalid);
            return;
        }
        let spec = self
            .stack
            .last()
            .map(Frame::value_spec)
            .unwrap_or(self.root_spec);
        match b {
            b'{' | b'[' => {
                if self.stack.len() >= MAX_DEPTH {
                    self.fail(Error::Limit);
                    return;
                }
                // Scalar fields cannot smuggle retained arbitrary structures.
                let spec = if matches!(
                    spec,
                    Spec::Exact
                        | Spec::Text
                        | Spec::ItemText
                        | Spec::Notification
                        | Spec::Arguments
                ) {
                    Spec::Skip
                } else {
                    spec
                };
                self.stack.push(Frame::new(spec, b == b'{', self.retained));
            }
            b'"' => self.token = Some(Token::String(StringToken::new(false, spec.string_mode()))),
            b'-' | b'0'..=b'9' => self.token = Some(Token::Number(NumberToken::new(b, spec))),
            b't' | b'f' | b'n' => {
                self.token = Some(Token::Literal {
                    expected: match b {
                        b't' => b"true",
                        b'f' => b"false",
                        _ => b"null",
                    },
                    at: 1,
                    spec,
                })
            }
            _ => self.fail(Error::Invalid),
        }
    }
    fn close(&mut self, object: bool) {
        let Some(frame) = self.stack.pop() else {
            self.fail(Error::Invalid);
            return;
        };
        if frame.object != object {
            self.fail(Error::Invalid);
            return;
        }
        let retained_before = frame.retained_before;
        let value = frame.finish();
        if value.is_none() {
            self.retained = retained_before;
        }
        self.accept(value);
    }
    pub(super) fn finish(mut self) -> Result<Value, Error> {
        // A final number/literal needs a delimiter to complete its token.
        self.push(b' ');
        if let Some(error) = self.error {
            return Err(error);
        }
        if !self.root_done || !self.stack.is_empty() || self.token.is_some() {
            return Err(Error::Invalid);
        }
        let value = self.root.unwrap_or(Value::Null);
        if self.limited && value.get("type").and_then(Value::as_str) != Some("api-request-blob") {
            return Err(Error::Limit);
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn project(bytes: &[u8]) -> Result<Value, Error> {
        let mut p = Projector::default();
        for byte in bytes {
            p.push(*byte);
        }
        p.finish()
    }
    #[test]
    fn validates_escapes_unicode_and_json_grammar_even_in_skipped_data() {
        let value = project(r#"{"ignored":"\uD83D\uDE00\"\\\n","sessionId":"par\u0065nt","message":{"role":"assistant","content":[{"type":"tool_use","name":"TaskCreate","id":"x","input":{"subject":"你好😀"}}]}}"#.as_bytes()).unwrap();
        assert_eq!(value["sessionId"], "parent");
        assert_eq!(value["message"]["content"][0]["input"]["subject"], "你好😀");
        for raw in [
            r#"{"x":01}"#,
            r#"{"x":1.}"#,
            r#"{"x":1e+}"#,
            r#"{"x":tru}"#,
            r#"{"x":true,}"#,
            r#"{"x":[1,]}"#,
            r#"{"x":"\uD800"}"#,
            r#"{"x":"\uDC00"}"#,
            r#"{"x":"\q"}"#,
            r#"{}{}"#,
            r#"{"x":[1}}"#,
        ] {
            assert_eq!(project(raw.as_bytes()), Err(Error::Invalid), "{raw}");
        }
        assert_eq!(project(b"{\"ignored\":\"\xff\"}"), Err(Error::Invalid));
        assert_eq!(project(b"{\"ignored\":\"\xe2\x82\"}"), Err(Error::Invalid));
        assert_eq!(project(b"{\"x\":true}\x0b"), Err(Error::Invalid));
        assert!(project(b" \t{\"x\":[null,false,-1.25e+4]}\r ").is_ok());
    }
    #[test]
    fn giant_unknown_keys_numbers_and_images_do_not_consume_projection_budget() {
        let raw = format!("{{\"{}\":\"{}\",\"number\":{},\"message\":{{\"content\":[{}]}},\"sessionId\":\"parent\"}}",
            "k".repeat(300_000), "x".repeat(600_000), "1".repeat(300_000),
            (0..10_000).map(|_| "{\"type\":\"image\",\"source\":{\"data\":\"ignored\"}}").collect::<Vec<_>>().join(","));
        let value = project(raw.as_bytes()).unwrap();
        assert_eq!(value["sessionId"], "parent");
        assert!(value["message"]["content"].as_array().unwrap().is_empty());
    }
    #[test]
    fn selected_duplicate_wrong_types_override_old_identity_and_control_values() {
        let value = project(br#"{"sessionId":"parent","sessionId":{},"payload":{"id":"parent","id":[]},"message":{"content":[{"type":"tool_use","name":"TaskUpdate","input":{"status":"completed","status":{}}}]}}"#).unwrap();
        assert!(value["sessionId"].is_null());
        assert!(value["payload"]["id"].is_null());
        assert!(value["message"]["content"][0]["input"]["status"].is_null());
        let value = project(br#"{"sessionId":{},"sessionId":"parent"}"#).unwrap();
        assert_eq!(value["sessionId"], "parent");
    }
    #[test]
    fn task_structure_limits_remain_bounded_but_request_snapshots_are_harmless() {
        let blocks = (0..MAX_BLOCKS + 10)
            .map(|_| json!({"type":"tool_use","name":"TodoWrite","input":{"todos":[]}}))
            .collect::<Vec<_>>();
        let raw = json!({"sessionId":"parent","message":{"content":blocks}}).to_string();
        assert_eq!(project(raw.as_bytes()), Err(Error::Limit));
        // Type deliberately comes last, beyond the retained task-block limit.
        let raw = format!(
            "{{\"message\":{{\"content\":{}}},\"type\":\"api-request-blob\"}}",
            serde_json::to_string(&blocks).unwrap()
        );
        assert_eq!(project(raw.as_bytes()).unwrap()["type"], "api-request-blob");
        let raw = format!(
            "{{\"ignored\":{}0{}}}",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        );
        assert_eq!(project(raw.as_bytes()), Err(Error::Limit));
    }
    #[test]
    fn notification_protocol_is_scanned_after_large_plain_text() {
        let notice = "<task-notification><task-id>job</task-id><status>completed</status></task-notification>";
        let raw = json!({"sessionId":"parent","message":{"role":"user","content":format!("{}{}", "普通内容😀".repeat(200_000), notice)}}).to_string();
        let value = project(raw.as_bytes()).unwrap();
        assert_eq!(value["message"]["content"], notice);
        let raw = json!({"sessionId":"parent","message":{"role":"user","content":format!("<task-notification>{}</task-notification>", "x".repeat(NOTIFICATION_BYTES))}}).to_string();
        assert_eq!(project(raw.as_bytes()), Err(Error::Limit));
    }
    #[test]
    fn escaped_arguments_are_structural_before_display_cropping() {
        let args = json!({"cmd":format!("{}\\quoted\"😀", "x".repeat(600_000)),"session_id":42,"plan":[{"step":"keep","status":"completed"}]}).to_string();
        let raw =
            json!({"type":"response_item","payload":{"type":"function_call","arguments":args}})
                .to_string();
        let value = project(raw.as_bytes()).unwrap();
        assert_eq!(value["payload"]["arguments"]["session_id"], 42);
        assert_eq!(
            value["payload"]["arguments"]["plan"][0]["status"],
            "completed"
        );
        assert_eq!(
            value["payload"]["arguments"]["cmd"].as_str().unwrap().len(),
            TEXT_BYTES
        );
        let value = project(br#"{"payload":{"arguments":"{malformed}"}}"#).unwrap();
        assert!(value["payload"]["arguments"].is_null());
    }
}
