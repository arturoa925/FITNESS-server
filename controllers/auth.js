// controllers/auth.js
const router = require("express").Router();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const { Users } = require("../models");

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_REDIRECT_URI,
  CLIENT_WEB_URL,
  MOBILE_REDIRECT_SCHEME,
  JWT_SECRET,
} = process.env;

const IS_PROD = process.env.NODE_ENV === "production";
const FETCH_TIMEOUT_MS = 10000;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});
router.use(authLimiter);

// Helper to build query
const q = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

// ---------------------------------------------------------------------------
// Redirect allowlist (prevents the OAuth flow being used as an open redirect
// that hands the user's JWT to an attacker-controlled URL).
//
// Always allowed: the app's own scheme (arturofit://) and MOBILE_REDIRECT_SCHEME.
// Allowed outside production only: exp:// / exp+*:// (Expo Go dev URLs).
// Anything else must be listed in OAUTH_ALLOWED_REDIRECTS (comma-separated
// URL prefixes, e.g. "https://app.example.com/oauth-complete").
// ---------------------------------------------------------------------------
const APP_SCHEMES = new Set(
  ["arturofit", (MOBILE_REDIRECT_SCHEME || "").trim().toLowerCase()].filter(Boolean)
);
const EXTRA_REDIRECT_PREFIXES = (process.env.OAUTH_ALLOWED_REDIRECTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedRedirect(uri) {
  if (typeof uri !== "string" || !uri || uri.length > 2048) return false;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (APP_SCHEMES.has(scheme)) return true;
  if (!IS_PROD && (scheme === "exp" || scheme.startsWith("exp+"))) return true;
  return EXTRA_REDIRECT_PREFIXES.some((p) => uri === p || uri.startsWith(p));
}

// ---------------------------------------------------------------------------
// Signed OAuth `state`: tamper-proof, expires in 10 minutes, and carries the
// validated redirect so the callback never trusts raw query data.
// `purpose` + no `id` claim means it can never be used as an access token.
// ---------------------------------------------------------------------------
function signState({ mobile, redir }) {
  return jwt.sign(
    { purpose: "oauth_state", nonce: crypto.randomBytes(12).toString("hex"), mobile, redir },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: "10m" }
  );
}
function verifyState(state) {
  try {
    const d = jwt.verify(String(state || ""), JWT_SECRET, { algorithms: ["HS256"] });
    return d && d.purpose === "oauth_state" ? d : null;
  } catch {
    return null;
  }
}

// Builds the signed state for /auth/<provider>; returns { error } if the
// requested redirect is not allowed.
function buildState(query) {
  const rawState = String(query.state || "");
  const requestedRedirect = String(query.redirect_uri || "").trim();
  if (requestedRedirect && !isAllowedRedirect(requestedRedirect)) {
    return { error: "redirect_uri is not allowed" };
  }
  const mobile = rawState.includes("mobile") || !!requestedRedirect;
  return {
    state: signState({ mobile, redir: requestedRedirect || null }),
  };
}

const safeUser = (user) => {
  const out = user.toJSON ? user.toJSON() : { ...user };
  delete out.password;
  return out;
};

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

// Find-or-create the local user for a verified provider identity.
// SECURITY: an existing account is only linked when the provider asserts the
// email is verified; otherwise anyone could claim someone else's address.
async function resolveSocialUser({
  provider,
  providerId,
  email,
  emailVerified,
  firstName,
  lastName,
  picture,
}) {
  let user = await Users.findOne({ where: { provider, providerId } });
  if (user) return user;

  const normalizedEmail =
    typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  if (!normalizedEmail) {
    throw new AuthError(400, "Your account has no email address we can use");
  }
  if (!emailVerified) {
    throw new AuthError(403, "Your email address is not verified with the provider");
  }

  const byEmail = await Users.findOne({ where: { email: normalizedEmail } });
  if (byEmail) {
    await byEmail.update({
      provider,
      providerId,
      isVerified: true,
      profilePicture: picture || byEmail.profilePicture,
    });
    return byEmail;
  }

  return Users.create({
    id: uuidv4(),
    provider,
    providerId,
    email: normalizedEmail,
    isVerified: true,
    firstName: firstName || (provider === "google" ? "Google" : "GitHub"),
    lastName: lastName || "",
    profilePicture: picture || undefined,
    password: null, // social accounts have no local password
  });
}

