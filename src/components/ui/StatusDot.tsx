import { ACTIVITY_LABEL, type PaneActivity } from "../../types/activity";

interface StatusDotProps {
  activity: PaneActivity;
  pulse?: boolean;
  className?: string;
}

const ACTIVITY_COLOR: Record<PaneActivity, string> = {
  starting: "var(--status-starting)",
  idle: "var(--status-idle)",
  working: "var(--status-working)",
  waiting_input: "var(--status-waiting)",
  error: "var(--status-error)",
  exited: "var(--status-exited)",
};

export function StatusDot({
  activity,
  pulse = false,
  className = "",
}: StatusDotProps) {
  const shouldPulse = pulse || activity === "working";

  return (
    <span
      className={`status-dot ${shouldPulse ? "status-dot--pulse" : ""} ${className}`.trim()}
      style={{ backgroundColor: ACTIVITY_COLOR[activity] }}
      title={ACTIVITY_LABEL[activity]}
      aria-hidden
    />
  );
}
