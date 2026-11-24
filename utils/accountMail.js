// The actual emails we send. Failures are logged, never thrown into request handlers
// (and never reveal whether an address has an account).
const { sendMail } = require("./mailer");
const { issueCode } = require("./codes");

const APP = "Fitness";

async function sendResetCode(user) {
  try {
    const code = await issueCode(user.id, "reset");
    if (!code) return false; // rate limited
    await sendMail({
      to: user.email,
      subject: `${APP}: your password reset code`,
      text: `Your ${APP} password reset code is ${code}.\n\nIt expires in 15 minutes. If you didn't ask for this, you can ignore this email; your password hasn't changed.`,
    });
    return true;
  } catch (e) {
    console.error("sendResetCode failed:", e.message);
    return false;
  }
}

async function sendVerificationCode(user) {
  try {
    const code = await issueCode(user.id, "verify");
    if (!code) return false;
    await sendMail({
      to: user.email,
      subject: `${APP}: verify your email`,
      text: `Your ${APP} email verification code is ${code}.\n\nIt expires in 15 minutes.`,
    });
    return true;
  } catch (e) {
    console.error("sendVerificationCode failed:", e.message);
    return false;
  }
}

module.exports = { sendResetCode, sendVerificationCode };
