//! daemon TCP 服务：鉴权、帧分发、PTY 会话托管、ring buffer 回放、空闲自灭。
//!
//! 增量 2：接入 `PtyManager`（经 `PtyEventSink` 解耦）。输出帧在 PTY reader
//! 线程已按 ANSI/UTF-8 安全边界切好，本层只整帧存储/透传（契约禁止再分片）。
//! 增量 3 待办：Windows Job Object 兜底、hook 上报转发、exited 会话宽限自灭。

use super::discovery::{remove_daemon_info, write_daemon_info_exclusive, DaemonInfo};
use super::protocol::{
    decode_binary_terminal_frame, decode_client_frame, encode_binary_terminal_frame, encode_frame,
    supported_features, AgentDetection, ClientFrame, DaemonFrame, ProcessTraits, ProtocolError,
    ReplayEntry, SessionMeta, SessionStatusInfo, BINARY_KIND_CHECKPOINT, BINARY_KIND_INPUT,
    BINARY_KIND_OUTPUT, BINARY_KIND_REPLAY, BINARY_KIND_REPLAY_RESET, BINARY_PROTOCOL_VERSION,
    CONTROL_PROTOCOL_VERSION, MAX_FRAME_BYTES,
};
use super::ssh_agent_bridge::SshAgentBridgeManager;
use crate::claude_hook::{remote_hook_payload_from_spool, spawn_hook_listener, HookPayloadSink};
use crate::pty::manager::{PtyEventSink, PtyManager, PtyProcessStatus};
use crate::ssh_launch::SshLaunchPlan;
use crate::third_party_notification::DispatcherHandle;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::Role;
use tungstenite::{accept_hdr, Message, WebSocket};

/// 无会话且无客户端持续该时长后自灭（契约：10 分钟）。
pub const IDLE_EXIT_AFTER: Duration = Duration::from_secs(10 * 60);
/// 空闲 watchdog 检查间隔。
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// 单会话 ring buffer 字节上限（契约：2 MiB）。
pub const SESSION_BUFFER_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const SESSION_SPOOL_MAX_BYTES: usize = 10 * 1024 * 1024;
/// 全部会话 buffer 总内存上限（契约：128 MiB）。
pub const TOTAL_BUFFER_MAX_BYTES: usize = 128 * 1024 * 1024;
/// 会话数上限（契约：64）。
pub const MAX_SESSIONS: usize = 64;
/// 无客户端时缓存的 hook 上报条数上限（契约：200，attach 后补发）。
pub const HOOK_CACHE_MAX: usize = 200;
const OUTPUT_BUFFERING_DURATION: Duration = Duration::from_millis(5);
const OUTPUT_BUFFERING_MAX_BYTES: usize = 64 * 1024;
const CLIENT_OUTPUT_HIGH_WATERMARK: usize = 100_000;
const CLIENT_OUTPUT_LOW_WATERMARK: usize = 5_000;
const CLIENT_OUTPUT_QUEUE_MAX_BYTES: usize = 2 * 1024 * 1024;
const CLIENT_CONTROL_QUEUE_MAX_FRAMES: usize = 256;

/// A durable duplicate is not proof of delivery: a previous process may have
/// committed and stopped before updating runtime state or broadcasting the Hook.
/// Transport-local receipt caches suppress normal retries after this completes;
/// after a crash, delivery is deliberately at least once while the DB stays unique.
fn deliver_durable_hook(
    mut value: serde_json::Value,
    persist: impl FnOnce(&serde_json::Value) -> Result<bool, String>,
    deliver: impl FnOnce(serde_json::Value),
) -> Result<(), String> {
    let _inserted = persist(&value)?;
    value["inboxDurable"] = serde_json::Value::Bool(true);
    deliver(value);
    Ok(())
}

struct SpooledFrame {
    sequence: u64,
    bytes: usize,
}

struct ReplayFrame {
    cols: u16,
    rows: u16,
    sequence: u64,
    data: Arc<[u8]>,
}

/// 按整帧存储的回放缓冲：每帧都是 PTY reader 切好的 ANSI 安全块，
/// 超限时从头丢弃整帧，天然保持边界安全（契约）。
struct SessionBuffer {
    frames: VecDeque<ReplayFrame>,
    total_bytes: usize,
    spool_path: Option<PathBuf>,
    spool_bytes: usize,
    spool_offset: u64,
    spool_frames: VecDeque<SpooledFrame>,
    retired_spool_paths: Vec<PathBuf>,
    checkpoint: Option<ReplayFrame>,
    truncated: bool,
}

impl SessionBuffer {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_spool(None)
    }

    fn with_spool(spool_path: Option<PathBuf>) -> Self {
        Self {
            frames: VecDeque::new(),
            total_bytes: 0,
            spool_path,
            spool_bytes: 0,
            spool_offset: 0,
            spool_frames: VecDeque::new(),
            retired_spool_paths: Vec::new(),
            checkpoint: None,
            truncated: false,
        }
    }

    #[cfg(test)]
    fn push_output(&mut self, cols: u16, rows: u16, sequence: u64, data: &[u8]) {
        self.push_shared_output(cols, rows, sequence, Arc::from(data));
    }

    fn push_shared_output(&mut self, cols: u16, rows: u16, sequence: u64, data: Arc<[u8]>) {
        self.total_bytes += data.len();
        self.frames.push_back(ReplayFrame {
            cols,
            rows,
            sequence,
            data,
        });
        while self.total_bytes > SESSION_BUFFER_MAX_BYTES {
            let Some(front) = self.frames.pop_front() else {
                break;
            };
            if let Err(err) = self.append_spooled_frame(&front) {
                log::warn!("daemon session spool write failed, retaining frame in memory: {err}");
                self.frames.push_front(front);
                break;
            }
            self.total_bytes = self.total_bytes.saturating_sub(front.data.len());
            self.enforce_spool_cap();
        }
    }

    fn push_resize(&mut self, cols: u16, rows: u16, sequence: u64) {
        if let Some(last) = self.frames.back_mut() {
            if last.data.is_empty() {
                last.cols = cols;
                last.rows = rows;
                last.sequence = sequence;
                return;
            }
        }
        self.frames.push_back(ReplayFrame {
            cols,
            rows,
            sequence,
            data: Arc::from([]),
        });
    }

    fn replay_entries(&self) -> Result<Vec<ReplayEntry>, String> {
        self.replay_entries_after(None)
    }

    fn replay_entries_after(
        &self,
        after_sequence: Option<u64>,
    ) -> Result<Vec<ReplayEntry>, String> {
        let spooled = self.read_spooled_frames_after(after_sequence)?;
        Ok(self
            .checkpoint
            .iter()
            .chain(spooled.iter())
            .chain(self.frames.iter())
            .filter(|frame| after_sequence.is_none_or(|sequence| frame.sequence > sequence))
            .map(|frame| ReplayEntry {
                cols: frame.cols,
                rows: frame.rows,
                sequence: frame.sequence,
                data: Arc::clone(&frame.data),
            })
            .collect())
    }

    fn oldest_sequence(&self) -> Option<u64> {
        self.checkpoint
            .as_ref()
            .map(|frame| frame.sequence)
            .or_else(|| self.spool_frames.front().map(|frame| frame.sequence))
            .or_else(|| self.frames.front().map(|frame| frame.sequence))
    }

    fn accept_checkpoint(
        &mut self,
        cols: u16,
        rows: u16,
        sequence: u64,
        data: Vec<u8>,
    ) -> Result<(), String> {
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.sequence >= sequence)
        {
            return Ok(());
        }
        // Keep the old checkpoint and ring intact if the disk update fails.
        let retained = self.read_spooled_frames_after(Some(sequence))?;
        self.write_spooled_frames(&retained)?;
        self.checkpoint = Some(ReplayFrame {
            cols,
            rows,
            sequence,
            data: data.into(),
        });
        while self
            .frames
            .front()
            .is_some_and(|frame| frame.sequence <= sequence)
        {
            if let Some(frame) = self.frames.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(frame.data.len());
            }
        }
        Ok(())
    }

    fn replay_available(&self) -> bool {
        self.checkpoint.is_some() || self.spool_bytes > 0 || !self.frames.is_empty()
    }

    fn append_spooled_frame(&mut self, frame: &ReplayFrame) -> Result<(), String> {
        let Some(path) = self.spool_path.as_ref() else {
            return Err("spool path unavailable".to_string());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| err.to_string())?;
        let expected_len = self.spool_offset + self.spool_bytes as u64;
        let actual_len = file.metadata().map_err(|err| err.to_string())?.len();
        if actual_len < expected_len {
            return Err("spool file is shorter than its retained frames".to_string());
        }
        if actual_len > expected_len {
            // A failed rollback must not leave a partial frame before the next append.
            file.set_len(expected_len).map_err(|err| err.to_string())?;
        }
        if let Err(err) = write_replay_frame(&mut file, frame) {
            let _ = file.set_len(expected_len);
            return Err(err.to_string());
        }
        let bytes = 16 + frame.data.len();
        self.spool_bytes += bytes;
        self.spool_frames.push_back(SpooledFrame {
            sequence: frame.sequence,
            bytes,
        });
        Ok(())
    }

    fn write_spooled_frames(&mut self, frames: &[ReplayFrame]) -> Result<(), String> {
        self.cleanup_retired_spools();
        let Some(path) = self.spool_path.as_ref() else {
            return Ok(());
        };
        if frames.is_empty() {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.to_string()),
            }
            self.spool_bytes = 0;
            self.spool_offset = 0;
            self.spool_frames.clear();
            return Ok(());
        }
        // Spools are daemon-lifetime scratch files, never loaded after restart.
        // Switch paths only after a complete write, avoiding remove-then-rename
        // data loss on Windows as well as preserving the old file on disk errors.
        let next_path = path.with_file_name(format!("spool-{}.bin", uuid::Uuid::new_v4()));
        // Only clean up a replacement after this call actually created it.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&next_path)
            .map_err(|err| err.to_string())?;
        let result = (|| {
            for frame in frames {
                write_replay_frame(&mut file, frame)?;
            }
            file.flush()
        })();
        drop(file);
        if let Err(err) = result {
            let _ = std::fs::remove_file(&next_path);
            return Err(err.to_string());
        }
        let old_path = self.spool_path.replace(next_path).unwrap();
        self.spool_frames = frames
            .iter()
            .map(|frame| SpooledFrame {
                sequence: frame.sequence,
                bytes: 16 + frame.data.len(),
            })
            .collect();
        self.spool_bytes = self.spool_frames.iter().map(|frame| frame.bytes).sum();
        self.spool_offset = 0;
        self.retired_spool_paths.push(old_path);
        self.cleanup_retired_spools();
        Ok(())
    }

    fn cleanup_retired_spools(&mut self) {
        // Only paths previously owned by this session can enter this list.
        // Windows readers may temporarily deny deletion; retry on later
        // compaction/checkpoint and Drop instead of forgetting those files.
        self.retired_spool_paths
            .retain(|path| match std::fs::remove_file(path) {
                Ok(()) => false,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
                Err(err) => {
                    log::warn!("daemon old session spool cleanup deferred: {err}");
                    true
                }
            });
    }

    fn enforce_spool_cap(&mut self) {
        // Drop whole frames from the logical head without rewriting retained data.
        while self.spool_bytes > SESSION_SPOOL_MAX_BYTES {
            let Some(frame) = self.spool_frames.pop_front() else {
                break;
            };
            self.spool_bytes -= frame.bytes;
            self.spool_offset += frame.bytes as u64;
            self.truncated = true;
        }
        // Amortize physical compaction over a full spool's worth of discarded
        // bytes. Logical history remains 10 MiB; the file stays near 20 MiB.
        if self.spool_offset < SESSION_SPOOL_MAX_BYTES as u64 {
            return;
        }
        let result = self
            .read_spooled_frames_after(None)
            .and_then(|frames| self.write_spooled_frames(&frames));
        if let Err(err) = result {
            log::warn!("daemon session spool compaction failed: {err}");
        }
    }

    fn read_spooled_frames_after(
        &self,
        after_sequence: Option<u64>,
    ) -> Result<Vec<ReplayFrame>, String> {
        let skipped_frames = self
            .spool_frames
            .iter()
            .take_while(|frame| after_sequence.is_some_and(|sequence| frame.sequence <= sequence))
            .count();
        let skipped = self
            .spool_frames
            .iter()
            .take(skipped_frames)
            .map(|frame| frame.bytes)
            .sum::<usize>();
        if skipped == self.spool_bytes {
            return Ok(Vec::new());
        }
        let path = self
            .spool_path
            .as_ref()
            .ok_or_else(|| "spool path unavailable".to_string())?;
        let mut file = File::open(path).map_err(|err| err.to_string())?;
        file.seek(SeekFrom::Start(self.spool_offset + skipped as u64))
            .map_err(|err| err.to_string())?;
        // Ignore an incomplete tail left by an append error until it is repaired.
        let mut file = file.take((self.spool_bytes - skipped) as u64);
        let mut frames = Vec::new();
        for expected in self.spool_frames.iter().skip(skipped_frames) {
            let mut header = [0u8; 16];
            file.read_exact(&mut header)
                .map_err(|err| err.to_string())?;
            let cols = u16::from_be_bytes([header[0], header[1]]);
            let rows = u16::from_be_bytes([header[2], header[3]]);
            let sequence = u64::from_be_bytes(header[4..12].try_into().unwrap());
            let data_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
            if data_len > MAX_FRAME_BYTES
                || data_len + 16 != expected.bytes
                || sequence != expected.sequence
            {
                return Err("spool frame does not match its index".to_string());
            }
            let mut data = vec![0u8; data_len];
            file.read_exact(&mut data).map_err(|err| err.to_string())?;
            frames.push(ReplayFrame {
                cols,
                rows,
                sequence,
                data: data.into(),
            });
        }
        Ok(frames)
    }
}

fn write_replay_frame(file: &mut impl Write, frame: &ReplayFrame) -> std::io::Result<()> {
    file.write_all(&frame.cols.to_be_bytes())?;
    file.write_all(&frame.rows.to_be_bytes())?;
    file.write_all(&frame.sequence.to_be_bytes())?;
    file.write_all(&(frame.data.len() as u32).to_be_bytes())?;
    file.write_all(&frame.data)
}

impl Drop for SessionBuffer {
    fn drop(&mut self) {
        self.cleanup_retired_spools();
        if let Some(path) = self.spool_path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
}

enum ClientTransport {
    Ndjson(Mutex<TcpStream>),
    WebSocket(Mutex<WebSocket<TcpStream>>),
}

#[derive(Clone)]
enum ClientWireFrame {
    Daemon(DaemonFrame),
    BinaryTerminal {
        kind: u8,
        session_id: String,
        sequence: u64,
        cols: u16,
        rows: u16,
        data: Arc<[u8]>,
    },
}

impl ClientTransport {
    fn send_frame(&self, frame: &ClientWireFrame) -> Result<(), String> {
        match self {
            Self::Ndjson(writer) => match frame {
                ClientWireFrame::Daemon(frame) => writer
                    .lock()
                    .map_err(|_| "writer poisoned".to_string())?
                    .write_all(encode_frame(frame).as_bytes())
                    .map_err(|err| err.to_string()),
                ClientWireFrame::BinaryTerminal { .. } => {
                    Err("binary terminal frame is unavailable on ndjson transport".to_string())
                }
            },
            Self::WebSocket(socket) => {
                let mut socket = socket
                    .lock()
                    .map_err(|_| "websocket writer poisoned".to_string())?;
                match frame {
                    ClientWireFrame::BinaryTerminal {
                        kind,
                        session_id,
                        sequence,
                        cols,
                        rows,
                        data,
                    } => {
                        let binary = encode_binary_terminal_frame(
                            *kind, session_id, *sequence, *cols, *rows, data,
                        )?;
                        socket
                            .send(Message::Binary(binary.into()))
                            .map_err(|err| err.to_string())
                    }
                    ClientWireFrame::Daemon(DaemonFrame::Output {
                        session_id,
                        sequence,
                        cols,
                        rows,
                        data,
                    }) => {
                        let binary = encode_binary_terminal_frame(
                            BINARY_KIND_OUTPUT,
                            session_id,
                            *sequence,
                            *cols,
                            *rows,
                            &data,
                        )?;
                        socket
                            .send(Message::Binary(binary.into()))
                            .map_err(|err| err.to_string())
                    }
                    ClientWireFrame::Daemon(frame) => socket
                        .send(Message::Text(
                            encode_frame(frame).trim_end().to_string().into(),
                        ))
                        .map_err(|err| err.to_string()),
                }
            }
        }
    }

    fn is_websocket(&self) -> bool {
        matches!(self, Self::WebSocket(_))
    }

