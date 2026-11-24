const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// Strict YYYY-MM-DD that is also a real calendar date (rejects 2025-02-31).
const isDateStr = (v) => {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// Only http(s) URLs are accepted for user-supplied image links.
const isHttpUrl = (v) => {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

const todayStr = () => new Date().toISOString().split("T")[0];

// Reject oversized JSON blobs stored in JSONB columns.
const jsonSize = (v) => {
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    return Infinity;
  }
};

module.exports = { isUuid, isDateStr, isHttpUrl, todayStr, jsonSize };
