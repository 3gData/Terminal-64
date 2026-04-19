import { useVoiceStore } from "../../stores/voiceStore";

export default function VoiceStatusBadge() {
  const enabled = useVoiceStore((s) => s.enabled);
  const state = useVoiceStore((s) => s.state);
  const error = useVoiceStore((s) => s.error);
  const partial = useVoiceStore((s) => s.partial);
  const toggleEnabled = useVoiceStore((s) => s.toggleEnabled);

  const disabled = !enabled;
  const cls = `cc-voice-badge cc-voice-badge--icon cc-voice-badge--${disabled ? "off" : state}${error ? " cc-voice-badge--error" : ""}`;

  let title: string;
  if (error) title = `Voice error: ${error}`;
  else if (disabled) title = "Voice control is off — click to enable (Ctrl+Shift+V)";
  else if (state === "listening") title = "Listening for 'Jarvis'";
  else if (state === "dictating") title = partial ? `Dictating: ${partial}` : "Dictating…";
  else title = "Voice idle";

  return (
    <button
      type="button"
      className={cls}
      onClick={() => toggleEnabled()}
      title={title}
      aria-label={title}
    >
      <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="4.5" y="1" width="3" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill={disabled ? "none" : "currentColor"} fillOpacity={disabled ? 0 : 0.15}/>
        <path d="M2.5 6C2.5 8 4 9.5 6 9.5C8 9.5 9.5 8 9.5 6M6 9.5V11M4 11H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        {disabled && <path d="M1 1L11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>}
      </svg>
    </button>
  );
}
