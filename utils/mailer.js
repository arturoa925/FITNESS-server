// Minimal, dependency-free mailer.
//
//  - RESEND_API_KEY + EMAIL_FROM set  -> sent through Resend's HTTP API (https://resend.com)
//  - MAIL_OUTBOX=<file> (non-production) -> appended as JSON lines (used by the tests)
//  - otherwise outside production    -> printed to the console
//  - otherwise (production, no key)  -> logged as an error and not sent
// Swap providers by changing only this file.
const fs = require("fs");

async function sendMail({ to, subject, text }) {
  const { RESEND_API_KEY, EMAIL_FROM, MAIL_OUTBOX, NODE_ENV } = process.env;

  if (RESEND_API_KEY && EMAIL_FROM) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
    return true;
  }

  if (NODE_ENV !== "production") {
    if (MAIL_OUTBOX) {
      fs.appendFileSync(MAIL_OUTBOX, JSON.stringify({ to, subject, text, at: new Date().toISOString() }) + "\n");
    } else {
      console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
    }
    return true;
  }

  console.error("[mail] RESEND_API_KEY/EMAIL_FROM not configured; email NOT sent");
  return false;
}

module.exports = { sendMail };
