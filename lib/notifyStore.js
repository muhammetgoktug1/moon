import mongoose from "mongoose";
import { Monitor, HostReport, HostServiceSetting } from "./models.js";
import { normalizeNotifications, parseNotifications } from "./notifySettings.js";

// Reading and writing notification settings. Shared by the socket handlers
// (panel forms) and the HTTP endpoints (lib/settingsApi.js) so both validate
// the same way. Results: { notifications } on success, { code, error } on failure.

const key = (host, service) => `${host}\u0000${service}`;

/** service name → raw notifications for ONE host (used by the alert path). */
export async function hostServiceSettings(hostName) {
  const rows = await HostServiceSetting.find({ host: hostName }).lean();
  return new Map(rows.map((r) => [r.service, r.notifications]));
}

/** "host\0service" → raw notifications for every host (used by the panel wire). */
export async function allHostServiceSettings() {
  const rows = await HostServiceSetting.find().lean();
  return new Map(rows.map((r) => [key(r.host, r.service), r.notifications]));
}

export const hostServiceKey = key;

export async function saveMonitorNotifications(id, input) {
  if (!mongoose.isValidObjectId(id)) return { code: 404, error: "This monitor no longer exists." };
  const monitor = await Monitor.findById(id).lean();
  if (!monitor) return { code: 404, error: "This monitor no longer exists." };
  const parsed = parseNotifications(input, "monitor", monitor.notifications);
  if (parsed.error) return { code: 400, error: parsed.error };
  await Monitor.updateOne({ _id: monitor._id }, { $set: { notifications: parsed.value } });
  return { notifications: parsed.value };
}

const label = (v) => (typeof v === "string" ? v.trim() : "");

export async function saveHostServiceNotifications(host, service, input) {
  const hostName = label(host);
  const serviceName = label(service);
  if (!hostName || !serviceName || hostName.length > 60 || serviceName.length > 60) {
    return { code: 400, error: "host and service names are required." };
  }
  // the services come from the host reports: only a service the host actually reports can be edited
  const report = await HostReport.findOne({ "host.name": hostName }).lean();
  if (!report || !(report.services || []).some((s) => s.name === serviceName)) {
    return { code: 404, error: "This service no longer exists." };
  }
  const existing = await HostServiceSetting.findOne({ host: hostName, service: serviceName }).lean();
  const parsed = parseNotifications(input, "hostService", existing?.notifications);
  if (parsed.error) return { code: 400, error: parsed.error };
  await HostServiceSetting.updateOne(
    { host: hostName, service: serviceName },
    { $set: { notifications: parsed.value } },
    { upsert: true },
  );
  return { notifications: parsed.value };
}

/** What the panel shows for one monitor: complete settings, defaults filled. */
export const monitorNotificationsWire = (m) => normalizeNotifications(m?.notifications, "monitor");
