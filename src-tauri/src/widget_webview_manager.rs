use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

pub struct WidgetWebviewManager {
    active: Mutex<HashSet<String>>,
}

impl WidgetWebviewManager {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashSet::new()),
        }
    }

    // Native webview creation needs all bounds/URL fields as flat params; grouping would
    // just relocate the Tauri IPC fan-out without making the call site clearer.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        app: &AppHandle,
        id: String,
        url: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        let main_ww = app
            .get_webview_window("main")
            .ok_or("Main window not found")?;

        let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;

        // Reusing an instance id should replace the old child webview rather
        // than leaving a stale native widget view alive behind a failed create.
        let _ = self.close(app, &id);

        let app_clone = app.clone();
        let id_clone = id.clone();
        let label = widget_webview_label(&id);

        let init_script = native_widget_bridge_init_script(&id);
        let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
            .initialization_script(init_script)
            .on_navigation(move |nav_url| {
                let _ = app_clone.emit(
                    &format!("widget-webview-navigated-{}", id_clone),
                    nav_url.as_str(),
                );
                true
            });

        let webview_ref: &tauri::Webview = main_ww.as_ref();
        let window = webview_ref.window();

        window
            .add_child(
                builder,
                tauri::LogicalPosition::new(x, y),
                tauri::LogicalSize::new(w, h),
            )
            .map_err(|e| format!("Failed to create widget webview: {e}"))?;

        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        Ok(())
    }

    pub fn set_bounds(
        &self,
        app: &AppHandle,
        id: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        let label = widget_webview_label(id);
        let wv = app.get_webview(&label).ok_or("Widget webview not found")?;
        let _ = wv.set_position(tauri::LogicalPosition::new(x, y));
        let _ = wv.set_size(tauri::LogicalSize::new(w, h));
        Ok(())
    }

    pub fn set_visible(&self, app: &AppHandle, id: &str, visible: bool) -> Result<(), String> {
        let label = widget_webview_label(id);
        let wv = app.get_webview(&label).ok_or("Widget webview not found")?;
        if visible {
            wv.show().map_err(|e| format!("{e}"))?;
        } else {
            wv.hide().map_err(|e| format!("{e}"))?;
        }
        Ok(())
    }

    pub fn close(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let label = widget_webview_label(id);
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.close();
        }
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        Ok(())
    }

    pub fn reload(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let label = widget_webview_label(id);
        let wv = app.get_webview(&label).ok_or("Widget webview not found")?;
        wv.eval("location.reload()").map_err(|e| format!("{e}"))
    }

    pub fn eval_js(&self, app: &AppHandle, id: &str, js: &str) -> Result<(), String> {
        let label = widget_webview_label(id);
        let wv = app.get_webview(&label).ok_or("Widget webview not found")?;
        wv.eval(js).map_err(|e| format!("{e}"))
    }

    pub fn set_zoom(&self, app: &AppHandle, id: &str, zoom: f64) -> Result<(), String> {
        let label = widget_webview_label(id);
        let wv = app.get_webview(&label).ok_or("Widget webview not found")?;
        wv.set_zoom(zoom).map_err(|e| format!("{e}"))
    }

    pub fn set_all_visible(&self, app: &AppHandle, visible: bool) {
        let ids: Vec<String> = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        let mut stale = Vec::new();
        for id in ids {
            if self.set_visible(app, &id, visible).is_err() {
                stale.push(id);
            }
        }
        if !stale.is_empty() {
            self.active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|id| !stale.contains(id));
        }
    }
}

fn widget_webview_label(id: &str) -> String {
    format!("widget-webview-{id}")
}

fn native_widget_bridge_init_script(instance_id: &str) -> String {
    let instance_id_json =
        serde_json::to_string(instance_id).unwrap_or_else(|_| "\"unknown\"".to_string());
    format!(
        r#"(function() {{
  if (window.__T64_NATIVE_WIDGET_BRIDGE_INSTALLED__) return;
  window.__T64_NATIVE_WIDGET_BRIDGE_INSTALLED__ = true;
  var instanceId = {instance_id_json};
  var originalPostMessage = window.postMessage.bind(window);
  var eventSource = null;
  var reconnectTimer = null;

  function widgetId() {{
    var match = String(window.location.pathname || "").match(/\/widgets\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }}

  function bridgeBase() {{
    return window.location.origin + "/widgets/" + encodeURIComponent(widgetId()) + "/bridge/" + encodeURIComponent(instanceId);
  }}

  function dispatchToWidget(message) {{
    window.dispatchEvent(new MessageEvent("message", {{
      data: message,
      origin: window.location.origin,
      source: window
    }}));
  }}

  function connectEvents() {{
    if (eventSource) {{
      try {{ eventSource.close(); }} catch (_) {{}}
      eventSource = null;
    }}
    if (!widgetId()) return;
    eventSource = new EventSource(bridgeBase() + "/events");
    eventSource.onmessage = function(event) {{
      try {{
        var frame = JSON.parse(event.data);
        if (frame && frame.event) dispatchToWidget(frame.event);
      }} catch (err) {{
        console.error("[t64-native-widget] bad event", err);
      }}
    }};
    eventSource.onerror = function() {{
      try {{ eventSource.close(); }} catch (_) {{}}
      eventSource = null;
      if (!reconnectTimer) {{
        reconnectTimer = setTimeout(function() {{
          reconnectTimer = null;
          connectEvents();
        }}, 1000);
      }}
    }};
  }}

  function sendRequest(message) {{
    var payload = message && typeof message.payload === "object" && message.payload !== null
      ? message.payload
      : {{}};
    var requestId = typeof payload.id === "string" ? payload.id : undefined;
    fetch(bridgeBase() + "/request", {{
      method: "POST",
      headers: {{ "content-type": "application/json" }},
      body: JSON.stringify({{
        requestId: requestId,
        type: message.type,
        payload: payload,
        timeoutMs: typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined
      }})
    }}).then(function(response) {{
      if (!response.ok) return response.json().catch(function() {{ return null; }}).then(function(body) {{
        dispatchToWidget({{
          type: "t64:bridge-error",
          payload: {{
            id: requestId,
            error: body && body.error && body.error.message ? body.error.message : "native bridge request failed",
            status: response.status
          }}
        }});
      }});
      return null;
    }}).catch(function(err) {{
      dispatchToWidget({{
        type: "t64:bridge-error",
        payload: {{ id: requestId, error: String(err) }}
      }});
    }});
  }}

  window.postMessage = function(message, targetOrigin, transfer) {{
    try {{
      if (message && typeof message === "object" && typeof message.type === "string" && message.type.indexOf("t64:") === 0) {{
        sendRequest(message);
        return;
      }}
    }} catch (err) {{
      console.error("[t64-native-widget] request failed", err);
    }}
    return originalPostMessage(message, targetOrigin, transfer);
  }};

  window.__T64_NATIVE_WIDGET_BRIDGE__ = {{
    transport: "native-webview",
    instanceId: instanceId,
    request: sendRequest
  }};

  connectEvents();
}})();"#
    )
}
