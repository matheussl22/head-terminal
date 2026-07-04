import { useEffect, useRef, useState } from "react";

import { VOICE_SHORTCUT } from "../../config/toolbar";
import { useSessionStore } from "../../core/session-manager";
import { isVoiceInputBlocked, toggleVoiceInput } from "../../core/voice-input";
import { stopAndTranscribeVoice } from "../../core/voice-bridge";
import { IconMic } from "../ui/Icons";

type VoiceButtonState = "idle" | "error";

interface VoiceInputButtonProps {
  paneId: string;
}

export function VoiceInputButton({ paneId }: VoiceInputButtonProps) {
  const recordingPaneId = useSessionStore((state) => state.voiceRecordingPaneId);
  const transcribingPaneId = useSessionStore(
    (state) => state.voiceTranscribingPaneId,
  );
  const setVoiceRecordingPaneId = useSessionStore(
    (state) => state.setVoiceRecordingPaneId,
  );

  const [localState, setLocalState] = useState<VoiceButtonState>("idle");
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isRecording = recordingPaneId === paneId;
  const isTranscribing = transcribingPaneId === paneId;
  const disabled = isVoiceInputBlocked(paneId);

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
      if (useSessionStore.getState().voiceRecordingPaneId === paneId) {
        setVoiceRecordingPaneId(null);
        // Result discarded on unmount — pass "" so the backend skips the
        // OpenAI call and just stops/cleans up the recording.
        void stopAndTranscribeVoice("").catch(() => undefined);
      }
    };
  }, [paneId, setVoiceRecordingPaneId]);

  const showError = () => {
    setLocalState("error");
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }
    errorTimeoutRef.current = setTimeout(() => {
      setLocalState("idle");
    }, 2000);
  };

  const handleClick = async (event: React.MouseEvent) => {
    event.stopPropagation();

    if (disabled) {
      return;
    }

    await toggleVoiceInput(paneId, { onError: showError });
  };

  const stateClass =
    localState === "error"
      ? "terminal-pane-header__mic--error"
      : isTranscribing
        ? "terminal-pane-header__mic--transcribing"
        : isRecording
          ? "terminal-pane-header__mic--recording"
          : "";

  const title = isRecording
    ? `Parar gravação e transcrever (${VOICE_SHORTCUT})`
    : `Gravar prompt por voz (${VOICE_SHORTCUT})`;

  return (
    <button
      type="button"
      className={`terminal-pane-header__mic ${stateClass} ${disabled ? "terminal-pane-header__mic--disabled" : ""}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={handleClick}
    >
      <IconMic />
    </button>
  );
}
