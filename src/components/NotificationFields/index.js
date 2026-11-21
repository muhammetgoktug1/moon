"use client";

import { CHANNELS, EVENTS, SCOPE_EVENTS, channelKeys } from "@/lib/notifySettings";

// Styles
import Styles from "./styles.module.scss";

// The Notifications section of the monitor form and of the host service dialog.
// One block per registered channel (lib/notifySettings CHANNELS — a new channel
// shows up here without touching this file): a switch for the channel, then one
// option per event the item can notify about. `value` is the complete settings
// object; `onChange` gets a new one. Muting never stops the checks themselves.
const NotificationFields = ({ scope, value, onChange }) => {
  const events = SCOPE_EVENTS[scope] || [];
  const patch = (channel, next) => onChange({ ...value, [channel]: { ...value[channel], ...next } });

  return (
    <div className={Styles.root} role="group" aria-label="Notifications">
      <span className={Styles.title}>Notifications</span>
      {channelKeys().map((channel) => {
        const setting = value?.[channel] || { enabled: true, events: {} };
        const on = setting.enabled !== false;
        return (
          <div key={channel} className={Styles.channel} data-on={on}>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              className={Styles.switch}
              onClick={() => patch(channel, { enabled: !on })}
            >
              <span>
                <strong>{CHANNELS[channel].label}</strong>
                <small>{on ? "Messages are sent for the events below" : "Muted — checks and history keep running"}</small>
              </span>
              <span className={Styles.track} aria-hidden="true">
                <i />
              </span>
            </button>
            <div className={Styles.events} role="group" aria-label={`${CHANNELS[channel].label} events`}>
              {events.map((event) => {
                const checked = setting.events?.[event] !== false;
                return (
                  <button
                    key={event}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    disabled={!on}
                    className={Styles.option}
                    onClick={() => patch(channel, { events: { ...setting.events, [event]: !checked } })}
                  >
                    <span className={Styles.box} aria-hidden="true">
                      ✓
                    </span>
                    {EVENTS[event].label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default NotificationFields;
