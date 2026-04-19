use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

pub struct BrowserManager {
    active: Mutex<HashSet<String>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashSet::new()),
        }
    }

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

        let app_clone = app.clone();
        let id_clone = id.clone();

        let builder = tauri::webview::WebviewBuilder::new(&id, WebviewUrl::External(parsed))
            .on_navigation(move |nav_url| {
                let _ =
                    app_clone.emit(&format!("browser-navigated-{}", id_clone), nav_url.as_str());
                true
            });

        // Access the underlying Window via WebviewWindow -> AsRef<Webview> -> .window()
        let webview_ref: &tauri::Webview = main_ww.as_ref();
        let window = webview_ref.window();

        window
            .add_child(
                builder,
                tauri::LogicalPosition::new(x, y),
                tauri::LogicalSize::new(w, h),
            )
            .map_err(|e| format!("Failed to create browser: {e}"))?;

        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        Ok(())
    }

    pub fn navigate(&self, app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
        wv.navigate(parsed).map_err(|e| format!("{e}"))
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
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        let _ = wv.set_position(tauri::LogicalPosition::new(x, y));
        let _ = wv.set_size(tauri::LogicalSize::new(w, h));
        Ok(())
    }

    pub fn set_visible(&self, app: &AppHandle, id: &str, visible: bool) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        if visible {
            wv.show().map_err(|e| format!("{e}"))?;
        } else {
            wv.hide().map_err(|e| format!("{e}"))?;
        }
        Ok(())
    }

    pub fn close(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        if let Some(wv) = app.get_webview(id) {
            let _ = wv.close();
        }
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        Ok(())
    }

    pub fn set_zoom(&self, app: &AppHandle, id: &str, zoom: f64) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        wv.set_zoom(zoom).map_err(|e| format!("{e}"))
    }

    pub fn eval_js(&self, app: &AppHandle, id: &str, js: &str) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        wv.eval(js).map_err(|e| format!("{e}"))
    }

    pub fn go_back(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        wv.eval("history.back()").map_err(|e| format!("{e}"))
    }

    pub fn go_forward(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        wv.eval("history.forward()").map_err(|e| format!("{e}"))
    }

    pub fn reload(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let wv = app.get_webview(id).ok_or("Browser not found")?;
        wv.eval("location.reload()").map_err(|e| format!("{e}"))
    }

    pub fn set_all_visible(&self, app: &AppHandle, visible: bool) {
        let ids: Vec<String> = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.set_visible(app, &id, visible);
        }
    }
}
