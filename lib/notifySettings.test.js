import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultNotifications,
  normalizeNotifications,
  parseNotifications,
  shouldNotify,
  wantsEvent,
  eventKey,
  muteState,
} from "./notifySettings.js";

// Notification settings model (pure): defaults, lenient read of stored data,
// strict API parsing, per-channel/per-event decisions, list-icon summary.

test("defaults: every registered channel and event of the scope is on", () => {
  assert.deepEqual(defaultNotifications("monitor"), { whatsapp: { enabled: true, events: { down: true, recovery: true, ssl: true } } });
  assert.deepEqual(defaultNotifications("hostService"), { whatsapp: { enabled: true, events: { down: true, recovery: true } } });
});

test("stored data without the field (old records) reads as everything on", () => {
  assert.deepEqual(normalizeNotifications(undefined, "monitor"), defaultNotifications("monitor"));
  assert.deepEqual(normalizeNotifications(null, "monitor"), defaultNotifications("monitor"));
  assert.deepEqual(normalizeNotifications({}, "monitor"), defaultNotifications("monitor"));
  assert.equal(shouldNotify(undefined, "whatsapp", "down"), true);
  assert.equal(shouldNotify({}, "whatsapp", "ssl"), true);
});

test("lenient read fails open: only a literal false turns something off", () => {
  const odd = normalizeNotifications({ whatsapp: { enabled: "no", events: { down: 0, ssl: false } } }, "monitor");
  assert.equal(odd.whatsapp.enabled, true, "non-boolean enabled stays on");
  assert.equal(odd.whatsapp.events.down, true, "non-boolean event stays on");
  assert.equal(odd.whatsapp.events.ssl, false);
  assert.deepEqual(normalizeNotifications("garbage", "monitor"), defaultNotifications("monitor"));
});

test("shouldNotify: channel off mutes all events; event off mutes only that event", () => {
  const channelOff = { whatsapp: { enabled: false } };
  for (const e of ["down", "recovery", "ssl"]) assert.equal(shouldNotify(channelOff, "whatsapp", e), false);
  const sslOff = { whatsapp: { enabled: true, events: { ssl: false } } };
  assert.equal(shouldNotify(sslOff, "whatsapp", "ssl"), false);
  assert.equal(shouldNotify(sslOff, "whatsapp", "down"), true);
  assert.equal(shouldNotify(sslOff, "whatsapp", "recovery"), true);
});

test("eventKey: checker 'up' is the 'recovery' setting", () => {
  assert.equal(eventKey("up"), "recovery");
  assert.equal(eventKey("down"), "down");
  assert.equal(eventKey("ssl"), "ssl");
});

test("wantsEvent: true while any channel still wants the event", () => {
  assert.equal(wantsEvent(undefined, "ssl"), true);
  assert.equal(wantsEvent({ whatsapp: { events: { ssl: false } } }, "ssl"), false);
  assert.equal(wantsEvent({ whatsapp: { enabled: false } }, "ssl"), false);
});

test("parse: valid partial input merges onto the base", () => {
  const base = { whatsapp: { enabled: true, events: { down: true, recovery: true, ssl: false } } };
  const r = parseNotifications({ whatsapp: { events: { recovery: false } } }, "monitor", base);
  assert.deepEqual(r.value, { whatsapp: { enabled: true, events: { down: true, recovery: false, ssl: false } } });
  const r2 = parseNotifications({ whatsapp: { enabled: false } }, "monitor");
  assert.equal(r2.value.whatsapp.enabled, false);
  assert.equal(r2.value.whatsapp.events.down, true, "events untouched");
  assert.deepEqual(parseNotifications({}, "monitor").value, defaultNotifications("monitor"));
});

test("parse: unknown channel, unknown event, unknown key, non-boolean → error", () => {
  const bad = [
    [{ telegram: { enabled: true } }, /Unknown notification channel: telegram/],
    [{ whatsapp: { enabled: "yes" } }, /enabled must be true or false/],
    [{ whatsapp: { enabled: 1 } }, /enabled must be true or false/],
    [{ whatsapp: { events: { sms: true } } }, /Unknown notification event: sms/],
    [{ whatsapp: { events: { down: "false" } } }, /events\.down must be true or false/],
    [{ whatsapp: { events: [] } }, /events must be an object/],
    [{ whatsapp: { volume: 11 } }, /Unknown setting: notifications\.whatsapp\.volume/],
    [{ whatsapp: true }, /notifications\.whatsapp must be an object/],
    [[], /must be an object/],
    ["on", /must be an object/],
    [null, /must be an object/],
    [JSON.parse('{"__proto__": {"enabled": false}}'), /Unknown notification channel/],
    [{ constructor: {} }, /Unknown notification channel/],
  ];
  for (const [input, message] of bad) {
    const r = parseNotifications(input, "monitor");
    assert.match(r.error || "", message, JSON.stringify(input));
    assert.equal(r.value, undefined);
  }
});

test("parse: events are scoped — a host service has no SSL event", () => {
  const r = parseNotifications({ whatsapp: { events: { ssl: false } } }, "hostService");
  assert.match(r.error, /Unknown notification event: ssl/);
  assert.equal(parseNotifications({ whatsapp: { events: { down: false } } }, "hostService").value.whatsapp.events.down, false);
  assert.match(parseNotifications({}, "nonsense").error, /Unknown settings scope/);
});

test("long unknown keys are truncated in the error message", () => {
  const r = parseNotifications({ ["x".repeat(500)]: {} }, "monitor");
  assert.ok(r.error.length < 120);
});

test("muteState: on / partial / off", () => {
  assert.equal(muteState(undefined, "monitor"), "on");
  assert.equal(muteState({ whatsapp: { events: { ssl: false } } }, "monitor"), "partial");
  assert.equal(muteState({ whatsapp: { enabled: false } }, "monitor"), "off");
  assert.equal(muteState({ whatsapp: { events: { down: false, recovery: false, ssl: false } } }, "monitor"), "off", "all events off = nothing is sent");
  assert.equal(muteState({ whatsapp: { events: { down: false, recovery: false } } }, "hostService"), "off");
});
