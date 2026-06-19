import { ACTIVITY_LABEL, type PaneActivity } from "../../types/activity";

interface StatusBadgeProps {
  activity: PaneActivity;
  label?: string;
}

const BADGE_CLASS: Record<PaneActivity, string> = {
  starting: "status-badge--starting",
  idle: "status-badge--idle",
  working: "status-badge--working",
  waiting_input: "status-badge--waiting",
  error: "status-badge--error",
  exited: "status-badge--exited",
};

export function StatusBadge({ activity, label }: StatusBadgeProps) {
  return (
    <span className={`status-badge ${BADGE_CLASS[activity]}`}>
      {label ?? ACTIVITY_LABEL[activity]}
    </span>
  );
}
