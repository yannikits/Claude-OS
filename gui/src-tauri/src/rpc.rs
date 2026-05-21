use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{Mutex, oneshot};

#[derive(Serialize)]
struct RpcRequest<'a> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: Value,
    // M8 (2026-05-21 code-review): optional shared-secret nonce.
    // RpcClient hier ist v1.2-MVP-Variante die kein stderr-handshake
    // hat — Caller setzt nonce explizit via `with_nonce()`. Sidecar
    // akzeptiert requests ohne nonce nur wenn der Dispatcher KEINEN
    // expectedNonce gesetzt hat (CLAUDE_OS_RPC_NONCE=disabled).
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
}

#[derive(Deserialize)]
struct RpcEnvelope {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcErrorObj>,
}

#[derive(Deserialize, Debug)]
struct RpcErrorObj {
    code: i64,
    message: String,
    #[serde(default)]
    #[allow(dead_code)]
    data: Option<Value>,
}

#[derive(Debug)]
pub enum RpcError {
    Transport(std::io::Error),
    Remote { code: i64, message: String },
    Serde(serde_json::Error),
    Cancelled,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(e) => write!(f, "rpc transport error: {e}"),
            Self::Remote { code, message } => write!(f, "rpc remote error {code}: {message}"),
            Self::Serde(e) => write!(f, "rpc serialization error: {e}"),
            Self::Cancelled => write!(f, "rpc channel closed before response arrived"),
        }
    }
}

impl std::error::Error for RpcError {}

impl From<std::io::Error> for RpcError {
    fn from(e: std::io::Error) -> Self {
        Self::Transport(e)
    }
}

impl From<serde_json::Error> for RpcError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serde(e)
    }
}

type PendingMap = Mutex<HashMap<u64, oneshot::Sender<RpcEnvelope>>>;

#[derive(Clone)]
pub struct RpcClient {
    next_id: Arc<AtomicU64>,
    pending: Arc<PendingMap>,
    stdin: Arc<Mutex<ChildStdin>>,
    /// M8 (2026-05-21 code-review): optional nonce attached to every
    /// outgoing request. Set via `with_nonce()` after the caller has
    /// extracted it from a sidecar-ready stderr handshake.
    nonce: Arc<Mutex<Option<String>>>,
}

impl RpcClient {
    /// M8: clone of this client that forwards `nonce` on every call.
    /// Idempotent — calling again overwrites the previous nonce.
    pub async fn set_nonce(&self, nonce: String) {
        *self.nonce.lock().await = Some(nonce);
    }

    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> (Self, impl Future<Output = ()>) {
        let pending: Arc<PendingMap> = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending.clone();
        let reader = async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(envelope) = serde_json::from_str::<RpcEnvelope>(trimmed) else {
                    continue;
                };
                let Some(id) = envelope.id else {
                    continue;
                };
                if let Some(tx) = pending_clone.lock().await.remove(&id) {
                    let _ = tx.send(envelope);
                }
            }
            let mut pending = pending_clone.lock().await;
            for (_id, tx) in pending.drain() {
                let _ = tx.send(RpcEnvelope { id: None, result: None, error: None });
            }
        };
        let client = Self {
            next_id: Arc::new(AtomicU64::new(1)),
            pending,
            stdin: Arc::new(Mutex::new(stdin)),
            nonce: Arc::new(Mutex::new(None)),
        };
        (client, reader)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let nonce = self.nonce.lock().await.clone();
        let request = RpcRequest { jsonrpc: "2.0", id, method, params, nonce };
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');

        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }

        let envelope = rx.await.map_err(|_| RpcError::Cancelled)?;
        if let Some(err) = envelope.error {
            return Err(RpcError::Remote { code: err.code, message: err.message });
        }
        Ok(envelope.result.unwrap_or(Value::Null))
    }
}
