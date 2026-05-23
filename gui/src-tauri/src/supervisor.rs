use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::{Mutex, Notify, oneshot};
use tokio::time::sleep;

pub const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
pub const SIDECAR_FAILED_EVENT: &str = "sidecar://failed";
pub const SIDECAR_STDERR_EVENT: &str = "sidecar://stderr";
pub const BACKOFF_LADDER: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(16),
];

pub fn next_backoff(strike: usize) -> Option<Duration> {
    BACKOFF_LADDER.get(strike).copied()
}

/// M8 hardening (Codex review 2026-05-24): `randomBytes(16).toString('hex')`
/// produziert genau 32 lowercase hex chars. Wir akzeptieren nichts anderes
/// — kein arbitrary string, kein leerer wert, kein uppercase-mix.
pub fn is_valid_nonce(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Deserialize)]
struct RpcEnvelope {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcErrorObj>,
}

#[derive(Deserialize)]
struct RpcErrorObj {
    code: i64,
    message: String,
}

#[derive(Serialize)]
struct RpcRequest<'a> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: Value,
    // M8 (2026-05-21 code-review): per-spawn nonce, set on the first
    // sidecar-ready handshake from stderr. None until handshake; that
    // path is back-compat for the `ping`/`shutdown` calls before the
    // sidecar has fully booted.
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
}

#[derive(Debug)]
pub enum RpcError {
    Closed,
    Remote { code: i64, message: String },
    Io(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "sidecar rpc channel closed"),
            Self::Remote { code, message } => write!(f, "sidecar remote {code}: {message}"),
            Self::Io(e) => write!(f, "sidecar io: {e}"),
        }
    }
}

impl std::error::Error for RpcError {}

pub struct SidecarRpc {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<RpcEnvelope>>>,
    child: Mutex<Option<CommandChild>>,
    /// M8 (2026-05-21 code-review): per-spawn nonce extracted from
    /// sidecar-ready handshake on stderr. Attached to every outgoing
    /// RpcRequest after handshake.
    nonce: Mutex<Option<String>>,
}

