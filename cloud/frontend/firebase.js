// Firebase Web SDK v10, loaded as ES modules straight from the gstatic CDN.
// No bundler, no npm dependency: this keeps the repo dependency free.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA5NPFQgUIqZzyuZNPvvUNFHdvLtCZ78co",
  authDomain: "thothica-ocr.firebaseapp.com",
  projectId: "thothica-ocr",
  appId: "1:642710297096:web:f66838eb3fddedc5418fbd",
};

const PENDING_EMAIL_KEY = "pendingEmail";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Subscribes to auth state; onUser is called with the Firebase user, or null
// when signed out. Returns the unsubscribe function.
export function initAuth(onUser) {
  return onAuthStateChanged(auth, onUser);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export async function sendMagicLink(email) {
  const actionCodeSettings = {
    url: location.origin + "/",
    handleCodeInApp: true,
  };
  await sendSignInLinkToEmail(auth, email, actionCodeSettings);
  window.localStorage.setItem(PENDING_EMAIL_KEY, email);
}

// Called on every load. Finishes the email link sign in when the current URL
// is a sign in link; otherwise this is a no-op.
export async function completeMagicLink() {
  if (!isSignInWithEmailLink(auth, window.location.href)) {
    return null;
  }
  let email = window.localStorage.getItem(PENDING_EMAIL_KEY);
  if (!email) {
    email = window.prompt("Confirm your email to finish signing in");
  }
  if (!email) {
    return null;
  }
  const result = await signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(PENDING_EMAIL_KEY);
  return result;
}

export async function signOutUser() {
  await signOut(auth);
}

export async function getToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}
