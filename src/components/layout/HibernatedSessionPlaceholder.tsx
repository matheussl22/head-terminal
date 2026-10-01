import { wakeSession } from "../../actions/hibernateSession";
import { useSessionStore } from "../../core/session-manager";
import { msg } from "../../i18n";
import { useLocale } from "../../i18n/react";
import { IconHibernate } from "../ui/Icons";

/**
 * What the canvas shows for the session on screen while its terminals are
 * asleep — it was hibernated from its menu or from a phone. Picking another
 * session and coming back wakes it too.
 */
export function HibernatedSessionPlaceholder({ sessionId }: { sessionId: string }) {
  useLocale();
  const hibernated = useSessionStore((state) => Boolean(state.hibernatedSessions[sessionId]));
  if (!hibernated) {
    return null;
  }
  return (
    <section className="hibernated-session" aria-live="polite">
      <div className="hibernated-session__card">
        <IconHibernate className="hibernated-session__icon" size={22} />
        <h2>{msg.app.hibernate.placeholderTitle}</h2>
        <p>{msg.app.hibernate.placeholderBody}</p>
        <button
          type="button"
          className="settings-primary-button"
          autoFocus
          onClick={() => wakeSession(sessionId)}
        >
          {msg.app.hibernate.resume}
        </button>
      </div>
    </section>
  );
}
