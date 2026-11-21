import mongoose from "mongoose";
import { parseNotifications } from "./notifySettings.js";

// Validation of the monitor add/edit payload (socket events in server.js).

function parseUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {}
  return undefined;
}

function parseRequest({ method, headers, body }) {
  const verb = method === "POST" ? "POST" : "GET";
  const pairs = (Array.isArray(headers) ? headers : [])
    .map((h) => ({ key: String(h?.key || "").trim(), value: String(h?.value || "").trim() }))
    .filter((h) => h.key);
  try {
    new Headers(pairs.map((h) => [h.key, h.value]));
  } catch {
    return { error: "One of the headers is not valid." };
  }
  const text = verb === "POST" ? String(body || "").trim() : "";
  if (!text) return { method: verb, headers: pairs, body: "" };
  try {
    JSON.parse(text);
  } catch {
    return { error: "Request body must be valid JSON." };
  }
  return { method: verb, headers: pairs, body: text };
}

// notifications is optional: left out, the stored settings stay as they are (an older
// client editing a monitor must not reset them); given, it is validated strictly.
export function parseMonitor({ name, group, url, notifications, ...request }, storedNotifications) {
  const parsed = parseUrl(url);
  if (!parsed) return { error: "Enter a valid http(s) URL." };
  const req = parseRequest(request);
  if (req.error) return req;
  const fields = {
    name: String(name || "").trim().slice(0, 60) || parsed.host,
    group: mongoose.isValidObjectId(group) ? group : null,
    url: parsed.href,
    ...req,
  };
  if (notifications !== undefined) {
    const parsedNotifications = parseNotifications(notifications, "monitor", storedNotifications);
    if (parsedNotifications.error) return { error: parsedNotifications.error };
    fields.notifications = parsedNotifications.value;
  }
  return fields;
}
