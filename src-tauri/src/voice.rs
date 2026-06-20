use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub struct VoiceRecordingState {
    child: Option<Child>,
    wav_path: Option<std::path::PathBuf>,
}

impl VoiceRecordingState {
    pub fn new() -> Self {
        Self {
            child: None,
            wav_path: None,
        }
    }
}

#[tauri::command]
pub fn start_voice_recording(
    state: tauri::State<'_, Mutex<VoiceRecordingState>>,
) -> Result<(), String> {
    let mut guard = state
        .lock()
        .map_err(|_| "Falha ao acessar estado de gravação".to_string())?;

    if guard.child.is_some() {
        return Err("Já existe uma gravação em andamento.".to_string());
    }

    let path = std::env::temp_dir().join(format!(
        "head-terminal-voice-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    ));

    let child = Command::new("parecord")
        .args([
            "--file-format=wav",
            "--rate=16000",
            "--channels=1",
            path.to_str().ok_or("Caminho de áudio inválido")?,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar a gravação: {error}"))?;

    guard.child = Some(child);
    guard.wav_path = Some(path);

    Ok(())
}

#[tauri::command]
pub fn stop_and_transcribe_voice(
    state: tauri::State<'_, Mutex<VoiceRecordingState>>,
) -> Result<String, String> {
    let wav_path = {
        let mut guard = state
            .lock()
            .map_err(|_| "Falha ao acessar estado de gravação".to_string())?;

        let mut child = guard
            .child
            .take()
            .ok_or_else(|| "Nenhuma gravação em andamento.".to_string())?;
        let wav_path = guard
            .wav_path
            .take()
            .ok_or_else(|| "Caminho do áudio ausente.".to_string())?;

        // SIGTERM (not Child::kill(), which sends SIGKILL) so parecord has a
        // chance to flush and finalize the WAV header before exiting.
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        let _ = child.wait();

        wav_path
    };

    if !wav_path.exists() {
        return Err("Arquivo de áudio não foi gerado.".to_string());
    }

    let out_dir = std::env::temp_dir();
    let transcribe_result = Command::new("whisper")
        .args([
            wav_path.to_str().ok_or("Caminho de áudio inválido")?,
            "--model",
            "base",
            "--language",
            "pt",
            "--output_format",
            "txt",
            "--output_dir",
            out_dir.to_str().ok_or("Diretório de saída inválido")?,
            "--fp16",
            "False",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let _ = std::fs::remove_file(&wav_path);

    let status = transcribe_result.map_err(|error| {
        format!("Não foi possível executar o whisper: {error}")
    })?;

    if !status.success() {
        return Err("Falha na transcrição.".to_string());
    }

    let txt_path = out_dir
        .join(wav_path.file_stem().ok_or("Nome de arquivo inválido")?)
        .with_extension("txt");

    let text = std::fs::read_to_string(&txt_path)
        .map_err(|_| "Não foi possível ler a transcrição.".to_string())?;
    let _ = std::fs::remove_file(&txt_path);

    Ok(text.trim().to_string())
}
