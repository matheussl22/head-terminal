import { useEffect, useMemo, useState } from "react";

import { formatActivityDuration } from "../../core/activity-duration";
import { logError } from "../../core/logger";
import { encodeQr, qrToSvgPath } from "../../core/qr-code";
import { msg } from "../../i18n";
import type { RemoteStatus } from "../../types/remote";

/** The QR opens the page and pairs in one go: the PIN rides in the fragment,
 * which the browser never sends anywhere. */
function pairingUrl(url: string, pin: string): string {
  return `${url}#pair=${pin}`;
}

function QrImage({ text }: { text: string }) {
  const svg = useMemo(() => {
    try {
      return qrToSvgPath(encodeQr(text, "M"));
    } catch (error) {
      logError("remote.qr_failed", error);
      return null;
    }
  }, [text]);
  if (!svg) {
    return null;
  }
  return (
    <svg
      className="remote-settings__qr"
      viewBox={svg.viewBox}
      role="img"
      aria-label={msg.settings.phoneScan}
      shapeRendering="crispEdges"
    >
      <path d={svg.d} fill="currentColor" />
    </svg>
  );
}

/** Settings › Celular: turn the phone remote on, pair, see who is paired. */
export function RemoteSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const api = window.headTerminal.remote;

  useEffect(() => {
    let cancelled = false;
    void api
      .getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error: unknown) => logError("remote.status_failed", error));
    const unsubscribe = api.onStatus(setStatus);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(clock);
    };
  }, [api]);

  const run = (action: () => Promise<RemoteStatus>) => {
    setPending(true);
    void action()
      .then(setStatus)
      .catch((error: unknown) => logError("remote.action_failed", error))
      .finally(() => setPending(false));
  };

  const copy = (url: string) => {
    void window.headTerminal.clipboard
      .writeText(url)
      .then(() => {
        setCopied(url);
        window.setTimeout(() => setCopied(null), 1_500);
      })
      .catch((error: unknown) => logError("remote.copy_failed", error));
  };

  const enabled = status?.enabled ?? false;
  const primaryUrl = status?.urls[0];

  return (
    <section className="settings-section">
      <div className="settings-section__header">
        <h3>{msg.settings.phone}</h3>
        <p>{msg.settings.phoneDescription}</p>
      </div>

      <div className="settings-card settings-card--rows">
        <label className="settings-row">
          <span>
            <strong>{msg.settings.phoneEnable}</strong>
            <small>{msg.settings.phoneEnableHint}</small>
          </span>
          <input
            type="checkbox"
            checked={enabled}
            disabled={pending || status === null}
            onChange={(event) => {
              const next = event.target.checked;
              run(() => api.setEnabled(next));
            }}
          />
        </label>
        {status?.error && (
          <div className="settings-row remote-settings__error" role="alert">
            {status.error}
          </div>
        )}
        {enabled && !status?.running && !status?.error && (
          <div className="settings-row">
            <small>{msg.settings.phoneStarting}</small>
          </div>
        )}
      </div>

      {status?.running && primaryUrl && status.pin && (
        <div className="settings-card remote-settings__pairing">
          <QrImage text={pairingUrl(primaryUrl, status.pin)} />
          <div className="remote-settings__details">
            <div>
              <strong>{msg.settings.phoneAddress}</strong>
              <small>{msg.settings.phoneAddressHint}</small>
              <ul className="remote-settings__urls">
                {status.urls.map((url) => (
                  <li key={url}>
                    <code>{url}</code>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      onClick={() => copy(url)}
                    >
                      {copied === url ? msg.settings.phoneCopied : msg.settings.phoneCopy}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>{msg.settings.phonePin}</strong>
              <small>{msg.settings.phonePinHint}</small>
              <div className="remote-settings__pin-row">
                <span className="remote-settings__pin">{status.pin}</span>
                <button
                  type="button"
                  className="settings-secondary-button"
                  disabled={pending}
                  onClick={() => run(() => api.regeneratePin())}
                >
                  {msg.settings.phoneNewPin}
                </button>
              </div>
            </div>
            <ol className="remote-settings__steps">
              {msg.settings.phoneSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <small>{msg.settings.phoneFirewall}</small>
            <small>{msg.settings.phoneVoiceHint}</small>
          </div>
        </div>
      )}

      {status && (status.running || status.devices.length > 0) && (
        <div className="settings-card settings-card--rows">
          <div className="settings-row">
            <span>
              <strong>{msg.settings.phoneDevices}</strong>
              {status.devices.length === 0 && <small>{msg.settings.phoneNoDevices}</small>}
            </span>
            {status.devices.length > 1 && (
              <button
                type="button"
                className="settings-secondary-button"
                disabled={pending}
                onClick={() => run(() => api.revokeAllDevices())}
              >
                {msg.settings.phoneRevokeAll}
              </button>
            )}
          </div>
          {status.devices.map((device) => (
            <div key={device.id} className="settings-row">
              <span>
                <strong>{device.name}</strong>
                <small>
                  {msg.settings.phoneLastSeen(
                    msg.sidebar.usage.ago(formatActivityDuration(device.lastSeenAt, now)),
                  )}
                </small>
              </span>
              <button
                type="button"
                className="settings-secondary-button"
                disabled={pending}
                onClick={() => run(() => api.revokeDevice(device.id))}
              >
                {msg.settings.phoneRevoke}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
