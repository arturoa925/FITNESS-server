// controllers/auth.js
const router = require("express").Router();
const jwt = require("jsonwebtoken");
const { Users } = require("../models");

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  CLIENT_WEB_URL,
  MOBILE_REDIRECT_SCHEME,
  JWT_SECRET
} = process.env;

// Helper to build query
const q = (obj) =>
  Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

// 1) Kick off Google OAuth
router.get("/google", (req, res) => {
  // Trim envs to avoid invisible whitespace mismatches
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const redirectUri = (process.env.GOOGLE_REDIRECT_URI || "").trim();

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      message: "Missing Google OAuth env vars",
      required: ["GOOGLE_CLIENT_ID", "GOOGLE_REDIRECT_URI"],
      GOOGLE_CLIENT_ID_present: !!clientId,
      GOOGLE_REDIRECT_URI_present: !!redirectUri,
    });
  }

  const rawState = String(req.query.state || "");
  const incomingRedirect = String(req.query.redirect_uri || "").trim();
  // Encode redirect into state so we can recover it in the callback
  const state = incomingRedirect
    ? `${rawState}${rawState ? "|" : ""}redir=${encodeURIComponent(incomingRedirect)}`
    : rawState;

  // Support a minimal param set for debugging 400s
  const minimal = String(req.query.mode || "").toLowerCase() === "minimal";
  // Always force account picker; keep consent during dev
  const base = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account consent",
  };
  const extras = minimal
    ? {}
    : {
        include_granted_scopes: "true",
        access_type: "offline", // remove if not needed
      };

  const params = { ...base, ...extras };
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${q(params)}`;

  // ?debug=true returns the full URL + params instead of redirecting
  if (String(req.query.debug).toLowerCase() === "true") {
    return res.status(200).json({ authorize_url: url, params });
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[OAuth] Redirecting to:", url);
  }
  res.redirect(url);
});

// 2) Callback: exchange code -> tokens -> profile, then issue YOUR JWT
router.get("/google/callback", async (req, res) => {
  try {
    if (req.query.error) {
      // Example: error=redirect_uri_mismatch or access_denied
      return res.status(400).json({
        message: "Google returned an error",
        error: req.query.error,
        error_description: req.query.error_description,
      });
    }

    const { code, state } = req.query;
    if (!code) return res.status(400).json({ message: "Missing authorization code" });

    // Recover redirect_uri passed in the initial /auth/google call, if any
    let recoveredRedirect = null;
    if (state && typeof state === "string" && state.includes("redir=")) {
      try {
        // state may look like: "mobile|redir=exp%3A%2F%2F192.168.1.68%3A8081"
        const match = state.split("|").find((s) => s.startsWith("redir="));
        if (match) {
          recoveredRedirect = decodeURIComponent(match.slice("redir=".length));
        }
      } catch (_) {
        recoveredRedirect = null;
      }
    }

    // 2a) Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: q({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return res.status(401).json({ message: "Token exchange failed", detail: tokens });
    }

    // 2b) Fetch OpenID userinfo (email, email_verified, picture, given_name, family_name, sub)
    const userinfoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await userinfoRes.json(); // { sub, email, email_verified, picture, given_name, family_name, name }

    const provider = "google";
    const providerId = String(profile.sub);
    const email = profile.email || null;

    // 2c) Find-or-create local user
    let user = await Users.findOne({ where: { provider, providerId } });

    // Optional: merge/link by email if an account already exists
    if (!user && email) {
      const byEmail = await Users.findOne({ where: { email } });
      if (byEmail) {
        // Link the existing local account to Google
        await byEmail.update({
          provider, providerId,
          isVerified: (profile.email_verified ?? byEmail.isVerified),
          profilePicture: profile.picture || byEmail.profilePicture
        });
        user = byEmail;
      }
    }

    if (!user) {
      user = await Users.create({
        id: require("uuid").v4(),
        provider,
        providerId,
        email,
        isVerified: (profile.email_verified ?? null),
        firstName: profile.given_name || profile.name || "Google",
        lastName: profile.family_name || "",
        profilePicture: profile.picture || null,
        password: null // IMPORTANT: no password for social accounts
      });
    }

    // 2d) Issue YOUR JWT
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "1h" });

    // 2e) Where to send the user now?
    // If you’re in a browser (web), redirect to your app with the token:
    if (CLIENT_WEB_URL && !state?.includes("mobile")) {
      return res.redirect(`${CLIENT_WEB_URL}/oauth-complete#token=${encodeURIComponent(token)}`);
    }

    // Prefer dynamic redirect captured from the initial call (Expo Go proxy or exp:// host)
    if (recoveredRedirect) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[OAuth] Redirecting back to mobile:", recoveredRedirect);
      }
      const fragment = q({
        token,
        email: user.email || "",
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        photo: user.profilePicture || "",
      });
      return res.redirect(`${recoveredRedirect}#${fragment}`);
    }
    // Legacy fallback: custom scheme via env for dev/standalone builds
    if (MOBILE_REDIRECT_SCHEME && (state === "mobile" || String(state || "").includes("mobile"))) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[OAuth] Redirecting back to mobile:", `${MOBILE_REDIRECT_SCHEME}://oauth-complete`);
      }
      const fragment = q({
        token,
        email: user.email || "",
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        photo: user.profilePicture || "",
      });
      return res.redirect(`${MOBILE_REDIRECT_SCHEME}://oauth-complete#${fragment}`);
    }

    // Fallback: return JSON (useful for testing in Insomnia)
    return res.status(200).json({ token, user });
  } catch (err) {
    console.error("Google OAuth error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;