import {
  initAuth,
  signInWithGoogle,
  sendMagicLink,
  signOutUser,
  getToken,
  completeMagicLink,
} from "./firebase.js";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const googleButton = document.getElementById("google-signin-button");
const magicLinkEmail = document.getElementById("magic-link-email");
const magicLinkButton = document.getElementById("magic-link-button");
const magicLinkStatus = document.getElementById("magic-link-status");
const userEmail = document.getElementById("user-email");
const signOutButton = document.getElementById("sign-out-button");

function showLogin() {
  loginView.hidden = false;
  appView.hidden = true;
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}

// Attaches the current user's Firebase ID token as a Bearer token, parses the
// JSON error envelope ({ error: string }) on failure, and flips to the login
// view on 401 (the session is no longer valid).
export async function api(path, opts = {}) {
  const token = await getToken();
  const headers = new Headers(opts.headers || {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(path, { ...opts, headers });

  if (response.status === 401) {
    showLogin();
  }

  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // response body was not JSON; fall back to the generic message
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function wireLoginActions() {
  googleButton?.addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error("google sign in failed", err);
    }
  });

  magicLinkButton?.addEventListener("click", async () => {
    const email = magicLinkEmail?.value.trim();
    if (!email) return;
    try {
      await sendMagicLink(email);
      if (magicLinkStatus) {
        magicLinkStatus.hidden = false;
        magicLinkStatus.textContent = "Check your inbox. The link signs you in on this device.";
      }
    } catch (err) {
      console.error("failed to send sign in link", err);
    }
  });

  signOutButton?.addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (err) {
      console.error("sign out failed", err);
    }
  });
}

async function boot() {
  wireLoginActions();

  try {
    await completeMagicLink();
  } catch (err) {
    console.error("failed to complete magic link sign in", err);
  }

  initAuth((user) => {
    if (user) {
      if (userEmail) {
        userEmail.textContent = user.email || "";
      }
      showApp();
    } else {
      showLogin();
    }
  });
}

boot();
