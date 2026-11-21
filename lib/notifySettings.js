// Per-channel notification settings, shared by the server and the browser bundle
// (no imports here — keep it browser-safe).
//
// Shape (stored on a monitor, or on a host service in the hostServiceSettings
// collection):
//   notifications: { <channel>: { enabled: Boolean, events: { <event>: Boolean } } }
//
// Rules:
//   • Anything that is not literally `false` counts as ON — records written
//     before this feature existed (no field at all) keep notifying, and a new
//     channel/event added later starts ON for every old record. No migration.
//   • A channel with `enabled: false` mutes every event on that channel.
//   • Muting only silences the message: checks, status and history are untouched.
//
// Adding a channel (e.g. e-mail): add one entry to CHANNELS, register a sender
// for it (see lib/notify.js `channel`), and the schema, the strict API
// validation and the Notifications section of the forms pick it up from here.

export const CHANNELS = {
  whatsapp: { label: "WhatsApp" },
};

export const EVENTS = {
  down: { label: "Down" },
  recovery: { label: "Recovered" },
  ssl: { label: "SSL expiry" },
};

// which events each kind of item can notify about
export const SCOPE_EVENTS = {
  monitor: ["down", "recovery", "ssl"],
  hostService: ["down", "recovery"],
};

export const channelKeys = () => Object.keys(CHANNELS);

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const shown = (key) => String(key).slice(0, 40);

/** Checker event kind → notification event key ("up" is stored as "recovery"). */
export const eventKey = (kind) => (kind === "up" ? "recovery" : kind);

/** Everything on, for every registered channel and every event of the scope. */
export function defaultNotifications(scope = "monitor") {
  const events = SCOPE_EVENTS[scope] || [];
  return Object.fromEntries(
    channelKeys().map((channel) => [channel, { enabled: true, events: Object.fromEntries(events.map((e) => [e, true])) }]),
  );
}

/**
 * Lenient read of stored/raw data → complete settings object. Only a literal
 * `false` turns something off; missing or odd values stay ON (fail open: a
 * damaged record must never silently drop alerts).
 */
export function normalizeNotifications(raw, scope = "monitor") {
  const out = defaultNotifications(scope);
  if (!isPlain(raw)) return out;
  for (const channel of channelKeys()) {
    const stored = raw[channel];
    if (!isPlain(stored)) continue;
    if (stored.enabled === false) out[channel].enabled = false;
    for (const event of SCOPE_EVENTS[scope] || []) {
      if (isPlain(stored.events) && stored.events[event] === false) out[channel].events[event] = false;
    }
  }
  return out;
}

/**
 * Strict parse of API input, merged onto `base` (current stored settings, or
 * defaults). Only known channels/events with boolean values are accepted;
 * everything else is an error.  Returns { value } | { error }.
 */
export function parseNotifications(input, scope = "monitor", base) {
  if (!isPlain(input)) return { error: "notifications must be an object." };
  const allowed = SCOPE_EVENTS[scope];
  if (!allowed) return { error: "Unknown settings scope." };
  const value = normalizeNotifications(base, scope);

  for (const [channel, setting] of Object.entries(input)) {
    if (!Object.hasOwn(CHANNELS, channel)) return { error: `Unknown notification channel: ${shown(channel)}.` };
    if (!isPlain(setting)) return { error: `notifications.${channel} must be an object.` };
    for (const [key, v] of Object.entries(setting)) {
      if (key === "enabled") {
        if (typeof v !== "boolean") return { error: `notifications.${channel}.enabled must be true or false.` };
        value[channel].enabled = v;
      } else if (key === "events") {
        if (!isPlain(v)) return { error: `notifications.${channel}.events must be an object.` };
        for (const [event, flag] of Object.entries(v)) {
          if (!allowed.includes(event)) return { error: `Unknown notification event: ${shown(event)}.` };
          if (typeof flag !== "boolean") return { error: `notifications.${channel}.events.${event} must be true or false.` };
          value[channel].events[event] = flag;
        }
      } else {
        return { error: `Unknown setting: notifications.${channel}.${shown(key)}.` };
      }
    }
  }
  return { value };
}

export const channelEnabled = (notifications, channel) => notifications?.[channel]?.enabled !== false;

/** Should `channel` carry this event ("down" | "recovery" | "ssl") for an item with these settings? */
export const shouldNotify = (notifications, channel, event) =>
  channelEnabled(notifications, channel) && notifications?.[channel]?.events?.[event] !== false;

/** Does ANY registered channel still want this event? (e.g. skip the daily SSL lock when none does.) */
export const wantsEvent = (notifications, event) => channelKeys().some((channel) => shouldNotify(notifications, channel, event));

/**
 * Summary for list icons: "on" (everything on), "partial" (something muted),
 * "off" (no channel would send anything).
 */
export function muteState(notifications, scope = "monitor") {
  const n = normalizeNotifications(notifications, scope);
  let active = 0;
  let muted = 0;
  for (const channel of channelKeys()) {
    const events = Object.values(n[channel].events);
    const on = n[channel].enabled && events.some(Boolean);
    if (on) active++;
    if (!n[channel].enabled || events.some((e) => !e)) muted++;
  }
  if (!active) return "off";
  return muted ? "partial" : "on";
}
