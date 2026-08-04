use tauri::command;
use base64::{Engine as _, engine::general_purpose};
use std::fs;
use std::process::Command;

#[command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    
    // 25 MB limit
    if metadata.len() > 25 * 1024 * 1024 {
        return Err("File is too large (exceeds 25 MB limit)".to_string());
    }

    let contents = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(contents))
}

#[command]
pub fn write_temp_file(name: String, data: Vec<u8>) -> Result<String, String> {
    let mut temp_path = std::env::temp_dir();
    temp_path.push(name);
    
    fs::write(&temp_path, data).map_err(|e| e.to_string())?;
    
    Ok(temp_path.to_string_lossy().to_string())
}

#[command]
pub fn open_file_with_default(path: String) -> Result<(), String> {
    Command::new("cmd")
        .args(["/c", "start", "\"\"", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
        
    Ok(())
}