// Issue our JWT and send the browser/app back to the right place.
function finish(res, stateData, user, provider) {
  const token = jwt.sign({ id: user.id }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
  const fragment = q({
    token,
    email: user.email || "",
    name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    photo: user.profilePicture || "",
    userId: user.id,
    providerId: user.providerId || "",
    provider,
  });

  if (stateData.mobile) {
    // stateData.redir was validated against the allowlist when /auth/<provider> was called.
    if (stateData.redir && isAllowedRedirect(stateData.redir)) {
      return res.redirect(`${stateData.redir}#${fragment}`);
    }
    if (MOBILE_REDIRECT_SCHEME) {
      return res.redirect(`${MOBILE_REDIRECT_SCHEME}://oauth-complete#${fragment}`);
    }
  } else if (CLIENT_WEB_URL) {
    return res.redirect(`${CLIENT_WEB_URL}/oauth-complete#${fragment}`);
  }

  // JSON fallback is for local testing (Insomnia etc.) only.
  if (!IS_PROD) {
    return res.status(200).json({ token, user: safeUser(user) });
  }
  return res.status(400).json({ message: "No redirect target configured" });
}

function handleError(res, label, err) {
  if (err instanceof AuthError) {
    return res.status(err.status).json({ message: err.message });
  }
  console.error(`${label} OAuth error:`, err && err.message ? err.message : err);
  return res.status(500).json({ message: "Internal server error" });
}

// ------------------------------- GitHub -----------------------------------
router.get("/github", (req, res) => {
  const clientId = (GITHUB_CLIENT_ID || "").trim();
  const redirectUri = (GITHUB_REDIRECT_URI || "").trim();
  if (!clientId || !redirectUri) {
    console.error("GitHub OAuth is missing GITHUB_CLIENT_ID / GITHUB_REDIRECT_URI");
    return res.status(500).json({ message: "GitHub sign-in is not configured" });
  }

  const built = buildState(req.query);
  if (built.error) return res.status(400).json({ message: built.error });

  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    // user:email is always requested: without it private emails are unreadable
    // and sign-in cannot succeed (accounts require an email).
    scope: "read:user user:email",
    state: built.state,
    allow_signup: "true",
  };
  const url = `https://github.com/login/oauth/authorize?${q(params)}`;

  if (!IS_PROD && String(req.query.debug).toLowerCase() === "true") {
    return res.status(200).json({ authorize_url: url, params });
  }
  return res.redirect(url);
});

router.get("/github/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res
        .status(400)
        .json({ message: "GitHub returned an error", error: String(req.query.error).slice(0, 100) });
    }
    const { code } = req.query;
    const stateData = verifyState(req.query.state);
    if (!stateData) return res.status(400).json({ message: "Invalid or expired state" });
    if (!code || typeof code !== "string") {
      return res.status(400).json({ message: "Missing authorization code" });
    }

    const tokenRes = await fetchJson("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: q({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
      }),
    });
    const accessToken = tokenRes.body && tokenRes.body.access_token;
    if (!accessToken) {
      return res.status(401).json({ message: "GitHub token exchange failed" });
    }

    const ghHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "fitness-app",
      Accept: "application/vnd.github+json",
    };
    const userRes = await fetchJson("https://api.github.com/user", { headers: ghHeaders });
    const ghUser = userRes.body;
    if (!userRes.ok || !ghUser || !ghUser.id) {
      return res.status(401).json({ message: "Could not read GitHub profile" });
    }

    // Only a VERIFIED email may be used (prefer the primary one).
    const emailsRes = await fetchJson("https://api.github.com/user/emails", {
      headers: ghHeaders,
    });
    const emails = Array.isArray(emailsRes.body) ? emailsRes.body : [];
    const verified = emails.filter((e) => e && e.verified && e.email);
    const chosen = verified.find((e) => e.primary) || verified[0] || null;

    let firstName = "GitHub";
    let lastName = "";
    if (typeof ghUser.name === "string" && ghUser.name.trim()) {
      const parts = ghUser.name.trim().split(/\s+/);
      firstName = parts[0];
      lastName = parts.slice(1).join(" ");
    }

    const user = await resolveSocialUser({
      provider: "github",
      providerId: String(ghUser.id),
      email: chosen && chosen.email,
      emailVerified: !!chosen,
      firstName,
      lastName,
      picture: ghUser.avatar_url || null,
    });

    return finish(res, stateData, user, "github");
  } catch (err) {
    return handleError(res, "GitHub", err);
  }
});

// ------------------------------- Google -----------------------------------
router.get("/google", (req, res) => {
  const clientId = (GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = (GOOGLE_REDIRECT_URI || "").trim();
  if (!clientId || !redirectUri) {
    console.error("Google OAuth is missing GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI");
    return res.status(500).json({ message: "Google sign-in is not configured" });
  }

  const built = buildState(req.query);
  if (built.error) return res.status(400).json({ message: built.error });

  const minimal = String(req.query.mode || "").toLowerCase() === "minimal";
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: built.state,
    prompt: "select_account consent",
    ...(minimal ? {} : { include_granted_scopes: "true", access_type: "offline" }),
  };
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${q(params)}`;

  if (!IS_PROD && String(req.query.debug).toLowerCase() === "true") {
    return res.status(200).json({ authorize_url: url, params });
  }
  return res.redirect(url);
});

router.get("/google/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res
        .status(400)
        .json({ message: "Google returned an error", error: String(req.query.error).slice(0, 100) });
    }
    const { code } = req.query;
    const stateData = verifyState(req.query.state);
    if (!stateData) return res.status(400).json({ message: "Invalid or expired state" });
    if (!code || typeof code !== "string") {
      return res.status(400).json({ message: "Missing authorization code" });
    }

    const tokenRes = await fetchJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: q({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const accessToken = tokenRes.body && tokenRes.body.access_token;
    if (!accessToken) {
      return res.status(401).json({ message: "Token exchange failed" });
    }

    const infoRes = await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = infoRes.body;
    if (!infoRes.ok || !profile || !profile.sub) {
      return res.status(401).json({ message: "Could not read Google profile" });
    }

    const user = await resolveSocialUser({
      provider: "google",
      providerId: String(profile.sub),
      email: profile.email,
      emailVerified: profile.email_verified === true,
      firstName: profile.given_name || profile.name,
      lastName: profile.family_name,
      picture: profile.picture || null,
    });

    return finish(res, stateData, user, "google");
  } catch (err) {
    return handleError(res, "Google", err);
  }
});

module.exports = router;