impl SidecarRpc {
    fn new(child: CommandChild) -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
            nonce: Mutex::new(None),
        })
    }

    /// M8: called by the stderr router when it parses the
    /// `{"type":"sidecar-ready","nonce":"..."}` handshake line.
    ///
    /// M8 hardening (Codex review 2026-05-24): **first-handshake-only**.
    /// Wenn eine zweite handshake-line auftaucht (z. B. weil ein
    /// stderr-Replay-Angriff oder ein malicious sidecar plant den nonce
    /// zu rotieren), wird sie ignoriert + geloggt. Plus format-Check:
    /// nonce muss `^[0-9a-f]{32}$` matchen (32-hex aus dem Sidecar-
    /// `randomBytes(16).toString('hex')`-Generator).
    ///
    /// Returns `true` wenn der nonce gesetzt wurde, `false` bei reject.
    async fn set_nonce(&self, nonce: String) -> bool {
        if !is_valid_nonce(&nonce) {
            eprintln!(
                "[supervisor] rejected handshake: nonce format invalid (expected 32 lowercase hex)"
            );
            return false;
        }
        let mut guard = self.nonce.lock().await;
        if guard.is_some() {
            eprintln!(
                "[supervisor] rejected second handshake: first-handshake-only policy (M8 hardening)"
            );
            return false;
        }
        *guard = Some(nonce);
        true
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let nonce = self.nonce.lock().await.clone();
        let req = RpcRequest { jsonrpc: "2.0", id, method, params, nonce };
        let mut line = serde_json::to_string(&req).map_err(|e| RpcError::Io(e.to_string()))?;
        line.push('\n');

        {
            let mut child_guard = self.child.lock().await;
            let child = child_guard.as_mut().ok_or(RpcError::Closed)?;
            child.write(line.as_bytes()).map_err(|e| RpcError::Io(e.to_string()))?;
        }

        let envelope = rx.await.map_err(|_| RpcError::Closed)?;
        if let Some(err) = envelope.error {
            return Err(RpcError::Remote { code: err.code, message: err.message });
        }
        Ok(envelope.result.unwrap_or(Value::Null))
    }

    async fn kill(&self) {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub struct SupervisorState {
    pub rpc: Mutex<Option<Arc<SidecarRpc>>>,
}

pub fn start(app: AppHandle, state: Arc<SupervisorState>) {
    tauri::async_runtime::spawn(async move {
        let mut strikes: usize = 0;
        loop {
            let err = spawn_and_run(&app, &state).await;
            eprintln!("[supervisor] sidecar cycle ended: {err}");

            let Some(wait) = next_backoff(strikes) else {
                eprintln!("[supervisor] 3 strikes reached, giving up");
                let _ = app.emit(
                    SIDECAR_FAILED_EVENT,
                    json!({ "reason": err.to_string(), "strikes": strikes }),
                );
                return;
            };
            eprintln!("[supervisor] sleeping {wait:?} before strike {}/3", strikes + 1);
            sleep(wait).await;
            strikes += 1;
        }
    });
}

async fn spawn_and_run(app: &AppHandle, state: &Arc<SupervisorState>) -> RpcError {
    let cmd = match app.shell().sidecar("claude-os-sidecar") {
        Ok(c) => c
            .env("CLAUDE_OS_SECRETS_BACKEND", "encrypted-file")
            .env("CLAUDE_OS_PORTABLE", "1")
            // M8 hardening (Codex review 2026-05-24): force `auto` so a
            // user-set `CLAUDE_OS_RPC_NONCE=disabled` (or a malicious
            // env-override that pins a known nonce) cannot defeat the
            // gate on Tauri-supervised sidecars. Devs who run the
            // sidecar manually (without Tauri) keep the env-control
            // for tests / debugging.
            .env("CLAUDE_OS_RPC_NONCE", "auto"),
        Err(e) => return RpcError::Io(format!("sidecar() failed: {e}")),
    };

    let (mut rx, child) = match cmd.spawn() {
        Ok(t) => t,
        Err(e) => return RpcError::Io(format!("spawn() failed: {e}")),
    };

    let rpc = SidecarRpc::new(child);
    *state.rpc.lock().await = Some(rpc.clone());

    let dead = Arc::new(Notify::new());

    let dead_for_router = dead.clone();
    let rpc_for_router = rpc.clone();
    let app_for_router = app.clone();
    let router = tokio::spawn(async move {
        let mut buf = String::new();
        // M8 hardening (Codex review 2026-05-24): separate stderr-buffer.
        // Vorher hat der stderr-Arm jeden `CommandEvent::Stderr(bytes)`
        // als ganze Line behandelt — wenn pino oder ein anderer Writer
        // den Output ueber Chunk-Grenzen splittet (z. B. die handshake-
        // JSON wird in zwei `Stderr`-Events geliefert), wurde der
        // handshake silently verfehlt und der nonce nie gesetzt.
        // Jetzt buffern wir stderr identisch zu stdout: an `\n` splitten,
        // partial-tail zurueck in den Buffer, jede komplette Line
        // einzeln verarbeiten.
        let mut stderr_buf = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(nl) = buf.find('\n') {
                        let line: String = buf.drain(..=nl).collect();
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let Ok(raw) = serde_json::from_str::<Value>(trimmed) else {
                            continue;
                        };
                        if let Some(id) = raw.get("id").and_then(Value::as_u64) {
                            if let Ok(env) = serde_json::from_str::<RpcEnvelope>(trimmed) {
                                if let Some(tx) = rpc_for_router.pending.lock().await.remove(&id) {
                                    let _ = tx.send(env);
                                }
                            }
                        } else if let Some(method) = raw.get("method").and_then(Value::as_str) {
                            let params = raw.get("params").cloned().unwrap_or(Value::Null);
                            let _ = app_for_router.emit(method, params);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(nl) = stderr_buf.find('\n') {
                        let line_owned: String = stderr_buf.drain(..=nl).collect();
                        let line = line_owned.trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        // M8 (2026-05-21 code-review, hardened 2026-05-24):
                        // parse sidecar-ready handshake. The line is JSON
                        // with shape:
                        // {"type":"sidecar-ready","nonce":"<32hex>","pid":N}
                        // Hardening: nonce-format-validation +
                        // first-handshake-only sind in `set_nonce()`
                        // erzwungen. Replays oder format-violations
                        // werden dort silently abgelehnt + geloggt.
                        // (rust 2021 / 1.77: let-chains nicht stabilisiert —
                        // wir nesten if-let statt && let zu chainen.)
                        let handled_handshake =
                            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                                if json.get("type").and_then(Value::as_str)
                                    == Some("sidecar-ready")
                                {
                                    if let Some(nonce) = json.get("nonce").and_then(Value::as_str) {
                                        let accepted =
                                            rpc_for_router.set_nonce(nonce.to_string()).await;
                                        if accepted {
                                            eprintln!(
                                                "[supervisor] sidecar-ready handshake accepted"
                                            );
                                        }
                                        accepted
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            } else {
                                false
                            };
                        if handled_handshake {
                            // Don't forward the handshake to the renderer
                            // as a regular stderr-event — it's an internal
                            // protocol detail.
                            continue;
                        }
                        eprintln!("[sidecar.stderr] {line}");
                        let _ = app_for_router
                            .emit(SIDECAR_STDERR_EVENT, json!({ "line": line }));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[sidecar] terminated: code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[sidecar] error event: {err}");
                    break;
                }
                _ => {}
            }
        }
        dead_for_router.notify_one();
    });

    let dead_for_health = dead.clone();
    let rpc_for_health = rpc.clone();
    let health = tokio::spawn(async move {
        loop {
            sleep(HEALTH_INTERVAL).await;
            if rpc_for_health.call("ping", json!(null)).await.is_err() {
                dead_for_health.notify_one();
                return;
            }
        }
    });

    dead.notified().await;

    health.abort();
    router.abort();

    rpc.kill().await;
    *state.rpc.lock().await = None;

    RpcError::Closed
}

pub async fn graceful_shutdown(state: Arc<SupervisorState>) {
    let rpc_opt = state.rpc.lock().await.clone();
    let Some(rpc) = rpc_opt else { return };

    let _ = tokio::time::timeout(SHUTDOWN_GRACE, rpc.call("shutdown", json!(null))).await;
    sleep(SHUTDOWN_GRACE).await;
    rpc.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_ladder_is_1_4_16_seconds() {
        assert_eq!(BACKOFF_LADDER[0], Duration::from_secs(1));
        assert_eq!(BACKOFF_LADDER[1], Duration::from_secs(4));
        assert_eq!(BACKOFF_LADDER[2], Duration::from_secs(16));
    }

    #[test]
    fn next_backoff_returns_some_for_strikes_0_to_2() {
        assert_eq!(next_backoff(0), Some(Duration::from_secs(1)));
        assert_eq!(next_backoff(1), Some(Duration::from_secs(4)));
        assert_eq!(next_backoff(2), Some(Duration::from_secs(16)));
    }

    #[test]
    fn next_backoff_returns_none_at_strike_3() {
        assert!(next_backoff(3).is_none());
        assert!(next_backoff(99).is_none());
    }

    #[test]
    fn health_interval_is_30_seconds() {
        assert_eq!(HEALTH_INTERVAL, Duration::from_secs(30));
    }

    #[test]
    fn shutdown_grace_is_2_seconds() {
        assert_eq!(SHUTDOWN_GRACE, Duration::from_secs(2));
    }

    #[test]
    fn sidecar_event_names_are_stable() {
        assert_eq!(SIDECAR_FAILED_EVENT, "sidecar://failed");
        assert_eq!(SIDECAR_STDERR_EVENT, "sidecar://stderr");
    }

    // -------- M8 hardening (Codex review 2026-05-24) --------

    #[test]
    fn m8_is_valid_nonce_accepts_32_lowercase_hex() {
        // Beispiel-output von randomBytes(16).toString('hex')
        assert!(is_valid_nonce("0123456789abcdef0123456789abcdef"));
        assert!(is_valid_nonce("ffffffffffffffffffffffffffffffff"));
        assert!(is_valid_nonce("00000000000000000000000000000000"));
    }

    #[test]
    fn m8_is_valid_nonce_rejects_wrong_length() {
        assert!(!is_valid_nonce(""));
        assert!(!is_valid_nonce("0123456789abcdef0123456789abcde")); // 31
        assert!(!is_valid_nonce("0123456789abcdef0123456789abcdefa")); // 33
    }

    #[test]
    fn m8_is_valid_nonce_rejects_uppercase_or_non_hex() {
        assert!(!is_valid_nonce("0123456789ABCDEF0123456789abcdef")); // uppercase
        assert!(!is_valid_nonce("0123456789abcdef0123456789abcdeg")); // 'g' not hex
        assert!(!is_valid_nonce("0123456789abcdef0123456789abcde "));  // trailing space
        assert!(!is_valid_nonce("0123456789abcdef0123456789abcde\n")); // trailing newline
    }

    /// set_nonce ist async; tokio::test-Runtime fuer den lock
    #[tokio::test]
    async fn m8_set_nonce_first_only_rejects_replay() {
        let rpc = SidecarRpc::new_for_test_without_child();
        let first = "0123456789abcdef0123456789abcdef".to_string();
        let second = "fedcba9876543210fedcba9876543210".to_string();

        assert!(rpc.set_nonce(first.clone()).await);
        assert_eq!(rpc.nonce.lock().await.as_deref(), Some(first.as_str()));

        // Second call must be rejected and the original nonce preserved
        assert!(!rpc.set_nonce(second).await);
        assert_eq!(rpc.nonce.lock().await.as_deref(), Some(first.as_str()));
    }

    #[tokio::test]
    async fn m8_set_nonce_rejects_invalid_format_without_setting() {
        let rpc = SidecarRpc::new_for_test_without_child();
        assert!(!rpc.set_nonce("not-hex-and-too-short".to_string()).await);
        assert!(rpc.nonce.lock().await.is_none());
    }

    impl SidecarRpc {
        /// Test-only constructor — bypasses `CommandChild` requirement
        /// since the nonce/handshake logic is pure state-handling.
        fn new_for_test_without_child() -> Arc<Self> {
            Arc::new(Self {
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                child: Mutex::new(None),
                nonce: Mutex::new(None),
            })
        }
    }
}