    fn close(&self) {
        match self {
            Self::Ndjson(stream) => {
                if let Ok(stream) = stream.lock() {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
            Self::WebSocket(socket) => {
                if let Ok(mut socket) = socket.lock() {
                    let _ = socket.close(None);
                    let _ = socket.get_mut().shutdown(Shutdown::Both);
                }
            }
        }
    }
}

fn websocket_attached_frames(frame: &DaemonFrame) -> Result<Vec<ClientWireFrame>, String> {
    let DaemonFrame::Attached {
        id,
        session_id,
        replay,
        latest_sequence,
        meta,
        replay_reset,
        replay_truncated,
        oldest_sequence,
        ..
    } = frame
    else {
        return Err("expected attached frame".to_string());
    };
    let mut frames = Vec::with_capacity(replay.len() + 2);
    if *replay_reset {
        frames.push(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY_RESET,
            session_id: session_id.clone(),
            sequence: 0,
            cols: replay.first().map(|entry| entry.cols).unwrap_or(80),
            rows: replay.first().map(|entry| entry.rows).unwrap_or(24),
            data: Arc::from([]),
        });
    }
    for entry in replay {
        frames.push(ClientWireFrame::BinaryTerminal {
            kind: BINARY_KIND_REPLAY,
            session_id: session_id.clone(),
            sequence: entry.sequence,
            cols: entry.cols,
            rows: entry.rows,
            data: Arc::clone(&entry.data),
        });
    }
    frames.push(ClientWireFrame::Daemon(DaemonFrame::Attached {
        id: *id,
        session_id: session_id.clone(),
        replay_base64: String::new(),
        replay: Vec::new(),
        latest_sequence: *latest_sequence,
        meta: meta.clone(),
        replay_reset: *replay_reset,
        replay_truncated: *replay_truncated,
        oldest_sequence: *oldest_sequence,
    }));
    Ok(frames)
}

struct QueuedOutputFrame {
    frame: ClientWireFrame,
    live_output_bytes: usize,
}

struct ClientWriterState {
    control: VecDeque<ClientWireFrame>,
    output: VecDeque<QueuedOutputFrame>,
    output_bytes: usize,
    closed: bool,
}

impl ClientWriterState {
    fn pop_next(&mut self) -> Option<ClientWireFrame> {
        if let Some(frame) = self.control.pop_front() {
            return Some(frame);
        }
        let queued = self.output.pop_front()?;
        self.output_bytes = self.output_bytes.saturating_sub(queued.live_output_bytes);
        Some(queued.frame)
    }
}

struct ClientWriter {
    shared: Arc<(Mutex<ClientWriterState>, Condvar)>,
    websocket: bool,
}

impl ClientWriter {
    fn new(transport: ClientTransport) -> Arc<Self> {
        let websocket = transport.is_websocket();
        let shared = Arc::new((
            Mutex::new(ClientWriterState {
                control: VecDeque::new(),
                output: VecDeque::new(),
                output_bytes: 0,
                closed: false,
            }),
            Condvar::new(),
        ));
        let thread_shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            loop {
                let frame = {
                    let (lock, changed) = &*thread_shared;
                    let Ok(mut state) = lock.lock() else {
                        break;
                    };
                    while !state.closed && state.control.is_empty() && state.output.is_empty() {
                        let Ok(next) = changed.wait(state) else {
                            return;
                        };
                        state = next;
                    }
                    if state.closed {
                        None
                    } else {
                        state.pop_next()
                    }
                };
                let Some(frame) = frame else {
                    break;
                };
                if let Err(err) = transport.send_frame(&frame) {
                    log::debug!("daemon client writer stopped: {err}");
                    break;
                }
            }
            transport.close();
        });
        Arc::new(Self { shared, websocket })
    }

    fn send_frame(&self, frame: &DaemonFrame) -> Result<(), String> {
        if self.websocket && matches!(frame, DaemonFrame::Attached { .. }) {
            return self.send_attached(frame);
        }
        let wire_frame = ClientWireFrame::Daemon(frame.clone());
        if matches!(frame, DaemonFrame::Output { .. }) {
            self.send_output(wire_frame, frame_payload_bytes(frame))
        } else {
            self.send_control(wire_frame)
        }
    }

    fn send_attached(&self, frame: &DaemonFrame) -> Result<(), String> {
        let frames = websocket_attached_frames(frame)?;
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed {
            return Err("client writer closed".to_string());
        }
        state
            .output
            .extend(frames.into_iter().map(|frame| QueuedOutputFrame {
                frame,
                live_output_bytes: 0,
            }));
        changed.notify_one();
        Ok(())
    }

    fn send_control(&self, frame: ClientWireFrame) -> Result<(), String> {
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed || state.control.len() >= CLIENT_CONTROL_QUEUE_MAX_FRAMES {
            state.closed = true;
            changed.notify_all();
            return Err("client control queue full".to_string());
        }
        state.control.push_back(frame);
        changed.notify_one();
        Ok(())
    }

    fn send_output(&self, frame: ClientWireFrame, bytes: usize) -> Result<(), String> {
        let (lock, changed) = &*self.shared;
        let mut state = lock
            .lock()
            .map_err(|_| "client writer unavailable".to_string())?;
        if state.closed || state.output_bytes.saturating_add(bytes) > CLIENT_OUTPUT_QUEUE_MAX_BYTES
        {
            state.closed = true;
            changed.notify_all();
            return Err("client output queue full".to_string());
        }
        state.output_bytes = state.output_bytes.saturating_add(bytes);
        state.output.push_back(QueuedOutputFrame {
            frame,
            live_output_bytes: bytes,
        });
        changed.notify_one();
        Ok(())
    }

    fn close(&self) {
        let (lock, changed) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.closed = true;
            changed.notify_all();
        }
    }
}

fn frame_payload_bytes(frame: &DaemonFrame) -> usize {
    match frame {
        // Preserve the existing conservative queue limit in Base64 wire bytes
        // for both transports while retaining only raw shared bytes in memory.
        DaemonFrame::Output { data, .. } => data.len().saturating_add(2) / 3 * 4,
        _ => 0,
    }
}

struct ClientHandle {
    writer: Arc<ClientWriter>,
    attached: HashSet<String>,
    unacknowledged_chars: HashMap<String, usize>,
    flow_control_paused: HashSet<String>,
    last_sent_sequence: HashMap<String, u64>,
    last_acknowledged_sequence: HashMap<String, u64>,
    attaching: HashMap<String, Vec<DaemonFrame>>,
}

struct SessionEntry {
    meta: SessionMeta,
    buffer: SessionBuffer,
    cols: u16,
    rows: u16,
    next_sequence: u64,
    ssh_hook_binding: Option<SshHookBinding>,
}

fn update_agent_detection(
    entry: &mut SessionEntry,
    agent: Option<super::protocol::AgentIdentity>,
) -> Option<DaemonFrame> {
    let previous = entry.meta.agent_detection.as_ref().and_then(|d| d.agent.as_ref());
    if entry.meta.agent_detection.is_some()
        && previous.map(|a| (&a.run_id, &a.tool)) == agent.as_ref().map(|a| (&a.run_id, &a.tool))
    {
        return None;
    }
    let detection = AgentDetection { agent, updated_at_ms: now_ms() };
    entry.meta.agent_detection = Some(detection.clone());
    entry.meta.task_status = None;
    entry.meta.task_updated_at_ms = None;
    Some(DaemonFrame::AgentChanged {
        session_id: entry.meta.session_id.clone(), detection,
    })
}

struct SshHookBinding {
    host_id: String,
    client_instance_id: String,
    project_id: String,
    project_name: String,
    bridge_epoch: String,
    installation_id: String,
    source: String,
}

type SharedSession = Arc<Mutex<SessionEntry>>;

/// daemon 共享宿主：PTY 管理器 + 会话表 + 客户端注册表。
pub struct DaemonHost {
    pty: PtyManager,
    sessions: Mutex<HashMap<String, SharedSession>>,
    clients: Mutex<HashMap<u64, ClientHandle>>,
    output_flow_control: (Mutex<()>, Condvar),
    last_idle_since: Mutex<Instant>,
    /// 无客户端期间收到的 hook 上报缓存，客户端连上后补发（契约）。
    hook_cache: Mutex<VecDeque<serde_json::Value>>,
    hook_gap_cache: Mutex<VecDeque<(String, u64)>>,
    hook_sink: Mutex<Option<HookPayloadSink>>,
    ssh_agent_bridges: SshAgentBridgeManager,
    spool_dir: PathBuf,
    agent_tracker: Mutex<super::agent_tracker::AgentTracker>,
    #[cfg(target_os = "windows")]
    agent_refresh_signal: super::agent_refresh::AgentRefreshSignal,
}

