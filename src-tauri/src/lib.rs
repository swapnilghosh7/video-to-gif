use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, process::Command, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager, State};

struct JobState {
    cancelled: AtomicBool,
    cache: Mutex<Option<PathBuf>>,
}

impl Drop for JobState {
    fn drop(&mut self) {
        if let Ok(cache) = self.cache.get_mut() {
            if let Some(path) = cache.take() { let _ = fs::remove_dir_all(path); }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Video {
    path: String,
    name: String,
    duration: f64,
    width: u32,
    height: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    fps: u32,
    width: u32,
    height: u32,
    colors: u32,
    start: f64,
    duration: f64,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    aspect: String,
    limit_mb: f64,
    mode: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultRow {
    path: String,
    name: String,
    size_bytes: u64,
    within_limit: bool,
    effective_fps: u32,
    effective_width: u32,
    effective_height: u32,
    effective_colors: u32,
    temp_path: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    completed: usize,
    total: usize,
    current: String,
}

fn tool(app: &tauri::AppHandle, name: &str) -> PathBuf {
    let executable = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    if cfg!(debug_assertions) {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools").join(&executable);
        if development.exists() { return development; }
    }
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("tools").join(&executable);
        if bundled.exists() { return bundled; }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let bundled = parent.join(&executable);
            if bundled.exists() { return bundled; }
        }
    }
    PathBuf::from(name)
}

fn probe(app: &tauri::AppHandle, path: &Path) -> Result<Video, String> {
    let output = Command::new(tool(app, "ffprobe"))
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height", "-of", "json"])
        .arg(path).output().map_err(|e| format!("ffprobe unavailable: {e}"))?;
    if !output.status.success() { return Err(format!("Cannot read {}", path.display())); }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let stream = data["streams"].get(0).ok_or("No video stream")?;
    let duration = data["format"]["duration"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    Ok(Video {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        duration,
        width: stream["width"].as_u64().unwrap_or(0) as u32,
        height: stream["height"].as_u64().unwrap_or(0) as u32,
    })
}

#[tauri::command]
async fn scan(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<Video>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_inner(app, paths))
        .await.map_err(|e| e.to_string())?
}

fn scan_inner(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<Video>, String> {
    let mut files = Vec::new();
    for selected in paths {
        let path = PathBuf::from(selected);
        if path.is_dir() {
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let candidate = entry.map_err(|e| e.to_string())?.path();
                if candidate.extension().is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case("mp4")) { files.push(candidate); }
            }
        } else if path.extension().is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case("mp4")) { files.push(path); }
    }
    files.sort();
    files.dedup();
    if files.is_empty() { return Err("No MP4 files found.".into()); }
    files.into_iter().map(|p| probe(&app, &p)).collect()
}

fn filter(settings: &Settings, fps: u32, width: u32, height: u32, colors: u32) -> Result<String, String> {
    if settings.fps == 0 || settings.width == 0 || settings.height == 0 || settings.colors < 2 || settings.colors > 256 {
        return Err("FPS, dimensions, or colors are invalid.".into());
    }
    let mut chain = String::new();
    if settings.crop_width > 0 && settings.crop_height > 0 {
        chain.push_str(&format!("crop={}:{}:{}:{},", settings.crop_width, settings.crop_height, settings.crop_x, settings.crop_y));
    }
    if settings.aspect != "source" {
        let (a, b) = match settings.aspect.as_str() { "1:1" => (1, 1), "4:3" => (4, 3), "16:9" => (16, 9), "9:16" => (9, 16), _ => return Err("Unsupported aspect ratio".into()) };
        chain.push_str(&format!("crop='min(iw,ih*{a}/{b})':'min(ih,iw*{b}/{a})',"));
    }
    chain.push_str(&format!("fps={fps},scale={width}:{height}:flags=lanczos:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,split[a][b];[a]palettegen=max_colors={colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"));
    Ok(chain)
}

fn encode(app: &tauri::AppHandle, input: &Path, output: &Path, settings: &Settings, fps: u32, width: u32, height: u32, colors: u32) -> Result<u64, String> {
    let mut cmd = Command::new(tool(app, "ffmpeg"));
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    if settings.start > 0.0 { cmd.args(["-ss", &settings.start.to_string()]); }
    cmd.arg("-i").arg(input);
    if settings.duration > 0.0 { cmd.args(["-t", &settings.duration.to_string()]); }
    cmd.arg("-filter_complex").arg(filter(settings, fps, width, height, colors)?)
        .args(["-an", "-loop", "0"]).arg(output);
    let result = cmd.output().map_err(|e| format!("ffmpeg unavailable: {e}"))?;
    if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).trim().to_string()); }
    Ok(fs::metadata(output).map_err(|e| e.to_string())?.len())
}

