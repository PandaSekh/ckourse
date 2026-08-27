//! `srv://` URI scheme — streams videos from a saved server with seeking.
//!
//! Same shape as `drive_protocol`, and for the same reason: a `<video>` element
//! parses an MP4 container with hundreds of tiny range requests, and one network
//! round-trip each stalls playback outright. Requests are served from aligned
//! 2 MB blocks fetched on demand, so the player's small reads collapse into a
//! handful of fetches and a seek only pulls the blocks it lands on.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use percent_encoding::percent_decode_str;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

use crate::remote;

pub const SCHEME: &str = "srv";

/// Cache/fetch granularity.
const BLOCK: u64 = 2 * 1024 * 1024;
/// How many bytes to hand the player for an open-ended (`bytes=N-`) request.
const OPEN_ENDED_DELIVER: u64 = 4 * 1024 * 1024;
/// Ceiling on cached blocks for the current file (~64 MB), so scrubbing through
/// a long video doesn't grow the cache without bound.
const MAX_BLOCKS: usize = 32;

/// Single-file read-ahead cache — the player streams one video at a time, so a
/// new file resets it and bounds memory to the blocks in flight.
struct FileCache {
    uri: String,
    total: u64,
    content_type: String,
    blocks: HashMap<u64, Arc<Vec<u8>>>,
    /// Insertion order, for evicting the oldest block past `MAX_BLOCKS`.
    order: VecDeque<u64>,
}

static CACHE: OnceLock<Mutex<Option<FileCache>>> = OnceLock::new();
fn cache_cell() -> &'static Mutex<Option<FileCache>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

pub fn handle(
    _ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let response = serve(request).await;
        responder.respond(response);
    });
}

async fn serve(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = match decode_uri(&request) {
        Some(u) if !u.is_empty() => u,
        _ => return status_only(StatusCode::BAD_REQUEST),
    };
    let Some((server_id, path)) = remote::split_uri(&uri) else {
        eprintln!("[srv] malformed uri: {uri}");
        return status_only(StatusCode::BAD_REQUEST);
    };

    let (total, content_type) = match ensure_meta(&uri, &server_id, &path).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[srv] meta error for {uri}: {e}");
            return status_only(StatusCode::BAD_GATEWAY);
        }
    };

    if request.method() == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, total.to_string())
            .header(header::ACCEPT_RANGES, "bytes")
            .body(Vec::new())
            .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR));
    }

    if total == 0 {
        return status_only(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let (start, end_opt) = parse_req_range(&request);
    if start >= total {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Vec::new())
            .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR));
    }
    let end = end_opt
        .unwrap_or(start + OPEN_ENDED_DELIVER - 1)
        .min(total - 1);

    // Assemble [start..=end] from cached blocks, fetching any that are missing.
    let mut body: Vec<u8> = Vec::with_capacity((end - start + 1) as usize);
    let mut pos = start;
    while pos <= end {
        let block_idx = pos / BLOCK;
        let block = match get_block(&uri, &server_id, &path, block_idx, total).await {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[srv] block {block_idx} fetch error: {e}");
                return status_only(StatusCode::BAD_GATEWAY);
            }
        };
        let block_start = block_idx * BLOCK;
        let block_end_global = block_start + block.len() as u64; // exclusive
        if pos >= block_end_global {
            break; // safety: short final block
        }
        let off = (pos - block_start) as usize;
        let copy_end = (end + 1).min(block_end_global); // exclusive
        let len = (copy_end - pos) as usize;
        body.extend_from_slice(&block[off..off + len]);
        pos = copy_end;
    }

    if body.is_empty() {
        return status_only(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let actual_end = start + body.len() as u64 - 1;

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{actual_end}/{total}"),
        )
        .body(body)
        .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Ensure the cache holds the size and content type for `uri`, resetting it when
/// a different file starts streaming. Returns (total, content_type).
async fn ensure_meta(uri: &str, server_id: &str, path: &str) -> Result<(u64, String), String> {
    {
        let guard = cache_cell().lock().map_err(|e| e.to_string())?;
        if let Some(c) = guard.as_ref() {
            if c.uri == uri {
                return Ok((c.total, c.content_type.clone()));
            }
        }
    }

    let owned = path.to_string();
    let total = remote::with_backend(server_id, move |b| {
        let path = owned.clone();
        async move { b.size_of(&path).await }
    })
    .await?;

    let content_type = remote::guess_mime(path).to_string();
    eprintln!("[srv] meta {uri} total={total} type={content_type}");

    let mut guard = cache_cell().lock().map_err(|e| e.to_string())?;
    *guard = Some(FileCache {
        uri: uri.to_string(),
        total,
        content_type: content_type.clone(),
        blocks: HashMap::new(),
        order: VecDeque::new(),
    });
    Ok((total, content_type))
}

/// Return a cached block, fetching it from the server on a miss.
async fn get_block(
    uri: &str,
    server_id: &str,
    path: &str,
    block_idx: u64,
    total: u64,
) -> Result<Arc<Vec<u8>>, String> {
    {
        let guard = cache_cell().lock().map_err(|e| e.to_string())?;
        if let Some(c) = guard.as_ref() {
            if c.uri == uri {
                if let Some(b) = c.blocks.get(&block_idx) {
                    return Ok(b.clone());
                }
            }
        }
    }

    let block_start = block_idx * BLOCK;
    let block_end = ((block_idx + 1) * BLOCK).min(total) - 1; // inclusive
    let owned = path.to_string();
    let bytes = remote::with_backend(server_id, move |b| {
        let path = owned.clone();
        async move { b.read_range(&path, block_start, block_end).await }
    })
    .await?;
    let arc = Arc::new(bytes);

    let mut guard = cache_cell().lock().map_err(|e| e.to_string())?;
    if let Some(c) = guard.as_mut() {
        if c.uri == uri && c.blocks.insert(block_idx, arc.clone()).is_none() {
            c.order.push_back(block_idx);
            while c.order.len() > MAX_BLOCKS {
                if let Some(oldest) = c.order.pop_front() {
                    c.blocks.remove(&oldest);
                }
            }
        }
    }
    Ok(arc)
}

/// Parse the request's Range header into (start, optional end). Defaults to (0, None).
fn parse_req_range(request: &Request<Vec<u8>>) -> (u64, Option<u64>) {
    let raw = match request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s,
        None => return (0, None),
    };
    let spec = match raw.strip_prefix("bytes=") {
        Some(s) => s,
        None => return (0, None),
    };
    let (a, b) = match spec.split_once('-') {
        Some(parts) => parts,
        None => return (0, None),
    };
    let start: u64 = a.trim().parse().unwrap_or(0);
    let end = b.trim();
    let end_opt = if end.is_empty() {
        None
    } else {
        end.parse::<u64>().ok()
    };
    (start, end_opt)
}

/// The frontend hands us `<serverId>:<path>` through `convertFileSrc`, which
/// percent-encodes the whole thing into a single path segment.
fn decode_uri(request: &Request<Vec<u8>>) -> Option<String> {
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    Some(format!("{}{}", remote::URI_PREFIX, decoded))
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("status-only response")
}