impl DaemonHost {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_spool_dir(std::env::temp_dir().join(format!(
            "cli-manager-daemon-spool-test-{}",
            uuid::Uuid::new_v4()
        )))
    }

    fn with_spool_dir(spool_dir: PathBuf) -> Self {
        Self {
            pty: PtyManager::new(),
            sessions: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            output_flow_control: (Mutex::new(()), Condvar::new()),
            last_idle_since: Mutex::new(Instant::now()),
            hook_cache: Mutex::new(VecDeque::new()),
            hook_gap_cache: Mutex::new(VecDeque::new()),
            hook_sink: Mutex::new(None),
            ssh_agent_bridges: SshAgentBridgeManager::default(),
            spool_dir,
            agent_tracker: Mutex::new(super::agent_tracker::AgentTracker::default()),
            #[cfg(target_os = "windows")]
            agent_refresh_signal: super::agent_refresh::AgentRefreshSignal::default(),
        }
    }

    fn session_spool_path(&self, session_id: &str) -> PathBuf {
        self.spool_dir.join(format!("{session_id}.bin"))
    }

    fn get_session(&self, session_id: &str) -> Option<SharedSession> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).cloned())
    }

    fn set_hook_sink(&self, sink: HookPayloadSink) {
        if let Ok(mut current) = self.hook_sink.lock() {
            *current = Some(sink);
        }
    }

    fn ensure_ssh_agent_bridge(self: &Arc<Self>, session_id: &str, plan: &SshLaunchPlan) {
        self.ssh_agent_bridges
            .ensure(Arc::downgrade(self), session_id, plan);
    }

    fn release_ssh_agent_bridge(&self, session_id: &str) {
        let host_id = self.get_session(session_id).and_then(|session| {
            session
                .lock()
                .ok()
                .and_then(|entry| entry.meta.ssh_host_id.clone())
        });
        if let Some(host_id) = host_id {
            self.ssh_agent_bridges.release(&host_id, session_id);
        }
    }

    pub(crate) fn accept_remote_hook_event(&self, value: serde_json::Value) -> Result<(), String> {
        let Some(tab_id) = value.get("tabId").and_then(serde_json::Value::as_str) else {
            return Ok(());
        };
        let project_name = self.get_session(tab_id).and_then(|session| {
            session.lock().ok().and_then(|entry| {
                let Some(binding) = entry.ssh_hook_binding.as_ref() else {
                    return None;
                };
                if !entry.meta.alive {
                    return None;
                }
                let field = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
                (field("hostId") == Some(binding.host_id.as_str())
                    && field("clientInstanceId") == Some(binding.client_instance_id.as_str())
                    && field("projectId") == Some(binding.project_id.as_str())
                    && field("bridgeEpoch") == Some(binding.bridge_epoch.as_str())
                    && field("installationId") == Some(binding.installation_id.as_str())
                    && field("source") == Some(binding.source.as_str()))
                .then(|| binding.project_name.clone())
            })
        });
        let Some(project_name) = project_name else {
            log::warn!("rejected remote Hook event with an unknown SSH session binding");
            return Ok(());
        };
        let payload = match remote_hook_payload_from_spool(&value) {
            Ok(payload) => payload,
            Err(error) => {
                log::warn!("rejected invalid remote Hook event: {error}");
                return Ok(());
            }
        }
        .with_remote_project_name(project_name);
        let sink = self
            .hook_sink
            .lock()
            .ok()
            .and_then(|sink| sink.as_ref().cloned());
        if let Some(sink) = sink {
            sink(payload)?;
        } else {
            return Err("notification_hook_sink_unavailable".into());
        }
        Ok(())
    }

    #[cfg(test)]
    fn reserve_session(
        &self,
        session_id: &str,
        cwd: Option<String>,
        shell: Option<String>,
    ) -> Result<(), &'static str> {
        self.reserve_session_with_launch(session_id, cwd, shell, None, None)
    }

    fn reserve_session_with_launch(
        &self,
        session_id: &str,
        cwd: Option<String>,
        shell: Option<String>,
        ssh_launch: Option<&SshLaunchPlan>,
        workspace: Option<serde_json::Value>,
    ) -> Result<(), &'static str> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "daemon state unavailable")?;
        if sessions.contains_key(session_id) {
            return Err("session already exists");
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err("session limit reached");
        }
        sessions.insert(
            session_id.to_string(),
            Arc::new(Mutex::new(SessionEntry {
                meta: SessionMeta {
                    workspace,
                    session_id: session_id.to_string(),
                    root_pid: None,
                    root_started_at: None,
                    agent_detection: None,
                    cwd,
                    shell,
                    environment_type: ssh_launch.map(|_| "ssh".to_string()),
                    ssh_host_id: ssh_launch.map(|plan| plan.host_id.clone()),
                    remote_path: ssh_launch.map(|plan| plan.remote_path.clone()),
                    alive: true,
                    task_status: None,
                    task_updated_at_ms: None,
                    created_at_ms: now_ms(),
                    process_traits: Some(ProcessTraits::current_platform(
                        std::env::var_os("CLI_MANAGER_CONPTY_DLL_PATH").is_some(),
                    )),
                    replay_available: false,
                    replay_truncated: false,
                },
                buffer: SessionBuffer::with_spool(Some(self.session_spool_path(session_id))),
                cols: 80,
                rows: 24,
                next_sequence: 1,
                ssh_hook_binding: ssh_launch.and_then(|plan| {
                    (!plan.client_instance_id.is_empty()
                        && !plan.project_id.is_empty()
                        && !plan.bridge_epoch.is_empty()
                        && !plan.agent_installation_id.is_empty()
                        && !plan.tool_source.is_empty())
                    .then(|| SshHookBinding {
                        host_id: plan.host_id.clone(),
                        client_instance_id: plan.client_instance_id.clone(),
                        project_id: plan.project_id.clone(),
                        project_name: plan.project_name.clone(),
                        bridge_epoch: plan.bridge_epoch.clone(),
                        installation_id: plan.agent_installation_id.clone(),
                        source: plan.tool_source.clone(),
                    })
                }),
            })),
        );
        Ok(())
    }

    /// hook 上报广播给全部客户端；无客户端时进缓存（有界）。
    fn broadcast_hook(&self, payload: serde_json::Value) {
        let frame = DaemonFrame::HookReport {
            payload: payload.clone(),
        };
        let Ok(clients) = self.clients.lock() else {
            return;
        };
        if clients.is_empty() {
            drop(clients);
            if let Ok(mut cache) = self.hook_cache.lock() {
                cache.push_back(payload);
                while cache.len() > HOOK_CACHE_MAX {
                    cache.pop_front();
                }
            }
            return;
        }
        for client in clients.values() {
            let _ = client.writer.send_frame(&frame);
        }
    }

    pub(crate) fn broadcast_remote_hook_gap(&self, host_id: String, dropped: u64) {
        let frame = DaemonFrame::SshAgentHookGap {
            host_id: host_id.clone(),
            dropped,
        };
        let Ok(clients) = self.clients.lock() else {
            return;
        };
        if clients.is_empty() {
            drop(clients);
            if let Ok(mut cache) = self.hook_gap_cache.lock() {
                cache.push_back((host_id, dropped));
                while cache.len() > HOOK_CACHE_MAX {
                    cache.pop_front();
                }
            }
            return;
        }
        for client in clients.values() {
            let _ = client.writer.send_frame(&frame);
        }
    }

    fn refresh_agents(&self) {
        let Ok(mut tracker) = self.agent_tracker.lock() else {
            return;
        };
        #[cfg(target_os = "windows")]
        let generation = self.agent_refresh_signal.begin();
        if !tracker.refresh() {
            return;
        }
        #[cfg(target_os = "windows")]
        if let Some(generation) = generation {
            self.agent_refresh_signal.complete(generation);
        }
        let sessions = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut changes = Vec::new();
        for session in sessions {
            let Ok(mut entry) = session.lock() else {
                continue;
            };
            if !entry.meta.alive {
                continue;
            }
            let Some(agent) = tracker.discover(&entry.meta, std::process::id(), now_ms()) else {
                continue;
            };
            if let Some(change) = update_agent_detection(&mut entry, agent) {
                changes.push(change);
            }
        }
        if let Ok(clients) = self.clients.lock() {
            for frame in changes {
                for client in clients.values() {
                    let _ = client.writer.send_frame(&frame);
                }
            }
        }
    }

    /// Correlate Hooks to a freshly observed process incarnation, never a shared cwd.
    fn correlate_agent_hook(&self, payload: &mut serde_json::Value) -> bool {
        if matches!(payload.get("environmentType").and_then(|v| v.as_str()), Some("ssh" | "wsl"))
            || payload.get("wslDistroName").and_then(|v| v.as_str()).is_some()
        {
            return true;
        }
        let Some(session_id) = payload.get("tabId").and_then(|v| v.as_str()).map(str::to_owned) else {
            return true;
        };
        let remote = |meta: &SessionMeta| {
            matches!(meta.environment_type.as_deref(), Some("ssh" | "wsl"))
                || meta.shell.as_deref().is_some_and(|shell| shell.to_ascii_lowercase().contains("wsl"))
        };
        let direct = self.get_session(&session_id);
        // Clone session handles before taking any entry/tracker lock. Remote
        // metadata remains authoritative even when a legacy Hook omits its environment.
        let candidates = if let Some(session) = direct.as_ref() {
            let Ok(entry) = session.lock() else { return false; };
            if !entry.meta.alive { return false; }
            if remote(&entry.meta) { return true; }
            vec![(Arc::clone(session), entry.meta.clone())]
        } else {
            let sessions = self.sessions.lock().map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            sessions.into_iter().filter_map(|session| {
                let meta = session.lock().ok()?.meta.clone();
                (meta.alive && !remote(&meta) && meta.root_pid.is_some()).then_some((session, meta))
            }).collect::<Vec<_>>()
        };
        let helper = match payload.get("hookProcessId") {
            Some(value) => match value.as_u64().and_then(|pid| u32::try_from(pid).ok()) {
                Some(pid) if pid > 0 => Some(pid),
                _ => return false,
            },
            None => None,
        };
        let recovering = direct.is_none();
        if candidates.is_empty() || (recovering && helper.is_none()) { return true; }
        if !recovering && candidates[0].1.root_pid.is_none() {
            return candidates[0].1.agent_detection.is_none();
        }
        #[cfg(target_os = "windows")]
        let job_ids = {
            // Wait once, with no entry/tracker lock held. Without Job governance
            // only a watchdog sample begun after arrival may supply candidate PIDs.
            let Some(arrival) = self.agent_refresh_signal.arrival() else { return false; };
            let ids = super::governed_process_ids();
            if ids.is_none()
                && !self.agent_refresh_signal.wait_after(arrival, Duration::from_millis(1500))
            {
                return false;
            }
            ids
        };
        let Ok(mut tracker) = self.agent_tracker.lock() else { return false; };
        #[cfg(target_os = "windows")]
        let shared_observation = {
            let metas = candidates.iter().map(|(_, meta)| meta.clone()).collect::<Vec<_>>();
            // One native Job/PID snapshot serves every possible owner. Metadata
            // and helper ancestry are still revalidated for each root below.
            tracker.observe_windows_hook(&metas, helper, job_ids.as_deref())
        };
        let source = payload.get("source").and_then(|v| v.as_str());
        let mut owners = Vec::new();
        for (session, meta) in candidates {
            #[cfg(not(target_os = "windows"))]
            let observation = tracker.observe_hook(&meta, helper);
            #[cfg(not(target_os = "windows"))]
            let observation = observation.as_ref();
            #[cfg(target_os = "windows")]
            let observation = shared_observation.as_ref();
            let Some(observation) = observation else { continue; };
            let Some(discovered) = observation.discover(&meta, std::process::id(), now_ms()) else { continue; };
            if recovering {
                let Some(agent) = discovered.as_ref() else { continue; };
                if source != Some(agent.tool.as_str())
                    || !observation.belongs_to(helper.unwrap(), agent.pid)
                {
                    continue;
                }
            } else if let (Some(pid), Some(agent)) = (helper, discovered.as_ref()) {
                if !observation.belongs_to(pid, agent.pid) { return false; }
            }
            owners.push((session, meta, discovered));
        }
        // An external Hook without a unique live owner remains external. The
        // frontend likewise refuses path-only attribution, including same-cwd tabs.
        if owners.len() != 1 { return recovering; }
        let (session, observed, discovered) = owners.pop().unwrap();
        if !self.get_session(&observed.session_id).is_some_and(|current| Arc::ptr_eq(&current, &session)) {
            return false;
        }
        let Ok(mut entry) = session.lock() else { return false; };
        if !entry.meta.alive || remote(&entry.meta)
            || entry.meta.root_pid != observed.root_pid
            || entry.meta.root_started_at != observed.root_started_at
        {
            return false;
        }
        let change = update_agent_detection(&mut entry, discovered);
        let detection = entry.meta.agent_detection.clone().unwrap();
        drop(entry);
        drop(tracker);
        if let Some(change) = change {
            if let Ok(clients) = self.clients.lock() {
                for client in clients.values() { let _ = client.writer.send_frame(&change); }
            }
        }
        let Some(agent) = detection.agent.as_ref() else { return false; };
        if source != Some(agent.tool.as_str()) { return false; }
        if recovering { payload["tabId"] = serde_json::json!(observed.session_id); }
        payload["agentRunId"] = serde_json::json!(agent.run_id);
        // WebSocket metadata and the Tauri Hook relay can arrive in either order.
        payload["agentDetection"] = serde_json::json!(detection);
        true
    }

    fn update_task_status_from_hook(&self, payload: &serde_json::Value) {
        // Codex child turn hooks carry the parent session_id and tabId.
        // Their lifecycle belongs to the transcript pane, not the parent task.
        if payload.get("source").and_then(|v| v.as_str()) == Some("codex")
            && payload.get("agentId").and_then(|v| v.as_str())
                .is_some_and(|id| !id.trim().is_empty())
            && matches!(payload.get("event").and_then(|v| v.as_str()),
                Some("SessionStart" | "UserPromptSubmit" | "Stop" | "SubagentStart" | "SubagentStop"))
        {
            return;
        }
        let Some(session_id) = payload
            .get("tabId")
            .or_else(|| payload.get("tab_id"))
            .and_then(|value| value.as_str())
        else {
            return;
        };
        let Some(event) = payload.get("event").and_then(|value| value.as_str()) else {
            return;
        };
        let task_status = map_hook_event_to_task_status(event);
        let updated_at_ms = now_ms();
        if let Some(session) = self.get_session(session_id) {
            if let Ok(mut entry) = session.lock() {
                if let Some(run_id) = payload.get("agentRunId").and_then(|v| v.as_str()) {
                    if entry
                        .meta
                        .agent_detection
                        .as_ref()
                        .and_then(|d| d.agent.as_ref())
                        .map(|a| a.run_id.as_str())
                        != Some(run_id)
                    {
                        return;
                    }
                }
                if let Some(id) = payload
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .filter(|id| !id.trim().is_empty())
                {
                    if let Some(agent) = entry
                        .meta
                        .agent_detection
                        .as_mut()
                        .and_then(|d| d.agent.as_mut())
                    {
                        if agent.cli_session_id.as_deref() != Some(id) {
                            agent.cli_session_id = Some(id.to_string());
                            if let Some(detection) = entry.meta.agent_detection.as_mut() {
                                detection.updated_at_ms = updated_at_ms;
                            }
                        }
                    }
                }
                let Some(task_status) = task_status else {
                    return;
                };
                entry.meta.task_status = Some(task_status.to_string());
                entry.meta.task_updated_at_ms = Some(updated_at_ms);
                log::debug!(
                    "daemon task status updated: session_id={}, event={}, status={}",
                    session_id,
                    event,
                    task_status
                );
            }
        }
    }

    /// 新客户端连上后补发缓存的 hook 上报。
    fn flush_hook_cache_to(&self, writer: &Arc<ClientWriter>) {
        let cached: Vec<serde_json::Value> = match self.hook_cache.lock() {
            Ok(mut cache) => cache.drain(..).collect(),
            Err(_) => return,
        };
        for payload in cached {
            let _ = writer.send_frame(&DaemonFrame::HookReport { payload });
        }
        let gaps: Vec<(String, u64)> = match self.hook_gap_cache.lock() {
            Ok(mut cache) => cache.drain(..).collect(),
            Err(_) => return,
        };
        for (host_id, dropped) in gaps {
            let _ = writer.send_frame(&DaemonFrame::SshAgentHookGap { host_id, dropped });
        }
    }

    fn alive_session_count(&self) -> usize {
        let sessions = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        sessions
            .into_iter()
            .filter(|session| {
                session
                    .lock()
                    .map(|entry| entry.meta.alive)
                    .unwrap_or(false)
            })
            .count()
    }

    fn client_count(&self) -> usize {
        self.clients.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// 总 buffer 超限时从最旧的 exited 会话开始整会话丢弃（契约资源上限）。
    fn enforce_total_buffer_cap(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let mut total: usize = sessions
            .values()
            .filter_map(|session| session.lock().ok().map(|entry| entry.buffer.total_bytes))
            .sum();
        if total <= TOTAL_BUFFER_MAX_BYTES {
            return;
        }
        let mut exited: Vec<(String, u64, usize)> = sessions
            .iter()
            .filter_map(|(id, session)| {
                let entry = session.lock().ok()?;
                (!entry.meta.alive).then(|| {
                    (
                        id.clone(),
                        entry.meta.created_at_ms,
                        entry.buffer.total_bytes,
                    )
                })
            })
            .collect();
        exited.sort_by_key(|(_, created, _)| *created);
        for (id, _, bytes) in exited {
            if total <= TOTAL_BUFFER_MAX_BYTES {
                break;
            }
            sessions.remove(&id);
            total -= bytes;
            log::warn!("daemon dropped exited session buffer to enforce cap: id={id}");
        }
    }

    /// 向所有 attach 了该会话的客户端推送一帧；写失败的客户端跳过（由其读线程负责回收）。
    fn push_to_attached(&self, session_id: &str, frame: &DaemonFrame) {
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        for client in clients.values_mut() {
            if !client.attached.contains(session_id) {
                continue;
            }
            if let Some(buffered) = client.attaching.get_mut(session_id) {
                buffered.push(frame.clone());
                continue;
            }
            if client.writer.send_frame(frame).is_err() {
                client.writer.close();
            }
        }
    }

    fn push_output_to_attached(
        &self,
        session_id: &str,
        sequence: u64,
        char_count: usize,
        frame: &DaemonFrame,
    ) {
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        for client in clients.values_mut() {
            if !client.attached.contains(session_id) {
                continue;
            }
            let unacknowledged = {
                let count = client
                    .unacknowledged_chars
                    .entry(session_id.to_string())
                    .or_default();
                *count += char_count;
                *count
            };
            if unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                client.flow_control_paused.insert(session_id.to_string());
            }
            client
                .last_sent_sequence
                .insert(session_id.to_string(), sequence);
            if let Some(buffered) = client.attaching.get_mut(session_id) {
                buffered.push(frame.clone());
                let buffered_bytes = buffered.iter().map(frame_payload_bytes).sum::<usize>();
                if buffered_bytes > CLIENT_OUTPUT_QUEUE_MAX_BYTES {
                    client.writer.close();
                    client.attached.remove(session_id);
                    client.flow_control_paused.remove(session_id);
                }
                continue;
            }
            if client.writer.send_frame(frame).is_err() {
                client.writer.close();
                client.attached.remove(session_id);
                client.unacknowledged_chars.remove(session_id);
                client.flow_control_paused.remove(session_id);
                client.last_sent_sequence.remove(session_id);
                client.last_acknowledged_sequence.remove(session_id);
            }
        }
    }

    fn complete_attach(&self, client_id: u64, session_id: &str) {
        let Ok(mut clients) = self.clients.lock() else {
            return;
        };
        let Some(client) = clients.get_mut(&client_id) else {
            return;
        };
        let Some(buffered) = client.attaching.remove(session_id) else {
            return;
        };
        for frame in buffered {
            if client.writer.send_frame(&frame).is_err() {
                client.writer.close();
                client.attached.remove(session_id);
                client.flow_control_paused.remove(session_id);
                break;
            }
        }
    }

    fn acknowledge_output(
        &self,
        client_id: u64,
        session_id: &str,
        sequence: u64,
        char_count: usize,
    ) {
        if let Ok(mut clients) = self.clients.lock() {
            if let Some(client) = clients.get_mut(&client_id) {
                let last_sent = client
                    .last_sent_sequence
                    .get(session_id)
                    .copied()
                    .unwrap_or(0);
                let last_acknowledged = client
                    .last_acknowledged_sequence
                    .get(session_id)
                    .copied()
                    .unwrap_or(0);
                if sequence > last_acknowledged && sequence <= last_sent {
                    let remaining = client
                        .unacknowledged_chars
                        .entry(session_id.to_string())
                        .or_default();
                    *remaining = remaining.saturating_sub(char_count);
                    client
                        .last_acknowledged_sequence
                        .insert(session_id.to_string(), sequence);
                    if *remaining <= CLIENT_OUTPUT_LOW_WATERMARK {
                        client.flow_control_paused.remove(session_id);
                    }
                }
            }
        }
        self.notify_output_flow_control();
    }

    fn detach_session_from_clients(&self, session_id: &str) {
        if let Ok(mut clients) = self.clients.lock() {
            for client in clients.values_mut() {
                client.attached.remove(session_id);
                client.unacknowledged_chars.remove(session_id);
                client.flow_control_paused.remove(session_id);
                client.last_sent_sequence.remove(session_id);
                client.last_acknowledged_sequence.remove(session_id);
                client.attaching.remove(session_id);
            }
        }
        self.notify_output_flow_control();
    }

    fn detach_all_sessions_from_clients(&self) {
        if let Ok(mut clients) = self.clients.lock() {
            for client in clients.values_mut() {
                client.attached.clear();
                client.unacknowledged_chars.clear();
                client.flow_control_paused.clear();
                client.last_sent_sequence.clear();
                client.last_acknowledged_sequence.clear();
                client.attaching.clear();
            }
        }
        self.notify_output_flow_control();
    }

    fn wait_for_output_capacity(&self, session_id: &str) -> bool {
        let (lock, changed) = &self.output_flow_control;
        let mut state = match lock.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        loop {
            let can_continue = match self.clients.lock() {
                Ok(mut clients) => {
                    let mut blocked = false;
                    for client in clients.values_mut() {
                        if !client.attached.contains(session_id) {
                            continue;
                        }
                        let unacknowledged = client
                            .unacknowledged_chars
                            .get(session_id)
                            .copied()
                            .unwrap_or(0);
                        if client.flow_control_paused.contains(session_id) {
                            if unacknowledged > CLIENT_OUTPUT_LOW_WATERMARK {
                                blocked = true;
                            } else {
                                client.flow_control_paused.remove(session_id);
                            }
                        } else if unacknowledged >= CLIENT_OUTPUT_HIGH_WATERMARK {
                            client.flow_control_paused.insert(session_id.to_string());
                            blocked = true;
                        }
                    }
                    !blocked
                }
                Err(_) => return false,
            };
            if can_continue {
                return true;
            }
            state = match changed.wait(state) {
                Ok(state) => state,
                Err(_) => return false,
            };
        }
    }

    fn notify_output_flow_control(&self) {
        let Ok(_state) = self.output_flow_control.0.lock() else {
            return;
        };
        self.output_flow_control.1.notify_all();
    }
}

/// daemon 侧 [`PtyEventSink`]：输出进 ring buffer 并推送给订阅客户端。
struct DaemonPtyEventSink {
    sender: SyncSender<DaemonPtyEvent>,
}

enum DaemonPtyEvent {
    Output(Vec<u8>),
    Status(PtyProcessStatus),
}

impl DaemonPtyEventSink {
    fn new(host: Arc<DaemonHost>, session_id: String) -> Self {
        let (sender, receiver) = sync_channel(1);
        std::thread::spawn(move || {
            let mut carried = None;
            loop {
                let first = match carried.take().or_else(|| receiver.recv().ok()) {
                    Some(event) => event,
                    None => return,
                };
                match first {
                    DaemonPtyEvent::Status(status) => {
                        emit_daemon_status(&host, &session_id, status);
                        return;
                    }
                    DaemonPtyEvent::Output(data) => {
                        let mut pending = data;
                        let deadline = Instant::now() + OUTPUT_BUFFERING_DURATION;
                        let mut final_status = None;
                        while pending.len() < OUTPUT_BUFFERING_MAX_BYTES {
                            let now = Instant::now();
                            if now >= deadline {
                                break;
                            }
                            match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
                                Ok(DaemonPtyEvent::Output(data)) => {
                                    if output_batch_would_overflow(pending.len(), data.len()) {
                                        carried = Some(DaemonPtyEvent::Output(data));
                                        break;
                                    }
                                    pending.extend_from_slice(&data);
                                }
                                Ok(DaemonPtyEvent::Status(status)) => {
                                    final_status = Some(status);
                                    break;
                                }
                                Err(RecvTimeoutError::Timeout) => break,
                                Err(RecvTimeoutError::Disconnected) => break,
                            }
                        }
                        emit_daemon_output(&host, &session_id, &pending);
                        if let Some(status) = final_status {
                            emit_daemon_status(&host, &session_id, status);
                            return;
                        }
                    }
                }
            }
        });
        Self { sender }
    }
}

fn output_batch_would_overflow(pending_bytes: usize, next_bytes: usize) -> bool {
    pending_bytes > 0 && pending_bytes.saturating_add(next_bytes) > OUTPUT_BUFFERING_MAX_BYTES
}

