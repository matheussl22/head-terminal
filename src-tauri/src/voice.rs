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

const OPENAI_TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIBE_TIMEOUT_SECS: u64 = 60;

#[derive(serde::Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
}

#[derive(serde::Deserialize)]
struct OpenAiErrorBody {
    error: OpenAiErrorDetail,
}

#[derive(serde::Deserialize)]
struct OpenAiErrorDetail {
    message: String,
}

#[tauri::command]
pub async fn stop_and_transcribe_voice(
    state: tauri::State<'_, Mutex<VoiceRecordingState>>,
    api_key: String,
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
        // guard (and child) drop here, before any .await below.
    };

    if !wav_path.exists() {
        return Err("Arquivo de áudio não foi gerado.".to_string());
    }

    if api_key.trim().is_empty() {
        let _ = std::fs::remove_file(&wav_path);
        return Err("Configure sua chave da OpenAI nas Configurações.".to_string());
    }

    let result = transcribe_with_openai(&wav_path, &api_key).await;
    let _ = std::fs::remove_file(&wav_path);

    result
}

async fn transcribe_with_openai(
    wav_path: &std::path::Path,
    api_key: &str,
) -> Result<String, String> {
    let bytes =
        std::fs::read(wav_path).map_err(|_| "Não foi possível ler o arquivo de áudio.".to_string())?;

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|_| "Falha ao preparar o áudio para envio.".to_string())?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "gpt-4o-transcribe")
        .text("language", "pt");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OPENAI_TRANSCRIBE_TIMEOUT_SECS))
        .build()
        .map_err(|_| "Falha ao inicializar o cliente HTTP.".to_string())?;

    let response = client
        .post(OPENAI_TRANSCRIPTION_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "A transcrição demorou demais e foi cancelada.".to_string()
            } else if error.is_connect() {
                "Não foi possível conectar à OpenAI. Verifique sua conexão.".to_string()
            } else {
                "Falha de rede ao contatar a OpenAI.".to_string()
            }
        })?;

    let status = response.status();

    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<OpenAiErrorBody>(&body_text)
            .map(|parsed| parsed.error.message)
            .unwrap_or_else(|_| format!("Erro HTTP {status}"));
        return Err(format!("Falha na transcrição: {detail}"));
    }

    let parsed = response
        .json::<OpenAiTranscriptionResponse>()
        .await
        .map_err(|_| "Não foi possível interpretar a resposta da OpenAI.".to_string())?;

    Ok(parsed.text.trim().to_string())
}
