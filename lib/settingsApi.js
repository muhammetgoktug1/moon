import { originAllowed } from "./auth.js";
import { saveMonitorNotifications, saveHostServiceNotifications } from "./notifyStore.js";

// HTTP API for notification settings (the panel forms use the socket events;
// this is the same logic reachable with curl/scripts). Session cookie required.
//
//   PATCH /api/monitors/<id>/notifications
//         body: { "whatsapp": { "enabled": false, "events": { "ssl": false } } }
//   PATCH /api/host-services/notifications
//         body: { "host": "<host name>", "service": "<service name>", "notifications": { … } }
//
// Partial bodies merge onto the stored settings. 400 = invalid body (unknown
// channel/event, non-boolean), 401 = no session, 403 = foreign Origin,
// 404 = monitor/service does not exist.

const BODY_LIMIT = 4096;
const MONITOR_PATH = /^\/api\/monitors\/([^/]+)\/notifications$/;
const HOST_SERVICE_PATH = "/api/host-services/notifications";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > BODY_LIMIT) throw new Error("body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * true = the request belongs to this API and was answered.
 * verify(req) → session | null; onChange(kind) lets the server re-broadcast.
 */
export async function settingsEndpoint(req, res, { verify, onChange } = {}) {
  const path = req.url.split("?")[0];
  const monitorMatch = path.match(MONITOR_PATH);
  const hostService = path === HOST_SERVICE_PATH;
  if (!monitorMatch && !hostService) return false;
  if (req.method !== "PATCH") {
    res.setHeader("allow", "PATCH");
    json(res, 405, { error: "Use PATCH." });
    return true;
  }
  if (!originAllowed(req.headers)) {
    json(res, 403, { error: "Origin refused." });
    return true;
  }
  const session = await verify?.(req);
  if (!session) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: "Body must be valid JSON." });
    return true;
  }

  let result;
  if (monitorMatch) {
    let id = monitorMatch[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // malformed escape: keep the raw text, it will not match any monitor
    }
    result = await saveMonitorNotifications(id, body);
  } else {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      json(res, 400, { error: "Body must be a JSON object." });
      return true;
    }
    result = await saveHostServiceNotifications(body.host, body.service, body.notifications);
  }

  if (result.error) {
    json(res, result.code, { error: result.error });
    return true;
  }
  try {
    await onChange?.(monitorMatch ? "monitor" : "hostService");
  } catch (e) {
    console.error("[settings] broadcast failed:", e?.message || e);
  }
  json(res, 200, { ok: true, notifications: result.notifications });
  return true;
}