#[tauri::command]
fn cancel(state: State<'_, Arc<JobState>>) { state.cancelled.store(true, Ordering::Relaxed); }

#[tauri::command]
async fn evaluate(app: tauri::AppHandle, state: State<'_, Arc<JobState>>, videos: Vec<Video>, settings: Settings) -> Result<Vec<ResultRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || evaluate_inner(app, state, videos, settings))
        .await.map_err(|e| e.to_string())?
}

fn evaluate_inner(app: tauri::AppHandle, state: Arc<JobState>, videos: Vec<Video>, settings: Settings) -> Result<Vec<ResultRow>, String> {
    if !(0.1..=10000.0).contains(&settings.limit_mb) { return Err("Set a valid size limit.".into()); }
    state.cancelled.store(false, Ordering::Relaxed);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let dir = std::env::temp_dir().join(format!("video-gif-studio-{stamp}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = cache.replace(dir.clone()) { let _ = fs::remove_dir_all(previous); }
    drop(cache);
    let mut rows = Vec::new();
    let limit = (settings.limit_mb * 1_000_000.0) as u64;
    for (index, video) in videos.iter().enumerate() {
        if state.cancelled.load(Ordering::Relaxed) { break; }
        let _ = app.emit("job-progress", Progress { phase: "evaluating".into(), completed: index, total: videos.len(), current: video.name.clone() });
        let mut fps = settings.fps;
        let mut width = settings.width;
        let mut height = settings.height;
        let mut colors = settings.colors;
        let mut output = dir.join(format!("{index}.gif"));
        let mut attempt = encode(&app, Path::new(&video.path), &output, &settings, fps, width, height, colors);
        if settings.mode == "adjust" {
            for _ in 0..12 {
                if !matches!(&attempt, Ok(bytes) if *bytes > limit) || state.cancelled.load(Ordering::Relaxed) { break; }
                if colors > 64 { colors = (colors * 3 / 4).max(64); }
                else if width > 160 && height > 120 { width = (width * 9 / 10).max(160); height = (height * 9 / 10).max(120); }
                else if fps > 4 { fps -= 1; }
                else { break; }
                output = dir.join(format!("{index}-{}-{}-{}-{}.gif", fps, width, height, colors));
                attempt = encode(&app, Path::new(&video.path), &output, &settings, fps, width, height, colors);
            }
        }
        let (size_bytes, error) = match attempt { Ok(size) => (size, None), Err(e) => (0, Some(e)) };
        rows.push(ResultRow { path: video.path.clone(), name: video.name.clone(), size_bytes, within_limit: error.is_none() && size_bytes <= limit, effective_fps: fps, effective_width: width, effective_height: height, effective_colors: colors, temp_path: output.to_string_lossy().into_owned(), error });
        let _ = app.emit("job-progress", Progress { phase: "evaluating".into(), completed: index + 1, total: videos.len(), current: video.name.clone() });
    }
    Ok(rows)
}

#[tauri::command]
async fn export(app: tauri::AppHandle, state: State<'_, Arc<JobState>>, rows: Vec<ResultRow>, output_dir: String, skip_oversize: bool) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export_inner(app, state, rows, output_dir, skip_oversize))
        .await.map_err(|e| e.to_string())?
}

fn export_inner(app: tauri::AppHandle, state: Arc<JobState>, rows: Vec<ResultRow>, output_dir: String, skip_oversize: bool) -> Result<usize, String> {
    state.cancelled.store(false, Ordering::Relaxed);
    let dir = PathBuf::from(output_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let selected: Vec<_> = rows.iter().filter(|row| row.error.is_none() && (!skip_oversize || row.within_limit)).collect();
    let mut saved = 0;
    for (index, row) in selected.iter().enumerate() {
        if state.cancelled.load(Ordering::Relaxed) { break; }
        let _ = app.emit("job-progress", Progress { phase: "saving".into(), completed: index, total: selected.len(), current: row.name.clone() });
        let stem = Path::new(&row.name).file_stem().unwrap_or_default().to_string_lossy();
        let mut destination = dir.join(format!("{stem}.gif"));
        let mut suffix = 2;
        while destination.exists() { destination = dir.join(format!("{stem}-{suffix}.gif")); suffix += 1; }
        fs::copy(&row.temp_path, destination).map_err(|e| e.to_string())?;
        saved += 1;
        let _ = app.emit("job-progress", Progress { phase: "saving".into(), completed: index + 1, total: selected.len(), current: row.name.clone() });
    }
    Ok(saved)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(JobState { cancelled: AtomicBool::new(false), cache: Mutex::new(None) }))
        .invoke_handler(tauri::generate_handler![scan, evaluate, export, cancel])
        .run(tauri::generate_context!())
        .expect("error running Video GIF Studio");
}
