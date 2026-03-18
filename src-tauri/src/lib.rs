mod pty_manager;
mod types;

use pty_manager::PtyManager;
use types::*;

struct AppState {
    pty_manager: PtyManager,
}

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateTerminalRequest,
) -> Result<(), String> {
    state.pty_manager.create(&app_handle, req)
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.write(&id, &data)
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&id, cols, rows)
}

#[tauri::command]
fn close_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.pty_manager.close(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            pty_manager: PtyManager::new(),
        })
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
