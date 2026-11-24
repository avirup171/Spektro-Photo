use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tokio::sync::Semaphore;

/// Shared app state, registered with `.manage(AppState::new())` and read in
/// commands as `State<'_, AppState>` (or `app.state::<AppState>()`).
pub struct AppState {
    /// Folders the user has opened this session. Our own `thumb://` protocol and
    /// commands only touch files directly inside one of these, the same rule
    /// Tauri's asset protocol enforces with its scope.
    allowed_dirs: Mutex<HashSet<PathBuf>>,
    /// Caps concurrent thumbnail decodes so a 2,000-image folder doesn't spawn
    /// 2,000 blocking threads at once. Two cores are left free so the webview
    /// (scrolling, decoding the photo on screen) never has to fight for CPU.
    pub thumb_permits: Arc<Semaphore>,
    /// Separate permits for full-size `preview://` images (HEIC in the viewer),
    /// so the photo you opened never waits behind a queue of grid thumbnails.
    pub preview_permits: Arc<Semaphore>,
}

impl AppState {
    pub fn new() -> Self {
        let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
        Self {
            allowed_dirs: Mutex::new(HashSet::new()),
            thumb_permits: Arc::new(Semaphore::new(cpus.saturating_sub(2).max(2))),
            preview_permits: Arc::new(Semaphore::new(2)),
        }
    }

    pub fn allow_dir(&self, dir: &Path) {
        self.allowed_dirs.lock().unwrap().insert(dir.to_path_buf());
    }

    /// True if `file` sits directly inside a folder the user opened.
    pub fn is_allowed(&self, file: &Path) -> bool {
        match file.parent() {
            Some(parent) => self.allowed_dirs.lock().unwrap().contains(parent),
            None => false,
        }
    }
}
