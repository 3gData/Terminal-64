use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};

/// A simple localhost-only HTTP server that serves widget files from
/// `~/.terminal64/widgets/{widget_id}/`.  Widgets loaded via `<iframe src=...>`
/// get a proper `http://127.0.0.1:{port}` origin, enabling relative imports,
/// ES modules, multi-file projects, and camera/mic permissions.
pub struct WidgetServer {
    port: AtomicU16,
}

fn widgets_base() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".terminal64").join("widgets"))
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "xml" => "application/xml",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(mut stream: TcpStream, status: u16, mime: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        403 => "Forbidden",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-cache\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        status, reason, mime, body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn handle_request(stream: TcpStream) {
    let mut reader = std::io::BufReader::new(&stream);
    let mut request_line = String::new();
    if std::io::BufRead::read_line(&mut reader, &mut request_line).is_err() {
        return;
    }
    // Drain remaining headers
    loop {
        let mut line = String::new();
        match std::io::BufRead::read_line(&mut reader, &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
            }
        }
    }

    // Parse: "GET /widgets/{widget_id}/{path} HTTP/1.1"
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        respond(stream, 400, "text/plain", b"Bad request");
        return;
    }

    // Handle CORS preflight
    if parts[0] == "OPTIONS" {
        let header = "HTTP/1.1 204 No Content\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, OPTIONS\r\n\
            Access-Control-Allow-Headers: *\r\n\
            Connection: close\r\n\r\n";
        let _ = (&stream).write_all(header.as_bytes());
        return;
    }

    if parts[0] != "GET" {
        respond(stream, 400, "text/plain", b"Only GET supported");
        return;
    }

    let raw_path = parts[1];
    // URL-decode the path
    let decoded = url_decode(raw_path);
    // Strip query string
    let path = decoded.split('?').next().unwrap_or(&decoded);

    // Route: /widgets/{widget_id}/{file_path...}
    let stripped = path.strip_prefix("/widgets/").unwrap_or("");
    if stripped.is_empty() {
        respond(stream, 404, "text/plain", b"Not found");
        return;
    }

    // Split into widget_id and relative file path
    let (widget_id, rel_path) = match stripped.find('/') {
        Some(idx) => (&stripped[..idx], &stripped[idx + 1..]),
        None => (stripped, "index.html"),
    };
    let rel_path = if rel_path.is_empty() { "index.html" } else { rel_path };

    // Validate widget_id — only allow safe characters
    if widget_id.is_empty()
        || widget_id.contains("..")
        || !widget_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        respond(stream, 403, "text/plain", b"Invalid widget id");
        return;
    }

    let base = match widgets_base() {
        Some(b) => b,
        None => {
            respond(stream, 500, "text/plain", b"No home dir");
            return;
        }
    };

    let file_path = base.join(widget_id).join(rel_path);

    // Security: canonicalize and verify it's inside the widgets dir
    let canonical = match file_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            respond(stream, 404, "text/plain", b"Not found");
            return;
        }
    };
    let base_canonical = match base.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            respond(stream, 500, "text/plain", b"Base dir missing");
            return;
        }
    };
    if !canonical.starts_with(&base_canonical) {
        respond(stream, 403, "text/plain", b"Path traversal blocked");
        return;
    }

    // Read file
    match std::fs::read(&canonical) {
        Ok(body) => {
            let mime = mime_for(&canonical.to_string_lossy());
            respond(stream, 200, mime, &body);
        }
        Err(_) => {
            respond(stream, 404, "text/plain", b"Not found");
        }
    }
}

fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().unwrap_or(b'0');
            let lo = chars.next().unwrap_or(b'0');
            let hex = [hi, lo];
            if let Ok(s) = std::str::from_utf8(&hex) {
                if let Ok(val) = u8::from_str_radix(s, 16) {
                    result.push(val as char);
                    continue;
                }
            }
            result.push('%');
            result.push(hi as char);
            result.push(lo as char);
        } else {
            result.push(b as char);
        }
    }
    result
}

impl WidgetServer {
    pub fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("widget server bind: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();

        safe_eprintln!("[widget-server] Listening on 127.0.0.1:{}", port);

        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .ok();
                std::thread::spawn(move || handle_request(stream));
            }
        });

        Ok(Self {
            port: AtomicU16::new(port),
        })
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }
}
