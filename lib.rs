use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[cfg(not(target_os = "macos"))]
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

static MEDIA_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct AppPaths {
    data_dir: PathBuf,
    notes_dir: PathBuf,
    media_dir: PathBuf,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    data_dir: String,
    notes_dir: String,
    media_dir: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    html: String,
    created: u64,
    updated: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NoteMeta {
    id: String,
    title: String,
    created: u64,
    updated: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(not(target_os = "macos"))]
fn is_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn resolve_paths(app: &AppHandle) -> AppPaths {
    // macOS app bundles are read-only or replaced on update, so always use the
    // per-user application data directory there. An env override is still
    // honoured for testing.
    #[cfg(target_os = "macos")]
    let data_dir = std::env::var_os("MEDIA_NOTEPAD_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let base = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("media-notepad"));
            let dir = base.join("data");
            let _ = fs::create_dir_all(&dir);
            dir
        });

    // Preferred location on Windows/Linux: a `data` folder right next to the
    // executable, so the notes travel with the application folder (portable
    // style). Falls back to the per-user data directory when read-only.
    #[cfg(not(target_os = "macos"))]
    let data_dir = std::env::var_os("MEDIA_NOTEPAD_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|p| p.join("data")))
        })
        .filter(|dir| is_writable(dir))
        .unwrap_or_else(|| {
            // Fallback when the app folder is read-only (e.g. installed for all users).
            let base = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("media-notepad"));
            let dir = base.join("data");
            let _ = fs::create_dir_all(&dir);
            dir
        });

    let notes_dir = data_dir.join("notes");
    let media_dir = data_dir.join("media");
    let _ = fs::create_dir_all(&notes_dir);
    let _ = fs::create_dir_all(&media_dir);

    AppPaths {
        data_dir,
        notes_dir,
        media_dir,
    }
}

fn sanitize_id(id: &str) -> Result<String, String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id.to_string())
    } else {
        Err("Invalid note id".to_string())
    }
}

fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned
    }
}

fn note_path(paths: &AppPaths, id: &str) -> PathBuf {
    paths.notes_dir.join(format!("{id}.json"))
}

/// Collects the media file names referenced by a note's HTML.
fn referenced_media(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let needle = "data-media=\"";
    let mut rest = html;
    while let Some(pos) = rest.find(needle) {
        rest = &rest[pos + needle.len()..];
        if let Some(end) = rest.find('"') {
            let name = &rest[..end];
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            {
                out.push(name.to_string());
            }
            rest = &rest[end..];
        } else {
            break;
        }
    }
    out
}

#[tauri::command]
fn get_info(paths: State<AppPaths>) -> AppInfo {
    AppInfo {
        data_dir: paths.data_dir.to_string_lossy().to_string(),
        notes_dir: paths.notes_dir.to_string_lossy().to_string(),
        media_dir: paths.media_dir.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn list_notes(paths: State<AppPaths>) -> Result<Vec<NoteMeta>, String> {
    let entries = fs::read_dir(&paths.notes_dir).map_err(|e| e.to_string())?;
    let mut notes: Vec<NoteMeta> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(note) = serde_json::from_str::<Note>(&raw) {
                notes.push(NoteMeta {
                    id: note.id,
                    title: note.title,
                    created: note.created,
                    updated: note.updated,
                });
            }
        }
    }
    notes.sort_by(|a, b| {
        a.created
            .cmp(&b.created)
            .then_with(|| a.updated.cmp(&b.updated))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(notes)
}

fn order_path(paths: &AppPaths) -> PathBuf {
    paths.data_dir.join("order.json")
}

#[tauri::command]
fn load_order(paths: State<AppPaths>) -> Vec<String> {
    fs::read_to_string(order_path(&paths))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_order(ids: Vec<String>, paths: State<AppPaths>) -> Result<(), String> {
    let mut clean = Vec::with_capacity(ids.len());
    for id in ids {
        clean.push(sanitize_id(&id)?);
    }
    let raw = serde_json::to_vec(&clean).map_err(|e| e.to_string())?;
    fs::write(order_path(&paths), raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_note(id: String, paths: State<AppPaths>) -> Result<Note, String> {
    let id = sanitize_id(&id)?;
    let raw = fs::read_to_string(note_path(&paths, &id)).map_err(|e| e.to_string())?;
    serde_json::from_str::<Note>(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_note(
    id: String,
    title: String,
    html: String,
    created: u64,
    paths: State<AppPaths>,
) -> Result<NoteMeta, String> {
    let id = sanitize_id(&id)?;
    let now = now_ms();
    let note = Note {
        id: id.clone(),
        title,
        html,
        created: if created == 0 { now } else { created },
        updated: now,
    };
    let raw = serde_json::to_vec(&note).map_err(|e| e.to_string())?;
    fs::write(note_path(&paths, &id), raw).map_err(|e| e.to_string())?;
    Ok(NoteMeta {
        id: note.id,
        title: note.title,
        created: note.created,
        updated: note.updated,
    })
}

#[tauri::command]
fn delete_note(id: String, paths: State<AppPaths>) -> Result<(), String> {
    let id = sanitize_id(&id)?;
    let path = note_path(&paths, &id);

    // Remove media that only this note referenced.
    let media = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Note>(&raw).ok())
        .map(|note| referenced_media(&note.html))
        .unwrap_or_default();

    fs::remove_file(&path).map_err(|e| e.to_string())?;

    // Keep the saved tab order free of deleted ids.
    let order_file = order_path(&paths);
    if let Ok(raw) = fs::read_to_string(&order_file) {
        if let Ok(mut ids) = serde_json::from_str::<Vec<String>>(&raw) {
            ids.retain(|item| item != &id);
            if let Ok(clean) = serde_json::to_vec(&ids) {
                let _ = fs::write(&order_file, clean);
            }
        }
    }

    for name in media {
        let target = paths.media_dir.join(&name);
        if target.starts_with(&paths.media_dir) {
            let _ = fs::remove_file(target);
        }
    }
    Ok(())
}

#[tauri::command]
fn save_media(request: Request<'_>, paths: State<AppPaths>) -> Result<String, String> {
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("bin");
    let ext = sanitize_ext(ext);

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("Expected binary media payload".to_string()),
    };
    if bytes.is_empty() {
        return Err("Empty media payload".to_string());
    }

    let seq = MEDIA_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!("{}-{}.{}", now_ms(), seq, ext);
    let path = paths.media_dir.join(&name);
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    Ok(clipboard.get_text().unwrap_or_default())
}

/// Reads an image from the clipboard and stores it as a PNG in the media folder.
/// Returns the generated file name, or `None` when the clipboard has no image.
#[tauri::command]
fn paste_clipboard_image(paths: State<AppPaths>) -> Result<Option<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };

    let width = image.width as u32;
    let height = image.height as u32;
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&image.bytes)
            .map_err(|e| e.to_string())?;
    }

    let seq = MEDIA_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!("{}-{}.png", now_ms(), seq);
    fs::write(paths.media_dir.join(&name), &png_bytes).map_err(|e| e.to_string())?;
    Ok(Some(name))
}

#[tauri::command]
fn open_data_folder(paths: State<AppPaths>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(&paths.data_dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = resolve_paths(&app.handle());
            app.asset_protocol_scope()
                .allow_directory(&paths.media_dir, false)?;
            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_info,
            list_notes,
            load_note,
            save_note,
            delete_note,
            load_order,
            save_order,
            save_media,
            read_clipboard_text,
            paste_clipboard_image,
            open_data_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Media Notepad");
}
