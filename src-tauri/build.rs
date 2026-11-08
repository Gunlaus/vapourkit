use std::fs;
use std::path::Path;

fn main() {
    // Temporary build-time icon for the experimental host. Replace with
    // branded Tauri icon assets before enabling production bundling.
    let icons = Path::new("icons");
    fs::create_dir_all(icons).expect("create Tauri icon directory");
    let icon = icons.join("icon.png");
    if !icon.exists() {
        // A valid 1x1 RGBA PNG; the production Electron icon is unchanged.
        let png: &[u8] = &[
            137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
            8,6,0,0,0,31,21,196,137,0,0,0,11,73,68,65,84,120,156,99,248,
            207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,
            174,66,96,130,
        ];
        fs::write(&icon, png).expect("write temporary Tauri icon");
    }
    tauri_build::build();
}
