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
  const { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.status(500).json({
      message: "Missing Google OAuth env vars",
      required: ["GOOGLE_CLIENT_ID", "GOOGLE_REDIRECT_URI"],
      GOOGLE_CLIENT_ID_present: !!GOOGLE_CLIENT_ID,
      GOOGLE_REDIRECT_URI_present: !!GOOGLE_REDIRECT_URI,
    });
  }

  const state = req.query.state || ""; // consider signing a CSRF token for production
  const params = {
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    include_granted_scopes: "true",
    access_type: "offline",   // remove if you don't need a refresh token
    prompt: "consent",         // helpful in dev; you can drop in production
    state,
  };
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${q(params)}`;

  // If you append ?debug=true, show the URL instead of redirecting (helps diagnose 400s)
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
          emailVerified: profile.email_verified ?? byEmail.emailVerified,
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
        emailVerified: profile.email_verified ?? null,
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

    // If you’re in a mobile context, redirect to your app scheme:
    if (MOBILE_REDIRECT_SCHEME && state === "mobile") {
      return res.redirect(`${MOBILE_REDIRECT_SCHEME}://oauth-complete#token=${encodeURIComponent(token)}`);
    }

    // Fallback: return JSON (useful for testing in Insomnia)
    return res.status(200).json({ token, user });
  } catch (err) {
    console.error("Google OAuth error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;