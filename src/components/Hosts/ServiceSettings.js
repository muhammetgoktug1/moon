"use client";

import { useId, useRef, useState } from "react";

// Components
import NotificationFields from "@/components/NotificationFields";
import BellOff from "@/components/BellOff";

// Utils
import { getSocket } from "@/utils/socket";

// Styles
import Styles from "./styles.module.scss";
import DialogStyles from "@/styles/dialog.module.scss";

const MUTE_TITLE = {
  agent: "Notifications off (host-agent setting)",
  off: "Notifications off",
  partial: "Some notifications off",
};

// One service of a host: the chip opens a small dialog with the notification
// settings. Services come from the host-agent config, so the settings live in the
// panel's own per-(host, service) record; a service muted in the host-agent
// config stays silent whatever the switches say (shown as such).
const ServiceSettings = ({ host, service }) => {
  const dialog = useRef();
  const titleId = useId();
  const [value, setValue] = useState(service.notifications);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const open = () => {
    setValue(service.notifications);
    setError("");
    dialog.current.showModal();
  };

  const submit = (e) => {
    e.preventDefault();
    setBusy(true);
    getSocket().emit("hostService:notifications", { host, service: service.name, notifications: value }, (res) => {
      setBusy(false);
      setError(res?.error || "");
      if (res?.error) return;
      dialog.current.close();
    });
  };

  const muted = service.mute !== "on";

  return (
    <>
      <button type="button" className={Styles.service} data-tone={service.status} data-mute={service.mute} onClick={open} aria-label={`${service.name}: notification settings`} title={muted ? MUTE_TITLE[service.mute] : "Notification settings"}>
        <i className="lamp" data-tone={service.status} />
        <span className={Styles.serviceName}>{service.name}</span>
        {muted && (
          <span className={Styles.serviceMute} aria-hidden="true">
            <BellOff size={14} />
          </span>
        )}
      </button>

      <dialog ref={dialog} className={DialogStyles.dialog} aria-labelledby={titleId} onClick={(e) => e.target === dialog.current && dialog.current.close()}>
        <form className={DialogStyles.sheet} onSubmit={submit}>
          <header className={DialogStyles.head}>
            <div>
              <h2 id={titleId}>Notifications</h2>
              <p>
                {service.name} · {host}
              </p>
            </div>
            <button type="button" className={DialogStyles.close} onClick={() => dialog.current.close()} aria-label="Close">
              ×
            </button>
          </header>

          {service.agentMuted && (
            <p className={Styles.agentNote} role="note">
              <BellOff size={14} /> Off via host-agent setting. This service stays silent until that setting is removed from the host-agent config — the switches below apply after that.
            </p>
          )}

          <NotificationFields scope="hostService" value={value} onChange={setValue} />

          <footer className={DialogStyles.foot}>
            {error ? <p className={DialogStyles.error}>{error}</p> : <p>Muting only stops the messages — the service stays monitored and visible here.</p>}
            <button type="button" className={DialogStyles.cancel} onClick={() => dialog.current.close()}>
              Cancel
            </button>
            <button className={DialogStyles.submit} disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
};

export default ServiceSettings;
