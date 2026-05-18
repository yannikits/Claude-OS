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
pub const BACKOFF_LADDER: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(16),
];

pub fn next_backoff(strike: usize) -> Option<Duration> {
    BACKOFF_LADDER.get(strike).copied()
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
}

impl SidecarRpc {
    fn new(child: CommandChild) -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = RpcRequest { jsonrpc: "2.0", id, method, params };
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
            .env("CLAUDE_OS_PORTABLE", "1"),
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
                    eprintln!("[sidecar.stderr] {}", String::from_utf8_lossy(&bytes).trim());
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
}