impl PtyEventSink for DaemonPtyEventSink {
    fn on_output(&self, _session_id: &str, data: &[u8]) {
        let _ = self.sender.send(DaemonPtyEvent::Output(data.to_vec()));
    }

    fn on_status(&self, _session_id: &str, status: PtyProcessStatus) {
        let _ = self.sender.send(DaemonPtyEvent::Status(status));
    }
}

fn emit_daemon_output(host: &DaemonHost, session_id: &str, data: &[u8]) {
    let char_count = String::from_utf8_lossy(data).encode_utf16().count();
    let data: Arc<[u8]> = Arc::from(data);
    let mut sequence = 0;
    let mut output_size = (80, 24);
    if let Some(session) = host.get_session(session_id) {
        if let Ok(mut entry) = session.lock() {
            sequence = entry.next_sequence;
            entry.next_sequence = entry.next_sequence.saturating_add(1);
            output_size = (entry.cols, entry.rows);
            entry
                .buffer
                .push_shared_output(output_size.0, output_size.1, sequence, Arc::clone(&data));
            entry.meta.replay_available = entry.buffer.replay_available();
            entry.meta.replay_truncated = entry.buffer.truncated;
        }
    }
    if sequence == 0 {
        return;
    }
    if !host.wait_for_output_capacity(session_id) {
        return;
    }
    host.push_output_to_attached(
        session_id,
        sequence,
        char_count,
        &DaemonFrame::Output {
            session_id: session_id.to_string(),
            sequence,
            cols: output_size.0,
            rows: output_size.1,
            data,
        },
    );
}

fn emit_daemon_status(host: &DaemonHost, session_id: &str, status: PtyProcessStatus) {
    if status.status == "running" {
        return;
    }
    if let Some(session) = host.get_session(session_id) {
        if let Ok(mut entry) = session.lock() {
            entry.meta.alive = false;
            entry.meta.agent_detection = Some(AgentDetection {
                agent: None,
                updated_at_ms: now_ms(),
            });
            if !matches!(entry.meta.task_status.as_deref(), Some("done" | "failed")) {
                entry.meta.task_status = Some(if status.status == "error" {
                    "failed".to_string()
                } else {
                    "done".to_string()
                });
                entry.meta.task_updated_at_ms = Some(now_ms());
            }
        }
    }
    host.push_to_attached(
        session_id,
        &DaemonFrame::Exit {
            session_id: session_id.to_string(),
            exit_code: status.exit_code,
        },
    );
    host.release_ssh_agent_bridge(session_id);
    host.enforce_total_buffer_cap();
}

pub struct DaemonServer {
    host: Arc<DaemonHost>,
    next_client_id: AtomicU64,
    token: String,
    version: String,
    info_path: PathBuf,
}

pub struct DaemonServerConfig {
    pub info_path: PathBuf,
    pub version: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// sessionId 白名单校验：uuid/字母数字与连字符，防注入与异常键（不可信输入契约）。
fn is_valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn map_hook_event_to_task_status(event: &str) -> Option<&'static str> {
    match event {
        "UserPromptSubmit" => Some("running"),
        "Notification" | "PermissionRequest" => Some("attention"),
        "Stop" => Some("done"),
        "StopFailure" => Some("failed"),
        _ => None,
    }
}

fn websocket_error(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}

fn is_allowed_webview_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("https://127.0.0.1:")
}

fn validate_websocket_request(
    request: &Request,
    response: Response,
) -> Result<Response, ErrorResponse> {
    if request.uri().path() != "/pty" {
        return Err(websocket_error(StatusCode::NOT_FOUND, "not found"));
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !is_allowed_webview_origin(origin) {
        return Err(websocket_error(StatusCode::FORBIDDEN, "origin rejected"));
    }
    Ok(response)
}

enum WebSocketClientMessage {
    Text(String),
    Binary(Vec<u8>),
}

fn read_websocket_client_message(
    socket: &mut WebSocket<TcpStream>,
) -> Option<WebSocketClientMessage> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) if text.len() <= MAX_FRAME_BYTES => {
                return Some(WebSocketClientMessage::Text(text.to_string()))
            }
            Ok(Message::Text(_)) => return None,
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(Message::Binary(data)) if data.len() <= MAX_FRAME_BYTES => {
                return Some(WebSocketClientMessage::Binary(data.to_vec()))
            }
            Ok(Message::Binary(_)) => return None,
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => continue,
        }
    }
}

impl DaemonServer {
    /// 绑定 127.0.0.1 随机端口、独占写入发现文件并进入 accept 循环（阻塞）。
    /// 返回 Err 仅发生在启动阶段（端口/发现文件失败，例如已有实例存活）。
    pub fn run(config: DaemonServerConfig) -> Result<(), String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("daemon bind failed: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("daemon local_addr failed: {err}"))?
            .port();
        let ws_listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("daemon websocket bind failed: {err}"))?;
        let ws_port = ws_listener
            .local_addr()
            .map_err(|err| format!("daemon websocket local_addr failed: {err}"))?
            .port();
        // hook 上报稳定端口：PTY 子进程环境变量指向它，app 重启也不失效（契约★）。
        let hook_listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|err| format!("daemon hook bind failed: {err}"))?;
        let hook_port = hook_listener
            .local_addr()
            .map_err(|err| format!("daemon hook local_addr failed: {err}"))?
            .port();
        let token = uuid::Uuid::new_v4().to_string();
        let info = DaemonInfo {
            port,
            ws_port,
            hook_port,
            token: token.clone(),
            pid: std::process::id(),
            version: config.version.clone(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            binary_protocol_version: BINARY_PROTOCOL_VERSION,
            features: supported_features(),
        };
        // 独占创建：已存在存活实例时这里失败，新 daemon 立即退出（单实例契约）。
        write_daemon_info_exclusive(&config.info_path, &info)?;
        log::info!(
            "cli-manager-daemon listening on 127.0.0.1:{port}, websocket on {ws_port}, hook on {hook_port}"
        );

        let spool_dir = config.info_path.with_file_name(format!(
            "{}.spool",
            config
                .info_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("daemon")
        ));
        let _ = std::fs::remove_dir_all(&spool_dir);
        if let Err(err) = std::fs::create_dir_all(&spool_dir) {
            log::warn!("daemon spool directory unavailable, output will remain in memory: {err}");
        }
        let server = Arc::new(DaemonServer {
            host: Arc::new(DaemonHost::with_spool_dir(spool_dir)),
            next_client_id: AtomicU64::new(1),
            token: token.clone(),
            version: config.version,
            info_path: config.info_path,
        });

        let hook_host = Arc::clone(&server.host);
        let dispatcher = DispatcherHandle::start("daemon");
        let hook_sink: HookPayloadSink = Arc::new(move |payload| {
            let Ok(mut value) = serde_json::to_value(&payload) else {
                return Ok(());
            };
            if !hook_host.correlate_agent_hook(&mut value) {
                return Ok(());
            }
            deliver_durable_hook(value, crate::commands::notification_inbox::record_hook, |value| {
                // 仅当没有已连接的前端客户端时才拉起 app 处理审批或回答。
                // app 正在运行时交给前端决定通知/切换，绝不抢占前台。
                if hook_host.client_count() == 0 {
                    let target_tab_id = value.get("tabId").and_then(|id| id.as_str())
                        .unwrap_or_else(|| payload.tab_id());
                    maybe_activate_app_for_hook(&payload, target_tab_id);
                }
                dispatcher.try_enqueue(payload.to_notification_job());
                hook_host.update_task_status_from_hook(&value);
                hook_host.broadcast_hook(value);
            })
        });
        server.host.set_hook_sink(Arc::clone(&hook_sink));
        spawn_hook_listener(hook_listener, token, hook_sink);

        server.spawn_idle_watchdog();
        let agent_host = Arc::clone(&server.host);
        std::thread::spawn(move || loop {
            if agent_host.alive_session_count() > 0 {
                agent_host.refresh_agents();
            }
            std::thread::sleep(Duration::from_secs(1));
        });

        let websocket_server = Arc::clone(&server);
        std::thread::spawn(move || {
            for stream in ws_listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let server = Arc::clone(&websocket_server);
                        std::thread::spawn(move || server.handle_websocket_connection(stream));
                    }
                    Err(err) => log::warn!("daemon websocket accept failed: {err}"),
                }
            }
        });

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let server = Arc::clone(&server);
                    std::thread::spawn(move || server.handle_connection(stream));
                }
                Err(err) => log::warn!("daemon accept failed: {err}"),
            }
        }
        Ok(())
    }

    fn spawn_idle_watchdog(self: &Arc<Self>) {
        let server = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(IDLE_CHECK_INTERVAL);
            let busy = server.host.client_count() > 0 || server.host.alive_session_count() > 0;
            let Ok(mut idle_since) = server.host.last_idle_since.lock() else {
                continue;
            };
            if busy {
                *idle_since = Instant::now();
                continue;
            }
            if idle_since.elapsed() >= IDLE_EXIT_AFTER {
                log::info!("daemon idle (no clients, no alive sessions), exiting");
                remove_daemon_info(&server.info_path);
                std::process::exit(0);
            }
        });
    }

    fn handle_connection(self: Arc<Self>, stream: TcpStream) {
        let peer = stream
            .peer_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        let writer = match stream.try_clone() {
            Ok(writer) => ClientWriter::new(ClientTransport::Ndjson(Mutex::new(writer))),
            Err(err) => {
                log::warn!("daemon stream clone failed ({peer}): {err}");
                return;
            }
        };
        let mut reader = BufReader::new(stream);

        // 首帧必须 Auth，失败立即断连（契约）。
        match read_line_bounded(&mut reader) {
            Some(line) => match decode_client_frame(&line) {
                Ok(ClientFrame::Auth { token, .. }) if token == self.token => {
                    let _ = writer.send_frame(&DaemonFrame::AuthOk {
                        daemon_version: self.version.clone(),
                        pid: std::process::id(),
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        binary_protocol_version: BINARY_PROTOCOL_VERSION,
                        features: supported_features(),
                    });
                }
                _ => {
                    log::warn!("daemon auth rejected ({peer})");
                    let _ = writer.send_frame(&DaemonFrame::AuthErr {
                        reason: "auth_failed".to_string(),
                    });
                    return;
                }
            },
            None => return,
        }

        let client_id = self.next_client_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut clients) = self.host.clients.lock() {
            clients.insert(
                client_id,
                ClientHandle {
                    writer: Arc::clone(&writer),
                    attached: HashSet::new(),
                    unacknowledged_chars: HashMap::new(),
                    flow_control_paused: HashSet::new(),
                    last_sent_sequence: HashMap::new(),
                    last_acknowledged_sequence: HashMap::new(),
                    attaching: HashMap::new(),
                },
            );
        }
        log::debug!("daemon client connected ({peer}, id={client_id})");

        while let Some(line) = read_line_bounded(&mut reader) {
            match decode_client_frame(&line) {
                Ok(frame) => {
                    if !self.dispatch(client_id, frame, &writer) {
                        break;
                    }
                }
                Err(ProtocolError::UnknownType(kind)) => {
                    // 前向兼容：未知 type 回错误帧但保持连接。
                    let _ = writer.send_frame(&DaemonFrame::Err {
                        id: 0,
                        message: format!("unknown frame type: {kind}"),
                    });
                }
                Err(ProtocolError::Malformed(reason)) => {
                    log::warn!("daemon malformed frame ({peer}): {reason}");
                    break; // 非法帧断连（契约）。
                }
            }
        }

        if let Ok(mut clients) = self.host.clients.lock() {
            if let Some(client) = clients.remove(&client_id) {
                client.writer.close();
            }
        }
        self.host.notify_output_flow_control();
        log::debug!("daemon client disconnected ({peer}, id={client_id})");
    }

    fn handle_websocket_connection(self: Arc<Self>, stream: TcpStream) {
        let peer = stream
            .peer_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        let mut socket = match accept_hdr(stream, validate_websocket_request) {
            Ok(socket) => socket,
            Err(err) => {
                log::warn!("daemon websocket handshake rejected ({peer}): {err}");
                return;
            }
        };
        let writer_stream = match socket.get_ref().try_clone() {
            Ok(stream) => stream,
            Err(err) => {
                log::warn!("daemon websocket stream clone failed ({peer}): {err}");
                return;
            }
        };
        let writer = ClientWriter::new(ClientTransport::WebSocket(Mutex::new(
            WebSocket::from_raw_socket(writer_stream, Role::Server, None),
        )));

        match read_websocket_client_message(&mut socket) {
            Some(WebSocketClientMessage::Text(line)) => match decode_client_frame(&line) {
                Ok(ClientFrame::Auth { token, .. }) if token == self.token => {
                    let _ = writer.send_frame(&DaemonFrame::AuthOk {
                        daemon_version: self.version.clone(),
                        pid: std::process::id(),
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        binary_protocol_version: BINARY_PROTOCOL_VERSION,
                        features: supported_features(),
                    });
                }
                _ => {
                    let _ = writer.send_frame(&DaemonFrame::AuthErr {
                        reason: "auth_failed".to_string(),
                    });
                    return;
                }
            },
            Some(WebSocketClientMessage::Binary(_)) | None => return,
        }

        let client_id = self.next_client_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut clients) = self.host.clients.lock() {
            clients.insert(
                client_id,
                ClientHandle {
                    writer: Arc::clone(&writer),
                    attached: HashSet::new(),
                    unacknowledged_chars: HashMap::new(),
                    flow_control_paused: HashSet::new(),
                    last_sent_sequence: HashMap::new(),
                    last_acknowledged_sequence: HashMap::new(),
                    attaching: HashMap::new(),
                },
            );
        }
        log::debug!("daemon websocket client connected ({peer}, id={client_id})");

        while let Some(message) = read_websocket_client_message(&mut socket) {
            match message {
                WebSocketClientMessage::Text(line) => match decode_client_frame(&line) {
                    Ok(frame) => {
                        if !self.dispatch(client_id, frame, &writer) {
                            break;
                        }
                    }
                    Err(ProtocolError::UnknownType(kind)) => {
                        let _ = writer.send_frame(&DaemonFrame::Err {
                            id: 0,
                            message: format!("unknown frame type: {kind}"),
                        });
                    }
                    Err(ProtocolError::Malformed(reason)) => {
                        log::warn!("daemon websocket malformed frame ({peer}): {reason}");
                        break;
                    }
                },
                WebSocketClientMessage::Binary(data) => {
                    if !self.handle_binary_frame(client_id, &data, &writer) {
                        break;
                    }
                }
            }
        }

        if let Ok(mut clients) = self.host.clients.lock() {
            if let Some(client) = clients.remove(&client_id) {
                client.writer.close();
            }
        }
        self.host.notify_output_flow_control();
        log::debug!("daemon websocket client disconnected ({peer}, id={client_id})");
    }

    fn handle_binary_frame(&self, client_id: u64, data: &[u8], writer: &Arc<ClientWriter>) -> bool {
        let frame = match decode_binary_terminal_frame(data) {
            Ok(frame) => frame,
            Err(message) => {
                let _ = writer.send_frame(&DaemonFrame::Err { id: 0, message });
                return false;
            }
        };
        let attached = self
            .host
            .clients
            .lock()
            .ok()
            .and_then(|clients| {
                clients
                    .get(&client_id)
                    .map(|client| client.attached.contains(&frame.session_id))
            })
            .unwrap_or(false);
        if !attached || !is_valid_session_id(&frame.session_id) {
            let _ = writer.send_frame(&DaemonFrame::Err {
                id: 0,
                message: "binary frame session is not attached".to_string(),
            });
            return false;
        }
        match frame.kind {
            BINARY_KIND_INPUT => self
                .host
                .pty
                .write_bytes(&frame.session_id, &frame.data)
                .is_ok(),
            BINARY_KIND_CHECKPOINT => {
                let result = self
                    .host
                    .get_session(&frame.session_id)
                    .ok_or_else(|| "session not found".to_string())
                    .and_then(|session| {
                        let mut entry = session
                            .lock()
                            .map_err(|_| "session state unavailable".to_string())?;
                        let latest_sequence = entry.next_sequence.saturating_sub(1);
                        if frame.sequence > latest_sequence {
                            return Err("checkpoint sequence is ahead of daemon output".to_string());
                        }
                        entry.buffer.accept_checkpoint(
                            frame.cols,
                            frame.rows,
                            frame.sequence,
                            frame.data,
                        )?;
                        entry.meta.replay_available = entry.buffer.replay_available();
                        entry.meta.replay_truncated = entry.buffer.truncated;
                        Ok(())
                    });
                let response = match result {
                    Ok(()) => DaemonFrame::CheckpointAccepted {
                        session_id: frame.session_id,
                        sequence: frame.sequence,
                    },
                    Err(message) => DaemonFrame::CheckpointRejected {
                        session_id: frame.session_id,
                        sequence: frame.sequence,
                        message,
                    },
                };
                writer.send_frame(&response).is_ok()
            }
            _ => false,
        }
    }

    /// 返回 false 表示应结束该连接。
    fn dispatch(
        self: &Arc<Self>,
        client_id: u64,
        frame: ClientFrame,
        writer: &Arc<ClientWriter>,
    ) -> bool {
        // 积压 hook 上报在首次 List 时补发（而非连接瞬间）：此时前端 webview
        // 的事件监听器已就绪（恢复流程先查会话列表），避免 re-emit 被丢。
        if matches!(frame, ClientFrame::List { .. }) {
            self.host.flush_hook_cache_to(writer);
        }
        if matches!(frame, ClientFrame::SshAgentRequest { .. }) {
            let server = Arc::clone(self);
            let writer = Arc::clone(writer);
            std::thread::spawn(move || {
                let reply = server.handle_frame(client_id, frame);
                let _ = writer.send_frame(&reply);
            });
            return true;
        }
        let attach_session_id = match &frame {
            ClientFrame::Attach { session_id, .. } => Some(session_id.clone()),
            _ => None,
        };
        let reply = self.handle_frame(client_id, frame);
        let sent = writer.send_frame(&reply).is_ok();
        if sent && matches!(reply, DaemonFrame::Attached { .. }) {
            if let Some(session_id) = attach_session_id {
                self.host.complete_attach(client_id, &session_id);
            }
        }
        sent
    }

    fn handle_frame(&self, client_id: u64, frame: ClientFrame) -> DaemonFrame {
        match frame {
            ClientFrame::Auth { .. } => DaemonFrame::Err {
                id: 0,
                message: "already authenticated".to_string(),
            },
            ClientFrame::Ping { id } => DaemonFrame::Pong { id },
            ClientFrame::List { id } => {
                let session_handles = self
                    .host
                    .sessions
                    .lock()
                    .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                let sessions = session_handles
                    .into_iter()
                    .filter_map(|session| session.lock().ok().map(|entry| entry.meta.clone()))
                    .collect();
                DaemonFrame::Sessions { id, sessions }
            }
            ClientFrame::Create {
                id,
                session_id,
                cwd,
                env_vars,
                shell,
                ssh_launch,
                terminal_colors,
            } => self.handle_create(
                client_id,
                id,
                session_id,
                cwd,
                env_vars,
                shell,
                ssh_launch,
                terminal_colors,
            ),
            ClientFrame::SetTerminalColors {
                id,
                session_id,
                terminal_colors,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self.host.pty.update_terminal_colors(
                    &session_id,
                    &terminal_colors.foreground,
                    &terminal_colors.background,
                ) {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Write {
                id,
                session_id,
                data,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self.host.pty.write(&session_id, &data) {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Ack {
                id,
                session_id,
                sequence,
                char_count,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                self.host
                    .acknowledge_output(client_id, &session_id, sequence, char_count);
                DaemonFrame::Ok { id }
            }
            ClientFrame::Resize {
                id,
                session_id,
                cols,
                rows,
                pixel_width,
                pixel_height,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                match self
                    .host
                    .pty
                    .resize(&session_id, cols, rows, pixel_width, pixel_height)
                {
                    Ok(()) => {
                        if let Some(session) = self.host.get_session(&session_id) {
                            if let Ok(mut entry) = session.lock() {
                                entry.cols = cols;
                                entry.rows = rows;
                                let sequence = entry.next_sequence;
                                entry.next_sequence = entry.next_sequence.saturating_add(1);
                                entry.buffer.push_resize(cols, rows, sequence);
                            }
                        }
                        DaemonFrame::Ok { id }
                    }
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Close { id, session_id } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                let result = self.host.pty.close(&session_id);
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.remove(&session_id);
                }
                self.host.detach_session_from_clients(&session_id);
                match result {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::CloseAll { id } => {
                let result = self.host.pty.close_all();
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.clear();
                }
                self.host.detach_all_sessions_from_clients();
                match result {
                    Ok(()) => DaemonFrame::Ok { id },
                    Err(message) => DaemonFrame::Err { id, message },
                }
            }
            ClientFrame::Attach {
                id,
                session_id,
                after_sequence,
            } => {
                if !is_valid_session_id(&session_id) {
                    return err_frame(id, "invalid session id");
                }
                // Keep the replay snapshot and subscription registration atomic
                // relative to on_output (sessions -> clients). Output produced
                // before this block is replayed; output produced after it is live.
                let attach_info = self
                    .host
                    .get_session(&session_id)
                    .ok_or_else(|| "session not found".to_string())
                    .and_then(|session| {
                        let entry = session
                            .lock()
                            .map_err(|_| "session state unavailable".to_string())?;
                        let meta = entry.meta.clone();
                        let oldest_sequence = entry.buffer.oldest_sequence().unwrap_or(0);
                        let replay_reset = after_sequence
                            .map(|sequence| sequence.saturating_add(1) < oldest_sequence)
                            .unwrap_or(true);
                        let replay_entries = if replay_reset {
                            entry.buffer.replay_entries()
                        } else {
                            entry.buffer.replay_entries_after(after_sequence)
                        }
                        .map_err(|err| format!("session replay unavailable: {err}"))?;
                        let latest_sequence = entry.next_sequence.saturating_sub(1);
                        let mut clients = self
                            .host
                            .clients
                            .lock()
                            .map_err(|_| "client state unavailable".to_string())?;
                        let client = clients
                            .get_mut(&client_id)
                            .ok_or_else(|| "client not found".to_string())?;
                        client.attached.insert(session_id.clone());
                        client.unacknowledged_chars.insert(session_id.clone(), 0);
                        client.flow_control_paused.remove(&session_id);
                        client
                            .last_sent_sequence
                            .insert(session_id.clone(), latest_sequence);
                        client
                            .last_acknowledged_sequence
                            .insert(session_id.clone(), latest_sequence);
                        client.attaching.insert(session_id.clone(), Vec::new());
                        Ok((
                            meta,
                            replay_entries,
                            latest_sequence,
                            replay_reset,
                            oldest_sequence,
                        ))
                    });
                match attach_info {
                    Ok((meta, replay_entries, latest_sequence, replay_reset, oldest_sequence)) => {
                        DaemonFrame::Attached {
                            id,
                            session_id,
                            replay_base64: String::new(),
                            replay: replay_entries,
                            latest_sequence,
                            meta,
                            replay_reset,
                            replay_truncated: false,
                            oldest_sequence,
                        }
                    }
                    Err(message) => err_frame(id, &message),
                }
            }
            ClientFrame::Detach { id } => {
                if let Ok(mut clients) = self.host.clients.lock() {
                    if let Some(client) = clients.get_mut(&client_id) {
                        client.attached.clear();
                        client.unacknowledged_chars.clear();
                        client.last_sent_sequence.clear();
                        client.last_acknowledged_sequence.clear();
                        client.attaching.clear();
                    }
                }
                DaemonFrame::Ok { id }
            }
            ClientFrame::Reconcile {
                id,
                active_session_ids,
            } => {
                let active_count = active_session_ids
                    .iter()
                    .filter(|session_id| !session_id.trim().is_empty())
                    .count();
                let tracked_count = self
                    .host
                    .sessions
                    .lock()
                    .map(|sessions| sessions.len())
                    .unwrap_or(0);
                // daemon 会话可以在没有 UI Tab 的情况下继续运行；UI active list
                // 只能用于诊断，不能作为孤儿判定依据。
                let summary = crate::pty::manager::PtyOrphanCleanupSummary {
                    active_count,
                    tracked_count,
                    marked_missing: 0,
                    protected_count: tracked_count,
                    cleaned_count: 0,
                    skipped_empty_active_list: active_count == 0,
                };
                match serde_json::to_value(&summary) {
                    Ok(summary) => DaemonFrame::Reconciled { id, summary },
                    Err(err) => err_frame(id, &err.to_string()),
                }
            }
            ClientFrame::Status { id } => {
                let statuses = self
                    .host
                    .pty
                    .status_all()
                    .into_iter()
                    .map(|(session_id, status)| {
                        (
                            session_id,
                            SessionStatusInfo {
                                status: status.status,
                                exit_code: status.exit_code,
                            },
                        )
                    })
                    .collect();
                DaemonFrame::Statuses { id, statuses }
            }
            ClientFrame::SshAgentRequest {
                id,
                consumer_id,
                ssh_launch,
                request_kind,
                payload,
            } => match self.host.ssh_agent_bridges.request(
                Arc::downgrade(&self.host),
                &consumer_id,
                &ssh_launch,
                &request_kind,
                payload,
            ) {
                Ok(payload) => DaemonFrame::SshAgentResponse { id, payload },
                Err(message) => DaemonFrame::Err { id, message },
            },
            ClientFrame::SshAgentRelease {
                id,
                host_id,
                consumer_id,
            } => {
                self.host
                    .ssh_agent_bridges
                    .release_consumer(&host_id, &consumer_id);
                DaemonFrame::Ok { id }
            }
            ClientFrame::Shutdown { id } => {
                if self.host.alive_session_count() > 0 {
                    return err_frame(id, "sessions active");
                }
                log::info!("daemon shutdown requested (no alive sessions)");
                let info_path = self.info_path.clone();
                std::thread::spawn(move || {
                    // 留出应答落盘时间再退出。
                    std::thread::sleep(Duration::from_millis(200));
                    remove_daemon_info(&info_path);
                    std::process::exit(0);
                });
                DaemonFrame::Ok { id }
            }
        }
    }

    fn handle_create(
        &self,
        client_id: u64,
        id: u64,
        session_id: String,
        cwd: Option<String>,
        env_vars: Option<HashMap<String, String>>,
        shell: Option<String>,
        ssh_launch: Option<SshLaunchPlan>,
        terminal_colors: Option<crate::daemon::protocol::TerminalColorSpec>,
    ) -> DaemonFrame {
        if !is_valid_session_id(&session_id) {
            return err_frame(id, "invalid session id");
        }
        let sink = Arc::new(DaemonPtyEventSink::new(
            Arc::clone(&self.host),
            session_id.clone(),
        ));
        // 检查、预留与插入保持在同一临界区；并发 create 不得同时通过。
        if let Err(message) = self.host.reserve_session_with_launch(
            &session_id,
            cwd.clone(),
            shell.clone(),
            ssh_launch.as_ref(),
            env_vars.as_ref().and_then(|env| env.get("CLI_MANAGER_WORKSPACE"))
                .and_then(|value| serde_json::from_str(value).ok()),
        ) {
            return err_frame(id, message);
        }
        let attached = self.host.clients.lock().ok().and_then(|mut clients| {
            let client = clients.get_mut(&client_id)?;
            client.attached.insert(session_id.clone());
            client.unacknowledged_chars.insert(session_id.clone(), 0);
            client.flow_control_paused.remove(&session_id);
            client.last_sent_sequence.insert(session_id.clone(), 0);
            client
                .last_acknowledged_sequence
                .insert(session_id.clone(), 0);
            client.attaching.remove(&session_id);
            Some(())
        });
        // 先登记会话表再启动 PTY：reader 线程首帧输出可能早于登记完成。
        if attached.is_none() {
            if let Ok(mut sessions) = self.host.sessions.lock() {
                sessions.remove(&session_id);
            }
            return err_frame(id, "client unavailable");
        }
        match self.host.pty.create_with_launch(
            &session_id,
            cwd.as_deref(),
            env_vars,
            shell.as_deref(),
            ssh_launch.as_ref(),
            terminal_colors
                .as_ref()
                .map(|colors| (colors.foreground.as_str(), colors.background.as_str())),
            sink,
        ) {
            Ok(process_traits) => {
                if let Some(plan) = ssh_launch.as_ref() {
                    self.host.ensure_ssh_agent_bridge(&session_id, plan);
                }
                self.host
                    .get_session(&session_id)
                    .and_then(|session| {
                        session.lock().ok().map(|mut entry| {
                            entry.meta.process_traits = Some(ProcessTraits::current_platform(
                                process_traits.uses_conpty_dll,
                            ));
                            entry.meta.root_pid = Some(process_traits.root_pid);
                            entry.meta.root_started_at = process_traits.root_started_at;
                            entry.meta.clone()
                        })
                    })
                    .map(|meta| DaemonFrame::Created { id, meta })
                    .unwrap_or_else(|| err_frame(id, "session state unavailable"))
            }
            Err(message) => {
                if let Ok(mut sessions) = self.host.sessions.lock() {
                    sessions.remove(&session_id);
                }
                if let Ok(mut clients) = self.host.clients.lock() {
                    if let Some(client) = clients.get_mut(&client_id) {
                        client.attached.remove(&session_id);
                        client.unacknowledged_chars.remove(&session_id);
                        client.flow_control_paused.remove(&session_id);
                        client.last_sent_sequence.remove(&session_id);
                        client.last_acknowledged_sequence.remove(&session_id);
                        client.attaching.remove(&session_id);
                    }
                }
                DaemonFrame::Err { id, message }
            }
        }
    }
}

fn err_frame(id: u64, message: &str) -> DaemonFrame {
    DaemonFrame::Err {
        id,
        message: message.to_string(),
    }
}

/// 读一行并施加单帧字节上限；连接关闭/超限/非 UTF-8/IO 错误返回 None（调用方断连）。
fn read_line_bounded(reader: &mut BufReader<TcpStream>) -> Option<String> {
    let mut buf = Vec::new();
    let mut limited = reader.by_ref().take((MAX_FRAME_BYTES + 1) as u64);
    match limited.read_until(b'\n', &mut buf) {
        Ok(0) => None,
        Ok(_) => {
            if buf.last() != Some(&b'\n') {
                // 无换行结尾：要么超限被截断，要么对端半行断连，一律断。
                if buf.len() > MAX_FRAME_BYTES {
                    log::warn!("daemon frame exceeds {MAX_FRAME_BYTES} bytes, dropping client");
                }
                return None;
            }
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            match String::from_utf8(buf) {
                Ok(line) => Some(line),
                Err(_) => {
                    log::warn!("daemon frame is not valid UTF-8, dropping client");
                    None
                }
            }
        }
        Err(err) => {
            log::warn!("daemon read failed: {err}");
            None
        }
    }
}

fn maybe_activate_app_for_hook(payload: &crate::claude_hook::ClaudeHookPayload, target_tab_id: &str) {
    if !payload.requires_user_response() {
        return;
    }
    let Ok(daemon_exe) = std::env::current_exe() else {
        return;
    };
    let app_name = if cfg!(target_os = "windows") {
        "cli-manager.exe"
    } else {
        "cli-manager"
    };
    let app_exe = daemon_exe.with_file_name(app_name);
    if !app_exe.is_file() {
        log::warn!(
            "hook activation skipped: app executable not found at {}",
            app_exe.display()
        );
        return;
    }
    let mut command = Command::new(app_exe);
    command.args(["--restore-background-session", target_tab_id]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if let Err(err) = command.spawn() {
        log::warn!("hook activation failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn compile_agent_process_fixture(dir: &std::path::Path) -> PathBuf {
        let executable = dir.join("agent-process-fixture");
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/agent_process.c");
        let output = Command::new("cc")
            .args(["-std=c99", "-Wall", "-Wextra", "-Werror", "-O2"])
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("failed to run cc for the harmless Agent process fixture");
        assert!(
            output.status.success(),
            "Agent fixture compilation failed: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        executable
    }

    #[cfg(unix)]
    fn test_pty_replay(host: &DaemonHost, id: &str) -> String {
        let Some(session) = host.get_session(id) else {
            return "test session is unavailable".into();
        };
        let entry = session.lock().unwrap();
        match entry.buffer.replay_entries() {
            Ok(frames) => {
                let bytes = frames.iter().flat_map(|frame| frame.data.iter().copied()).collect::<Vec<_>>();
                String::from_utf8_lossy(&bytes).into_owned()
            }
            Err(error) => format!("test replay unavailable: {error}"),
        }
    }

    fn queued_writer(websocket: bool) -> Arc<ClientWriter> {
        Arc::new(ClientWriter {
            shared: Arc::new((Mutex::new(ClientWriterState {
                control: VecDeque::new(), output: VecDeque::new(), output_bytes: 0, closed: false,
            }), Condvar::new())),
            websocket,
        })
    }

    #[test]
    fn live_broadcast_ring_replay_and_attach_share_original_bytes() {
        let host = DaemonHost::new();
        let id = "shared-bytes";
        host.sessions.lock().unwrap().insert(id.into(), test_session(id, SessionBuffer::new(), 1));
        let writers = [queued_writer(true), queued_writer(false)];
        for (index, writer) in writers.iter().enumerate() {
            host.clients.lock().unwrap().insert(index as u64, ClientHandle {
                writer: Arc::clone(writer), attached: HashSet::from([id.into()]),
                unacknowledged_chars: HashMap::new(), flow_control_paused: HashSet::new(),
                last_sent_sequence: HashMap::new(), last_acknowledged_sequence: HashMap::new(),
                attaching: HashMap::from([(id.into(), Vec::new())]),
            });
        }
        emit_daemon_output(&host, id, &[0, 255, 128, 27, b'[', b'm']);
        let session = host.get_session(id).unwrap();
        let entry = session.lock().unwrap();
        let original = &entry.buffer.frames.front().unwrap().data;
        let replay = entry.buffer.replay_entries().unwrap();
        assert!(Arc::ptr_eq(original, &replay[0].data));
        for (index, writer) in writers.iter().enumerate() {
            host.complete_attach(index as u64, id);
            let mut state = writer.shared.0.lock().unwrap();
            assert_eq!(state.output_bytes, 8, "retain the legacy Base64 byte budget");
            let Some(ClientWireFrame::Daemon(DaemonFrame::Output { data, sequence: 1, .. })) = state.pop_next() else { panic!("missing output"); };
            assert!(Arc::ptr_eq(original, &data), "fan-out must clone only the Arc");
            assert_eq!(state.output_bytes, 0);
        }
        let attached = DaemonFrame::Attached {
            id: 1, session_id: id.into(), replay_base64: String::new(), replay,
            latest_sequence: 1, meta: entry.meta.clone(), replay_reset: true,
            replay_truncated: false, oldest_sequence: 1,
        };
        let frames = websocket_attached_frames(&attached).unwrap();
        let ClientWireFrame::BinaryTerminal { data, kind: BINARY_KIND_REPLAY, .. } = &frames[1] else { panic!("missing replay"); };
        assert!(Arc::ptr_eq(original, data), "binary replay must not decode a Base64 copy");
    }

    #[test]
    fn raw_output_keeps_legacy_queue_limit_and_zero_byte_resize() {
        let writer = queued_writer(true);
        let data: Arc<[u8]> = vec![0; CLIENT_OUTPUT_QUEUE_MAX_BYTES / 4 * 3].into();
        let output = |data| DaemonFrame::Output { session_id: "queue".into(), sequence: 1, cols: 80, rows: 24, data };
        writer.send_frame(&output(Arc::clone(&data))).unwrap();
        assert_eq!(writer.shared.0.lock().unwrap().output_bytes, CLIENT_OUTPUT_QUEUE_MAX_BYTES);
        writer.send_frame(&output(Arc::from([]))).unwrap();
        assert!(writer.send_frame(&output(Arc::from([1]))).is_err());
        assert!(writer.shared.0.lock().unwrap().closed);
    }

    #[test]
    fn daemon_output_batch_stops_before_crossing_live_frame_budget() {
        assert!(!output_batch_would_overflow(0, 80 * 1024));
        assert!(!output_batch_would_overflow(32 * 1024, 32 * 1024));
        assert!(output_batch_would_overflow(40 * 1024, 40 * 1024));
    }

    fn test_session(session_id: &str, buffer: SessionBuffer, next_sequence: u64) -> SharedSession {
        Arc::new(Mutex::new(SessionEntry {
            meta: SessionMeta {
                workspace: None,
                session_id: session_id.to_string(),
                root_pid: None,
                root_started_at: None,
                agent_detection: None,
                cwd: None,
                shell: None,
                environment_type: None,
                ssh_host_id: None,
                remote_path: None,
                alive: true,
                task_status: None,
                task_updated_at_ms: None,
                created_at_ms: 1,
                process_traits: Some(ProcessTraits::current_platform(false)),
                replay_available: buffer.replay_available(),
                replay_truncated: buffer.truncated,
            },
            buffer,
            cols: 80,
            rows: 24,
            next_sequence,
            ssh_hook_binding: None,
        }))
    }

    fn remote_hook_launch(source: &str) -> SshLaunchPlan {
        SshLaunchPlan {
            host_id: "host-1".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "dev".to_string(),
            config_alias: String::new(),
            config_file: String::new(),
            auth_mode: "agent".to_string(),
            identity_file: String::new(),
            credential_ref: String::new(),
            jump_target: String::new(),
            proxy_type: String::new(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_command: String::new(),
            connect_timeout_sec: 10,
            server_alive_interval_sec: 30,
            server_alive_count_max: 3,
            remote_path: "/srv/private-directory".to_string(),
            client_instance_id: "client-1".to_string(),
            project_id: "project-1".to_string(),
            project_name: "Sidebar Project".to_string(),
            bridge_epoch: "epoch-1".to_string(),
            agent_path: "~/.local/bin/cli-manager-ssh-agent".to_string(),
            agent_installation_id: "installation-1".to_string(),
            agent_remote_machine_id: "machine-1".to_string(),
            tool_source: source.to_string(),
            environment_overrides: HashMap::new(),
            initialization_command: None,
            startup_command: None,
        }
    }

    #[test]
    fn durable_hook_retry_after_commit_still_updates_runtime_and_broadcasts() {
        let host = DaemonHost::new();
        host.reserve_session("durable-retry", None, None).unwrap();
        let value = serde_json::json!({ "tabId": "durable-retry", "source": "codex", "event": "Stop" });
        // false means the original process committed the row before it stopped.
        deliver_durable_hook(value, |_| Ok(false), |value| {
            host.update_task_status_from_hook(&value);
            host.broadcast_hook(value);
        }).unwrap();
        assert_eq!(host.get_session("durable-retry").unwrap().lock().unwrap().meta.task_status.as_deref(), Some("done"));
        let cached = host.hook_cache.lock().unwrap();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].get("inboxDurable").and_then(serde_json::Value::as_bool), Some(true));
    }

    #[test]
    fn failed_hook_commit_does_not_broadcast_or_acknowledge() {
        let host = DaemonHost::new();
        host.reserve_session("durable-failure", None, None).unwrap();
        let result = deliver_durable_hook(
            serde_json::json!({ "tabId": "durable-failure", "event": "Stop" }),
            |_| Err("disk unavailable".into()),
            |value| { host.update_task_status_from_hook(&value); host.broadcast_hook(value); },
        );
        assert_eq!(result.unwrap_err(), "disk unavailable");
        assert_eq!(host.hook_cache.lock().unwrap().len(), 0);
        assert!(host.get_session("durable-failure").unwrap().lock().unwrap().meta.task_status.is_none());
    }

    #[test]
    fn remote_hook_binding_injects_sidebar_project_for_claude_and_codex() {
        for (index, source) in ["claude", "codex"].into_iter().enumerate() {
            let host = DaemonHost::new();
            let tab_id = format!("tab-{index}");
            let launch = remote_hook_launch(source);
            host.reserve_session_with_launch(&tab_id, None, None, Some(&launch), None)
                .unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            host.set_hook_sink(Arc::new(move |payload| {
                sender.send(payload.to_notification_job()).unwrap();
                Ok(())
            }));

            host.accept_remote_hook_event(serde_json::json!({
                "kind": "hookEvent",
                "eventId": format!("event-{index}"),
                "sequence": index + 1,
                "tabId": tab_id,
                "hostId": launch.host_id,
                "clientInstanceId": launch.client_instance_id,
                "projectId": launch.project_id,
                "bridgeEpoch": launch.bridge_epoch,
                "installationId": launch.agent_installation_id,
                "source": source,
                "event": "Stop",
                "sessionId": format!("session-{index}"),
                "remoteCwd": launch.remote_path,
                "occurredAt": 1,
            })).unwrap();

            let job = receiver.try_recv().unwrap();
            assert_eq!(job.source, source);
            assert_eq!(job.cwd, None);
            assert_eq!(job.project.as_deref(), Some("Sidebar Project"));
        }
    }

    #[test]
    fn websocket_writer_sends_binary_terminal_output() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let socket = tungstenite::accept(stream).unwrap();
            let writer_stream = socket.get_ref().try_clone().unwrap();
            let writer = ClientWriter::new(ClientTransport::WebSocket(Mutex::new(
                WebSocket::from_raw_socket(writer_stream, Role::Server, None),
            )));
            writer
                .send_frame(&DaemonFrame::Output {
                    session_id: "session-1".to_string(),
                    sequence: 3,
                    cols: 120,
                    rows: 30,
                    data: Arc::from(&b"hello"[..]),
                })
                .unwrap();
            drop(socket);
        });

        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (mut client, _) = tungstenite::client("ws://127.0.0.1/pty", stream).unwrap();
        let message = client.read().unwrap();
        let Message::Binary(binary) = message else {
            panic!("expected binary output frame");
        };
        assert_eq!(binary[0], super::super::protocol::BINARY_PROTOCOL_VERSION);
        assert_eq!(binary[1], BINARY_KIND_OUTPUT);
        assert_eq!(&binary[binary.len() - 5..], b"hello");
        server.join().unwrap();
    }

    #[test]
    fn websocket_replay_allows_control_frames_to_preempt_between_entries() {
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let meta = test_session(session_id, SessionBuffer::new(), 1)
            .lock()
            .unwrap()
            .meta
            .clone();
        let attached = DaemonFrame::Attached {
            id: 11,
            session_id: session_id.to_string(),
            replay_base64: String::new(),
            replay: vec![
                ReplayEntry {
                    sequence: 1,
                    cols: 80,
                    rows: 24,
                    data: Arc::from(&b"first"[..]),
                },
                ReplayEntry {
                    sequence: 2,
                    cols: 80,
                    rows: 24,
                    data: Arc::from(&b"second"[..]),
                },
            ],
            latest_sequence: 2,
            meta,
            replay_reset: true,
            replay_truncated: false,
            oldest_sequence: 1,
        };
        let replay_frames = websocket_attached_frames(&attached).unwrap();
        let mut state = ClientWriterState {
            control: VecDeque::new(),
            output: replay_frames
                .into_iter()
                .map(|frame| QueuedOutputFrame {
                    frame,
                    live_output_bytes: 0,
                })
                .collect(),
            output_bytes: 0,
            closed: false,
        };

        assert!(matches!(
            state.pop_next(),
            Some(ClientWireFrame::BinaryTerminal {
                kind: BINARY_KIND_REPLAY_RESET,
                ..
            })
        ));
        state
            .control
            .push_back(ClientWireFrame::Daemon(DaemonFrame::Ok { id: 12 }));
        assert!(matches!(
            state.pop_next(),
            Some(ClientWireFrame::Daemon(DaemonFrame::Ok { id: 12 }))
        ));
        assert!(matches!(
            state.pop_next(),
            Some(ClientWireFrame::BinaryTerminal {
                kind: BINARY_KIND_REPLAY,
                sequence: 1,
                ..
            })
        ));
        assert!(matches!(
            state.pop_next(),
            Some(ClientWireFrame::BinaryTerminal {
                kind: BINARY_KIND_REPLAY,
                sequence: 2,
                ..
            })
        ));
        assert!(matches!(
            state.pop_next(),
            Some(ClientWireFrame::Daemon(DaemonFrame::Attached {
                id: 11,
                replay,
                ..
            })) if replay.is_empty()
        ));
    }

    #[test]
    fn attach_returns_replay_and_registers_client() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("read test listener address");
        let peer = TcpStream::connect(address).expect("connect test client");
        let (server_stream, _) = listener.accept().expect("accept test client");
        let host = Arc::new(DaemonHost::new());
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let client_id = 7;
        let mut buffer = SessionBuffer::new();
        buffer.push_output(80, 24, 1, b"replay-before-attach");
        host.sessions
            .lock()
            .expect("lock sessions")
            .insert(session_id.to_string(), test_session(session_id, buffer, 2));
        host.clients.lock().expect("lock clients").insert(
            client_id,
            ClientHandle {
                writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
                attached: HashSet::new(),
                unacknowledged_chars: HashMap::new(),
                flow_control_paused: HashSet::new(),
                last_sent_sequence: HashMap::new(),
                last_acknowledged_sequence: HashMap::new(),
                attaching: HashMap::new(),
            },
        );
        let server = DaemonServer {
            host: Arc::clone(&host),
            next_client_id: AtomicU64::new(8),
            token: String::new(),
            version: String::new(),
            info_path: PathBuf::new(),
        };

        let reply = server.handle_frame(
            client_id,
            ClientFrame::Attach {
                id: 11,
                session_id: session_id.to_string(),
                after_sequence: None,
            },
        );

        match reply {
            DaemonFrame::Attached { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(
                    replay[0].data.as_ref(),
                    b"replay-before-attach"
                );
            }
            other => panic!("unexpected attach reply: {other:?}"),
        }
        assert!(host
            .clients
            .lock()
            .expect("lock clients")
            .get(&client_id)
            .expect("client exists")
            .attached
            .contains(session_id));
        drop(peer);
    }

    #[test]
    fn attach_rejects_unreadable_spool_before_advancing_subscription() {
        for missing in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session.bin");
            let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
            for sequence in 1..=100 {
                buffer
                    .append_spooled_frame(&ReplayFrame {
                        cols: 80,
                        rows: 24,
                        sequence,
                        data: vec![sequence as u8; 32].into(),
                    })
                    .unwrap();
            }
            buffer.push_output(80, 24, 101, b"live ring");
            let original = std::fs::read(&path).unwrap();
            if missing {
                std::fs::remove_file(&path).unwrap();
            } else {
                File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_len(original.len() as u64 - 10)
                    .unwrap();
            }
            let host = Arc::new(DaemonHost::new());
            let session_id = "spool-read-failure";
            host.sessions.lock().unwrap().insert(
                session_id.to_string(),
                test_session(session_id, buffer, 102),
            );
            let writer = Arc::new(ClientWriter {
                shared: Arc::new((
                    Mutex::new(ClientWriterState {
                        control: VecDeque::new(),
                        output: VecDeque::new(),
                        output_bytes: 0,
                        closed: false,
                    }),
                    Condvar::new(),
                )),
                websocket: true,
            });
            host.clients.lock().unwrap().insert(
                7,
                ClientHandle {
                    writer,
                    attached: HashSet::new(),
                    unacknowledged_chars: HashMap::from([(session_id.to_string(), 12)]),
                    flow_control_paused: HashSet::new(),
                    last_sent_sequence: HashMap::from([(session_id.to_string(), 10)]),
                    last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 10)]),
                    attaching: HashMap::new(),
                },
            );
            let server = DaemonServer {
                host: Arc::clone(&host),
                next_client_id: AtomicU64::new(8),
                token: String::new(),
                version: String::new(),
                info_path: PathBuf::new(),
            };
            for after_sequence in [Some(10), None] {
                let reply = server.handle_frame(
                    7,
                    ClientFrame::Attach {
                        id: 11,
                        session_id: session_id.to_string(),
                        after_sequence,
                    },
                );
                assert!(matches!(reply, DaemonFrame::Err { id: 11, message }
                    if message.starts_with("session replay unavailable:")));
                let clients = host.clients.lock().unwrap();
                let client = clients.get(&7).unwrap();
                assert!(!client.attached.contains(session_id));
                assert!(!client.attaching.contains_key(session_id));
                assert_eq!(client.last_sent_sequence.get(session_id), Some(&10));
                assert_eq!(client.last_acknowledged_sequence.get(session_id), Some(&10));
                assert_eq!(client.unacknowledged_chars.get(session_id), Some(&12));
            }
            std::fs::write(&path, original).unwrap();
            let reply = server.handle_frame(
                7,
                ClientFrame::Attach {
                    id: 12,
                    session_id: session_id.to_string(),
                    after_sequence: Some(10),
                },
            );
            match reply {
                DaemonFrame::Attached {
                    replay,
                    latest_sequence,
                    replay_reset,
                    ..
                } => {
                    assert!(!replay_reset);
                    assert_eq!(latest_sequence, 101);
                    assert_eq!(
                        replay.iter().map(|f| f.sequence).collect::<Vec<_>>(),
                        (11..=101).collect::<Vec<_>>()
                    );
                }
                other => panic!("unexpected recovered attach reply: {other:?}"),
            }
        }
    }

    #[test]
    fn attach_barrier_sends_replay_control_before_buffered_live_output() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let (server_stream, _) = listener.accept().unwrap();
        let host = Arc::new(DaemonHost::new());
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let client_id = 9;
        let mut buffer = SessionBuffer::new();
        buffer.push_output(80, 24, 1, b"replay");
        host.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), test_session(session_id, buffer, 2));
        let writer = ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream)));
        host.clients.lock().unwrap().insert(
            client_id,
            ClientHandle {
                writer: Arc::clone(&writer),
                attached: HashSet::new(),
                unacknowledged_chars: HashMap::new(),
                flow_control_paused: HashSet::new(),
                last_sent_sequence: HashMap::new(),
                last_acknowledged_sequence: HashMap::new(),
                attaching: HashMap::new(),
            },
        );
        let server = DaemonServer {
            host: Arc::clone(&host),
            next_client_id: AtomicU64::new(10),
            token: String::new(),
            version: String::new(),
            info_path: PathBuf::new(),
        };

        let attached = server.handle_frame(
            client_id,
            ClientFrame::Attach {
                id: 12,
                session_id: session_id.to_string(),
                after_sequence: None,
            },
        );
        let live = DaemonFrame::Output {
            session_id: session_id.to_string(),
            sequence: 2,
            cols: 80,
            rows: 24,
            data: Arc::from(&b"live"[..]),
        };
        host.push_output_to_attached(session_id, 2, 4, &live);
        writer.send_frame(&attached).unwrap();
        host.complete_attach(client_id, session_id);

        let mut reader = BufReader::new(peer);
        let first = read_line_bounded(&mut reader).unwrap();
        let second = read_line_bounded(&mut reader).unwrap();
        assert!(matches!(
            super::super::protocol::decode_daemon_frame(&first).unwrap(),
            DaemonFrame::Attached { .. }
        ));
        assert!(matches!(
            super::super::protocol::decode_daemon_frame(&second).unwrap(),
            DaemonFrame::Output { sequence: 2, .. }
        ));
    }

    #[test]
    fn detach_session_clears_flow_control_state() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = TcpStream::connect(address).unwrap();
        let (server_stream, _) = listener.accept().unwrap();
        let host = DaemonHost::new();
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        host.clients.lock().unwrap().insert(
            1,
            ClientHandle {
                writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
                attached: HashSet::from([session_id.to_string()]),
                unacknowledged_chars: HashMap::from([(session_id.to_string(), 10)]),
                flow_control_paused: HashSet::from([session_id.to_string()]),
                last_sent_sequence: HashMap::from([(session_id.to_string(), 2)]),
                last_acknowledged_sequence: HashMap::from([(session_id.to_string(), 1)]),
                attaching: HashMap::new(),
            },
        );

        host.detach_session_from_clients(session_id);

        let clients = host.clients.lock().unwrap();
        let client = clients.get(&1).unwrap();
        assert!(!client.attached.contains(session_id));
        assert!(!client.unacknowledged_chars.contains_key(session_id));
        assert!(!client.flow_control_paused.contains(session_id));
        assert!(!client.last_sent_sequence.contains_key(session_id));
        assert!(!client.last_acknowledged_sequence.contains_key(session_id));
        drop(peer);
    }

    #[test]
    fn output_flow_control_waits_for_low_watermark() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let peer = TcpStream::connect(address).unwrap();
        let (server_stream, _) = listener.accept().unwrap();
        let host = Arc::new(DaemonHost::new());
        let session_id = "flow-control";
        host.clients.lock().unwrap().insert(
            1,
            ClientHandle {
                writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(server_stream))),
                attached: HashSet::from([session_id.to_string()]),
                unacknowledged_chars: HashMap::from([(
                    session_id.to_string(),
                    CLIENT_OUTPUT_HIGH_WATERMARK - 1,
                )]),
                flow_control_paused: HashSet::new(),
                last_sent_sequence: HashMap::new(),
                last_acknowledged_sequence: HashMap::new(),
                attaching: HashMap::new(),
            },
        );
        let frame = DaemonFrame::Output {
            session_id: session_id.to_string(),
            sequence: 1,
            cols: 80,
            rows: 24,
            data: Arc::from([]),
        };
        host.push_output_to_attached(session_id, 1, 1, &frame);

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter_host = Arc::clone(&host);
        let waiter_session = session_id.to_string();
        std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx
                .send(waiter_host.wait_for_output_capacity(&waiter_session))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());

        host.acknowledge_output(
            1,
            session_id,
            1,
            CLIENT_OUTPUT_HIGH_WATERMARK - CLIENT_OUTPUT_LOW_WATERMARK,
        );
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        drop(peer);
    }

    #[test]
    fn session_buffer_spills_whole_frames_without_losing_replay() {
        let temp = tempfile::tempdir().unwrap();
        let mut buffer = SessionBuffer::with_spool(Some(temp.path().join("session.bin")));
        let frame = vec![b'x'; 1024 * 1024]; // 1 MiB/帧
        buffer.push_output(80, 24, 1, &frame);
        buffer.push_output(80, 24, 2, &frame);
        buffer.push_output(80, 24, 3, &frame); // 超 2 MiB，最旧帧落磁盘
        assert!(buffer.total_bytes <= SESSION_BUFFER_MAX_BYTES);
        assert_eq!(buffer.frames.len(), 2);
        let replay = buffer.replay_entries().unwrap();
        assert_eq!(replay.len(), 3);
        assert_eq!(
            replay
                .iter()
                .map(|entry| entry.data.len())
                .sum::<usize>(),
            frame.len() * 3
        );
    }

    #[test]
    fn session_spool_retains_history_while_amortizing_compaction() {
        let temp = tempfile::tempdir().unwrap();
        let mut buffer = SessionBuffer::with_spool(Some(temp.path().join("session.bin")));
        let data = vec![b'x'; 64 * 1024];
        let mut compactions = 0;
        let mut largest_file = 0;
        for sequence in 1..=800 {
            let previous_path = buffer.spool_path.clone();
            buffer.push_output(80, 24, sequence, &data);
            compactions += usize::from(buffer.spool_path != previous_path);
            assert!(buffer.spool_bytes <= SESSION_SPOOL_MAX_BYTES);
            assert_eq!(
                buffer.spool_bytes,
                buffer.spool_frames.iter().map(|f| f.bytes).sum::<usize>()
            );
            if let Ok(metadata) = std::fs::metadata(buffer.spool_path.as_ref().unwrap()) {
                largest_file = largest_file.max(metadata.len());
                assert!(metadata.len() <= (2 * SESSION_SPOOL_MAX_BYTES + data.len() + 16) as u64);
            }
        }
        // Frequent small writes must not rewrite the retained 10 MiB each time.
        assert!((1..=4).contains(&compactions), "compactions={compactions}");
        assert!(largest_file > SESSION_SPOOL_MAX_BYTES as u64);
        let replay = buffer.replay_entries().unwrap();
        let retained_count =
            SESSION_BUFFER_MAX_BYTES / data.len() + SESSION_SPOOL_MAX_BYTES / (data.len() + 16);
        assert_eq!(replay.len(), retained_count);
        assert_eq!(buffer.oldest_sequence(), Some(801 - retained_count as u64));
        for (index, frame) in replay.iter().enumerate() {
            assert_eq!(frame.sequence, 801 - retained_count as u64 + index as u64);
            assert_eq!(frame.data.as_ref(), data);
        }
        assert!(buffer.truncated);
    }

    #[test]
    fn session_spool_checkpoint_preserves_tail_and_resize_after_head_advance() {
        let temp = tempfile::tempdir().unwrap();
        let mut buffer = SessionBuffer::with_spool(Some(temp.path().join("session.bin")));
        let data = vec![b'x'; 1024 * 1024];
        for sequence in 1..=16 {
            buffer.push_output(80, 24, sequence, &data);
        }
        assert!(buffer.spool_offset > 0);
        buffer.push_resize(120, 40, 17);
        buffer
            .accept_checkpoint(80, 24, 12, b"checkpoint".to_vec())
            .unwrap();
        assert_eq!(buffer.spool_offset, 0);
        assert_eq!(buffer.oldest_sequence(), Some(12));
        let replay = buffer.replay_entries().unwrap();
        assert_eq!(
            replay.iter().map(|f| f.sequence).collect::<Vec<_>>(),
            vec![12, 13, 14, 15, 16, 17]
        );
        assert_eq!(
            replay[0].data.as_ref(),
            b"checkpoint"
        );
        assert_eq!((replay[5].cols, replay[5].rows), (120, 40));
        assert!(replay[5].data.is_empty());
        assert_eq!(
            buffer
                .replay_entries_after(Some(14))
                .unwrap()
                .iter()
                .map(|f| f.sequence)
                .collect::<Vec<_>>(),
            vec![15, 16, 17]
        );
        buffer
            .accept_checkpoint(120, 40, 17, b"new checkpoint".to_vec())
            .unwrap();
        assert_eq!(buffer.spool_bytes, 0);
        assert!(buffer.spool_frames.is_empty());
        assert_eq!(buffer.replay_entries().unwrap().len(), 1);
        buffer.push_output(120, 40, 18, &data);
        buffer.push_output(120, 40, 19, &data);
        buffer.push_output(120, 40, 20, &data);
        assert_eq!(buffer.replay_entries_after(Some(17)).unwrap().len(), 3);
    }

    #[test]
    fn session_spool_skips_old_payloads_and_reads_oldest_from_index() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.bin");
        let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
        for sequence in 1..=3 {
            buffer
                .append_spooled_frame(&ReplayFrame {
                    cols: 80,
                    rows: 24,
                    sequence,
                    data: vec![sequence as u8; 32].into(),
                })
                .unwrap();
        }
        // A bad old frame must not be touched by an incremental attach after it.
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .write_all(&[0; 16])
            .unwrap();
        assert!(buffer.read_spooled_frames_after(None).is_err());
        let replay = buffer.replay_entries_after(Some(1)).unwrap();
        assert_eq!(
            replay.iter().map(|f| f.sequence).collect::<Vec<_>>(),
            vec![2, 3]
        );
        std::fs::remove_file(path).unwrap();
        assert_eq!(buffer.oldest_sequence(), Some(1));
        assert!(buffer
            .read_spooled_frames_after(Some(3))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_spool_repairs_partial_append_before_next_frame() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.bin");
        let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
        let frame = |sequence| ReplayFrame {
            cols: 80,
            rows: 24,
            sequence,
            data: Arc::from(&b"output"[..]),
        };
        buffer.append_spooled_frame(&frame(1)).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"partial")
            .unwrap();
        assert_eq!(buffer.read_spooled_frames_after(None).unwrap().len(), 1);
        buffer.append_spooled_frame(&frame(2)).unwrap();
        let frames = buffer.read_spooled_frames_after(None).unwrap();
        assert_eq!(
            frames.iter().map(|f| f.sequence).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 2 * (16 + 6));
        assert_eq!(frames[1].data.as_ref(), b"output");
    }

    #[test]
    fn session_spool_failed_write_keeps_output_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.bin");
        std::fs::create_dir(&path).unwrap();
        let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
        let data = vec![b'x'; 1024 * 1024];
        for sequence in 1..=3 {
            buffer.push_output(80, 24, sequence, &data);
        }
        assert_eq!(buffer.frames.len(), 3);
        assert_eq!(buffer.spool_bytes, 0);
        assert!(buffer.spool_frames.is_empty());
        std::fs::remove_dir(&path).unwrap();
        buffer.push_output(80, 24, 4, &data);
        assert_eq!(
            buffer
                .replay_entries()
                .unwrap()
                .iter()
                .map(|f| f.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn session_spool_failed_checkpoint_keeps_previous_checkpoint_and_ring() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.bin");
        let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
        buffer
            .accept_checkpoint(80, 24, 1, b"old".to_vec())
            .unwrap();
        buffer.push_output(80, 24, 2, b"new output");
        std::fs::create_dir(&path).unwrap();
        assert!(buffer
            .accept_checkpoint(120, 40, 2, b"new".to_vec())
            .is_err());
        assert_eq!(buffer.oldest_sequence(), Some(1));
        assert_eq!(buffer.total_bytes, b"new output".len());
        assert_eq!(buffer.checkpoint.as_ref().unwrap().data.as_ref(), b"old");
        assert_eq!(buffer.frames.front().unwrap().sequence, 2);
        std::fs::remove_dir(path).unwrap();
        buffer
            .accept_checkpoint(120, 40, 2, b"new".to_vec())
            .unwrap();
        assert_eq!(buffer.oldest_sequence(), Some(2));
        assert!(buffer.frames.is_empty());
    }

    #[test]
    fn session_spool_failed_compaction_preserves_file_and_index() {
        let temp = tempfile::tempdir().unwrap();
        let mut buffer = SessionBuffer::with_spool(Some(temp.path().join("session.bin")));
        let data = vec![b'x'; 1024 * 1024];
        for sequence in 1..=21 {
            buffer.push_output(80, 24, sequence, &data);
        }
        // Compaction has already completed once; advance to the next threshold
        // with append only so an unreadable retained frame exercises its failure.
        while buffer.spool_offset < SESSION_SPOOL_MAX_BYTES as u64 {
            let sequence = buffer.spool_frames.back().unwrap().sequence + 1;
            buffer
                .append_spooled_frame(&ReplayFrame {
                    cols: 80,
                    rows: 24,
                    sequence,
                    data: data.clone().into(),
                })
                .unwrap();
            let oldest = buffer.spool_frames.pop_front().unwrap();
            buffer.spool_bytes -= oldest.bytes;
            buffer.spool_offset += oldest.bytes as u64;
        }
        let path = buffer.spool_path.clone().unwrap();
        let bytes = buffer.spool_bytes;
        let offset = buffer.spool_offset;
        let sequences = buffer
            .spool_frames
            .iter()
            .map(|f| f.sequence)
            .collect::<Vec<_>>();
        let mut file = File::options().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(&[0; 16]).unwrap();
        drop(file);
        buffer.enforce_spool_cap();
        assert_eq!(buffer.spool_path.as_ref(), Some(&path));
        assert_eq!(buffer.spool_bytes, bytes);
        assert_eq!(buffer.spool_offset, offset);
        assert_eq!(
            buffer
                .spool_frames
                .iter()
                .map(|f| f.sequence)
                .collect::<Vec<_>>(),
            sequences
        );
        assert!(path.exists());
    }

    #[test]
    fn session_spool_retries_retired_file_cleanup_on_compaction_and_drop() {
        for cleanup_on_drop in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session.bin");
            let unrelated = temp.path().join("unrelated.bin");
            std::fs::write(&unrelated, b"not owned by this session").unwrap();
            // A directory forces remove_file to fail on every test platform,
            // modelling a temporary Windows sharing violation without OS locks.
            std::fs::create_dir(&path).unwrap();
            let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
            let frames = [ReplayFrame {
                cols: 80,
                rows: 24,
                sequence: 1,
                data: Arc::from(&b"retained"[..]),
            }];
            buffer.write_spooled_frames(&frames).unwrap();
            assert_eq!(buffer.retired_spool_paths, vec![path.clone()]);
            let first_current = buffer.spool_path.clone().unwrap();
            assert!(first_current.is_file());
            std::fs::remove_dir(&path).unwrap();
            std::fs::write(&path, b"obsolete spool now deletable").unwrap();
            if cleanup_on_drop {
                drop(buffer);
                assert!(!first_current.exists());
            } else {
                buffer.write_spooled_frames(&frames).unwrap();
                assert!(buffer.retired_spool_paths.is_empty());
                assert!(!first_current.exists());
                let current = buffer.spool_path.clone().unwrap();
                assert!(current.is_file());
                drop(buffer);
                assert!(!current.exists());
            }
            assert!(!path.exists());
            assert_eq!(
                std::fs::read(unrelated).unwrap(),
                b"not owned by this session"
            );
        }
    }

    #[test]
    fn session_buffer_preserves_resize_boundaries() {
        let mut buffer = SessionBuffer::new();
        buffer.push_output(80, 24, 1, b"first");
        buffer.push_resize(120, 30, 2);
        buffer.push_resize(140, 40, 3);
        buffer.push_output(140, 40, 4, b"second");

        let replay = buffer.replay_entries().unwrap();
        assert_eq!(replay.len(), 3);
        assert_eq!((replay[1].cols, replay[1].rows), (140, 40));
        assert!(replay[1].data.is_empty());
        assert_eq!(replay[1].sequence, 3);
        assert_eq!(replay[2].sequence, 4);
    }

    #[test]
    fn reconcile_never_closes_daemon_background_sessions() {
        let host = Arc::new(DaemonHost::new());
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        host.sessions.lock().unwrap().insert(
            session_id.to_string(),
            test_session(session_id, SessionBuffer::new(), 1),
        );
        let server = DaemonServer {
            host: Arc::clone(&host),
            next_client_id: AtomicU64::new(1),
            token: String::new(),
            version: String::new(),
            info_path: PathBuf::new(),
        };

        let reply = server.handle_frame(
            0,
            ClientFrame::Reconcile {
                id: 13,
                active_session_ids: Vec::new(),
            },
        );

        let DaemonFrame::Reconciled { summary, .. } = reply else {
            panic!("expected reconcile response");
        };
        assert_eq!(summary["cleaned_count"], 0);
        assert!(host.sessions.lock().unwrap().contains_key(session_id));
    }

    #[test]
    fn workspace_binding_survives_metadata_round_trip_independently_of_cwd() {
        let host = DaemonHost::new();
        let workspace = serde_json::json!({
            "id": "main:repo", "projectId": "repo", "path": "/repo", "environmentType": "local"
        });
        host.reserve_session_with_launch("bound", Some("/elsewhere".into()), None, None, Some(workspace.clone())).unwrap();
        let session = host.get_session("bound").unwrap();
        let meta = session.lock().unwrap().meta.clone();
        let round_trip: SessionMeta = serde_json::from_value(serde_json::to_value(meta).unwrap()).unwrap();
        assert_eq!(round_trip.workspace, Some(workspace));
        assert_eq!(round_trip.cwd.as_deref(), Some("/elsewhere"));
        host.reserve_session_with_launch("unscoped", None, None, None, Some(serde_json::Value::Null)).unwrap();
        let unscoped = host.get_session("unscoped").unwrap();
        assert!(serde_json::to_value(&unscoped.lock().unwrap().meta).unwrap().get("workspace").unwrap().is_null());
        let unscoped_round_trip: SessionMeta = serde_json::from_value(serde_json::to_value(&unscoped.lock().unwrap().meta).unwrap()).unwrap();
        assert_eq!(unscoped_round_trip.workspace, Some(serde_json::Value::Null));
        host.reserve_session("legacy", None, None).unwrap();
        let legacy = host.get_session("legacy").unwrap();
        assert!(serde_json::to_value(&legacy.lock().unwrap().meta).unwrap().get("workspace").is_none());
    }

    #[test]
    fn session_reservation_is_atomic_for_duplicate_ids() {
        let host = Arc::new(DaemonHost::new());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let session_id = "0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff";
        let first_host = Arc::clone(&host);
        let first_barrier = Arc::clone(&barrier);
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            first_host.reserve_session(session_id, None, None)
        });
        let second_host = Arc::clone(&host);
        let second_barrier = Arc::clone(&barrier);
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            second_host.reserve_session(session_id, None, None)
        });

        let results = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(host.sessions.lock().unwrap().len(), 1);
    }

    #[test]
    fn session_id_validation() {
        assert!(is_valid_session_id("0e0f7b0a-1234-4c5d-9e8f-aabbccddeeff"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../etc/passwd"));
        assert!(!is_valid_session_id(&"x".repeat(65)));
    }

    #[test]
    fn hook_events_map_to_task_status() {
        assert_eq!(
            map_hook_event_to_task_status("UserPromptSubmit"),
            Some("running")
        );
        assert_eq!(
            map_hook_event_to_task_status("PermissionRequest"),
            Some("attention")
        );
        assert_eq!(map_hook_event_to_task_status("Stop"), Some("done"));
        assert_eq!(map_hook_event_to_task_status("StopFailure"), Some("failed"));
        assert_eq!(map_hook_event_to_task_status("SessionStart"), None);
    }

    #[test]
    fn codex_child_turns_leave_parent_task_state_unchanged() {
        let host = DaemonHost::new();
        host.reserve_session("parent", None, None).unwrap();
        let event = |name: &str, agent: Option<&str>| serde_json::json!({
            "tabId": "parent", "sessionId": "parent-thread", "source": "codex",
            "event": name, "agentId": agent,
        });
        host.update_task_status_from_hook(&event("Stop", None));
        let before = host.get_session("parent").unwrap().lock().unwrap().meta.clone();
        host.update_task_status_from_hook(&event("UserPromptSubmit", Some("child-thread")));
        let after = host.get_session("parent").unwrap().lock().unwrap().meta.clone();
        assert_eq!(after.task_status.as_deref(), Some("done"));
        assert_eq!(after.task_updated_at_ms, before.task_updated_at_ms);
        host.update_task_status_from_hook(&event("UserPromptSubmit", None));
        host.update_task_status_from_hook(&event("Stop", Some("child-thread")));
        let after = host.get_session("parent").unwrap().lock().unwrap().meta.clone();
        assert_eq!(after.task_status.as_deref(), Some("running"));
        host.update_task_status_from_hook(&event("PermissionRequest", Some("child-thread")));
        assert_eq!(host.get_session("parent").unwrap().lock().unwrap().meta.task_status.as_deref(), Some("attention"));
    }

    #[test]
    fn remote_hook_metadata_never_probes_local_pids() {
        let host = DaemonHost::new();
        for (id, environment, shell) in [("ssh", Some("ssh"), None),
            ("wsl", Some("wsl"), None), ("legacy-wsl", None, Some("wsl.exe"))] {
            let session = test_session(id, SessionBuffer::new(), 1);
            {
                let mut entry = session.lock().unwrap();
                entry.meta.environment_type = environment.map(str::to_string);
                entry.meta.shell = shell.map(str::to_string);
                entry.meta.root_pid = Some(std::process::id());
            }
            host.sessions.lock().unwrap().insert(id.into(), session);
            let mut hook = serde_json::json!({"tabId":id, "source":"codex", "hookProcessId":std::process::id()});
            assert!(host.correlate_agent_hook(&mut hook));
            assert!(hook.get("agentRunId").is_none());
        }
        assert_eq!(host.agent_tracker.lock().unwrap().scan_counts(), (0, 0));
    }

    #[cfg(unix)]
    #[test]
    fn first_hook_discovers_live_helper_chain_without_a_background_scan() {
        struct Cleanup(Arc<DaemonHost>);
        impl Drop for Cleanup {
            fn drop(&mut self) { let _ = self.0.pty.close_all(); }
        }
        let host = Arc::new(DaemonHost::new());
        let _cleanup = Cleanup(host.clone());
        let dir = tempfile::tempdir().unwrap();
        // Native test executables avoid re-signing Apple's platform binaries.
        let fixture = compile_agent_process_fixture(dir.path());
        for name in ["codex", "claude"] {
            let path = dir.path().join(name);
            std::fs::copy(&fixture, &path).unwrap();
        }
        let helper_file = dir.path().join("helper-pid");
        host.reserve_session("first-hook", None, Some("bash".into())).unwrap();
        let traits = host.pty.create("first-hook", None, None, Some("bash"),
            Arc::new(DaemonPtyEventSink::new(host.clone(), "first-hook".into()))).unwrap();
        let session = host.get_session("first-hook").unwrap();
        {
            let mut entry = session.lock().unwrap();
            entry.meta.root_pid = Some(traits.root_pid);
            entry.meta.root_started_at = traits.root_started_at;
        }
        host.pty.write("first-hook", &format!("{} --launch {} --helper {}\r",
            crate::ssh_transport::posix_quote(&dir.path().join("codex").to_string_lossy()),
            crate::ssh_transport::posix_quote(&dir.path().join("claude").to_string_lossy()),
            crate::ssh_transport::posix_quote(&helper_file.to_string_lossy()))).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let helper = loop {
            if let Ok(text) = std::fs::read_to_string(&helper_file) {
                if let Ok(pid) = text.trim().parse::<u32>() { break pid; }
            }
            assert!(Instant::now() < deadline, "helper did not start; test PTY replay:\n{}", test_pty_replay(&host, "first-hook"));
            std::thread::sleep(Duration::from_millis(20));
        };
        // The very first Hook may have inherited an external tab ID. Recover
        // from fresh helper ancestry even before the watchdog knows this Agent.
        assert!(session.lock().unwrap().meta.agent_detection.is_none());
        let mut external = serde_json::json!({
            "tabId":"external:codex:first", "source":"codex", "event":"Stop",
            "hookProcessId":helper, "cwd":dir.path(),
        });
        assert!(host.correlate_agent_hook(&mut external));
        assert_eq!(external["tabId"], "first-hook");
        assert_eq!(external["agentDetection"]["agent"]["tool"], "codex");
        assert_eq!(host.agent_tracker.lock().unwrap().scan_counts().0, 0);
        let mut wrong_source = serde_json::json!({
            "tabId":"external:claude:first", "source":"claude", "event":"Stop",
            "hookProcessId":helper, "cwd":dir.path(),
        });
        assert!(host.correlate_agent_hook(&mut wrong_source));
        assert_eq!(wrong_source["tabId"], "external:claude:first");
        assert!(wrong_source.get("agentRunId").is_none());
        // Even duplicate root metadata must not turn one process into two
        // possible owners; remote roots never participate in local recovery.
        let duplicate = test_session("duplicate-root", SessionBuffer::new(), 1);
        {
            let mut entry = duplicate.lock().unwrap();
            entry.meta = session.lock().unwrap().meta.clone();
            entry.meta.session_id = "duplicate-root".into();
        }
        host.sessions.lock().unwrap().insert("duplicate-root".into(), duplicate.clone());
        let mut ambiguous = serde_json::json!({
            "tabId":"external:codex:ambiguous", "source":"codex", "hookProcessId":helper,
        });
        assert!(host.correlate_agent_hook(&mut ambiguous));
        assert_eq!(ambiguous["tabId"], "external:codex:ambiguous");
        for environment in ["ssh", "wsl"] {
            duplicate.lock().unwrap().meta.environment_type = Some(environment.into());
            assert!(host.correlate_agent_hook(&mut ambiguous));
            assert_eq!(ambiguous["tabId"], "first-hook");
            ambiguous["tabId"] = serde_json::json!("external:codex:ambiguous");
        }
        host.sessions.lock().unwrap().remove("duplicate-root");
        let mut hook = serde_json::json!({"tabId":"first-hook", "source":"codex", "event":"Stop", "hookProcessId":helper});
        assert!(host.correlate_agent_hook(&mut hook));
        assert_eq!(hook["agentDetection"]["agent"]["tool"], "codex");
        let agent_pid = hook["agentDetection"]["agent"]["pid"].as_u64().unwrap() as u32;
        assert_ne!(agent_pid, helper);
        let before = host.agent_tracker.lock().unwrap().scan_counts();
        for _ in 0..20 { assert!(host.correlate_agent_hook(&mut hook)); }
        let counts = host.agent_tracker.lock().unwrap().scan_counts();
        assert_eq!(counts.0, 0);
        assert_eq!(counts.1 - before.1, 20 * 5, "helper, nested Agent, outer Agent, shell and daemon only");
        hook["source"] = serde_json::json!("claude");
        assert!(!host.correlate_agent_hook(&mut hook), "nested Agent cannot own the pane");
        hook["source"] = serde_json::json!("codex");
        session.lock().unwrap().meta.root_started_at = Some(1);
        assert!(!host.correlate_agent_hook(&mut hook), "reused root must not bind");
        session.lock().unwrap().meta.root_started_at = traits.root_started_at;
        hook["hookProcessId"] = serde_json::json!(u64::from(helper) + (1u64 << 32));
        assert!(!host.correlate_agent_hook(&mut hook), "out-of-range PID must not truncate");
        hook["hookProcessId"] = serde_json::json!(helper);
        assert_eq!(unsafe { nix::libc::kill(helper as i32, nix::libc::SIGKILL) }, 0);
        let deadline = Instant::now() + Duration::from_secs(3);
        while host.correlate_agent_hook(&mut hook) {
            assert!(Instant::now() < deadline, "exited helper remained trusted");
            std::thread::sleep(Duration::from_millis(20));
        }
        // A pipeline creates two independent foreground Agents in the same
        // pane. Neither has been sampled by the background tracker: the Hook
        // helper alone must not make its own branch appear unambiguous.
        std::fs::remove_file(&helper_file).unwrap();
        host.pty.write("first-hook", &format!("{} --wait | {} --helper {}\r",
            crate::ssh_transport::posix_quote(&dir.path().join("codex").to_string_lossy()),
            crate::ssh_transport::posix_quote(&dir.path().join("claude").to_string_lossy()),
            crate::ssh_transport::posix_quote(&helper_file.to_string_lossy()))).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let sibling_helper = loop {
            if let Ok(text) = std::fs::read_to_string(&helper_file) {
                if let Ok(pid) = text.trim().parse::<u32>() { break pid; }
            }
            assert!(Instant::now() < deadline, "pipeline helper did not start; test PTY replay:\n{}", test_pty_replay(&host, "first-hook"));
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut sibling_hook = serde_json::json!({"tabId":"first-hook", "source":"claude", "event":"Stop", "hookProcessId":sibling_helper});
        assert!(!host.correlate_agent_hook(&mut sibling_hook), "unsampled independent foreground siblings remain ambiguous");
        sibling_hook["tabId"] = serde_json::json!("external:claude:siblings");
        assert!(host.correlate_agent_hook(&mut sibling_hook));
        assert_eq!(sibling_hook["tabId"], "external:claude:siblings");
        assert!(sibling_hook.get("agentRunId").is_none());
        assert_eq!(host.agent_tracker.lock().unwrap().scan_counts().0, 0);
    }

    #[cfg(unix)]
    #[test]
    fn foreground_agent_discovery_follows_real_ptys_without_ui_or_hooks() {
        struct Cleanup(Arc<DaemonHost>, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.pty.close_all();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let host = Arc::new(DaemonHost::new());
        let dir =
            std::env::temp_dir().join(format!("cli-manager-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let _cleanup = Cleanup(host.clone(), dir.clone());
        // Harmless foreground binaries: no network calls or AI requests.
        let fixture = compile_agent_process_fixture(&dir);
        for name in ["codex", "claude"] {
            let path = if name == "claude" {
                dir.join(".local/share/claude/versions/2.1.278")
            } else {
                dir.join(name)
            };
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::copy(&fixture, &path).unwrap();
            if name == "claude" {
                std::os::unix::fs::symlink(&path, dir.join(name)).unwrap();
            }
        }
        for id in ["one", "two"] {
            host.reserve_session(id, Some(dir.to_string_lossy().into()), Some("bash".into()))
                .unwrap();
            let sink = Arc::new(DaemonPtyEventSink::new(host.clone(), id.to_string()));
            let traits = host
                .pty
                .create(id, dir.to_str(), None, Some("bash"), sink)
                .unwrap();
            let session = host.get_session(id).unwrap();
            let mut entry = session.lock().unwrap();
            entry.meta.root_pid = Some(traits.root_pid);
            entry.meta.root_started_at = traits.root_started_at;
        }
        let wait = |id: &str, tool: Option<&str>| {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                host.refresh_agents();
                let meta = host.get_session(id).unwrap().lock().unwrap().meta.clone();
                if let Some(detection) = &meta.agent_detection {
                    if detection.agent.as_ref().map(|a| a.tool.as_str()) == tool {
                        return meta;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "expected {tool:?} in {id}, got {:?}; test PTY replay:\n{}",
                    meta.agent_detection,
                    test_pty_replay(&host, id)
                );
                std::thread::sleep(Duration::from_millis(60));
            }
        };
        wait("one", None);
        host.pty
            .write("one", &format!("{}\r", crate::ssh_transport::posix_quote(&dir.join("codex").to_string_lossy())))
            .unwrap();
        let first = wait("one", Some("codex"));
        let first_id = first.agent_detection.unwrap().agent.unwrap().run_id;
        assert!(
            first.task_status.is_none(),
            "process presence must not claim a running turn"
        );
        wait("two", None);
        let mut hook = serde_json::json!({"tabId":"one", "source":"codex", "event":"Stop", "hookProcessId":std::process::id()});
        assert!(
            !host.correlate_agent_hook(&mut hook),
            "unrelated process must not impersonate the Agent"
        );
        hook.as_object_mut().unwrap().remove("hookProcessId");
        assert!(
            host.correlate_agent_hook(&mut hook),
            "live metadata: {:?}",
            host.get_session("one").unwrap().lock().unwrap().meta
        );
        assert_eq!(hook["agentRunId"], first_id);
        let before = host.agent_tracker.lock().unwrap().scan_counts();
        for _ in 0..50 { assert!(host.correlate_agent_hook(&mut hook)); }
        let after = host.agent_tracker.lock().unwrap().scan_counts();
        assert_eq!(after.0, before.0, "Hook traffic must not trigger full process scans");
        assert!(after.1 > before.1, "each Hook must still revalidate live processes");
        assert!(after.1 - before.1 <= 50 * 8, "only this pane's ancestry is read");
        host.update_task_status_from_hook(&hook);
        host.refresh_agents();
        assert_eq!(
            host.get_session("one")
                .unwrap()
                .lock()
                .unwrap()
                .meta
                .task_status
                .as_deref(),
            Some("done")
        );
        host.pty.write("one", "\u{1a}").unwrap(); // suspend to shell
        wait("one", None);
        assert!(
            !host.correlate_agent_hook(&mut hook),
            "old Hook must not revive a suspended Agent"
        );
        host.pty.write("one", "fg\r").unwrap();
        wait("one", Some("codex"));
        host.pty.write("one", "\u{4}").unwrap();
        wait("one", None);
        host.pty
            .write("one", &format!("{}\r", crate::ssh_transport::posix_quote(&dir.join("claude").to_string_lossy())))
            .unwrap();
        let switched = wait("one", Some("claude"));
        assert_ne!(
            switched.agent_detection.unwrap().agent.unwrap().run_id,
            first_id
        );
        assert!(
            !host.correlate_agent_hook(&mut hook),
            "late Codex Hook must not bind to Claude"
        );
        wait("two", None);
        host.pty
            .write("two", &format!("exec {}\r", crate::ssh_transport::posix_quote(&dir.join("codex").to_string_lossy())))
            .unwrap();
        let replaced_shell = wait("two", Some("codex"));
        let second_agent = replaced_shell.agent_detection.as_ref().unwrap().agent.as_ref().unwrap();
        let mut external = serde_json::json!({
            "tabId":"external:codex:outside", "sessionId":"outside", "source":"codex",
            "event":"Stop", "cwd":dir, "hookProcessId":std::process::id(),
        });
        assert!(host.correlate_agent_hook(&mut external));
        assert_eq!(external["tabId"], "external:codex:outside",
            "unrelated same-directory Hook must remain outside every PTY");
        assert!(external.get("agentRunId").is_none());
        external["hookProcessId"] = serde_json::json!(second_agent.pid);
        assert!(host.correlate_agent_hook(&mut external));
        assert_eq!(external["tabId"], "two", "only the owning PTY can be recovered");
        assert_eq!(external["agentRunId"], second_agent.run_id);
        assert_eq!(
            replaced_shell.root_pid,
            replaced_shell.agent_detection.unwrap().agent.map(|a| a.pid)
        );
    }
}
