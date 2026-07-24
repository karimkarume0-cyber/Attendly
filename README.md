# Attendly — Digital Attendance PWA

A self-hosted, installable attendance app: you fill in the session details once,
share a QR code / link, participants sign in on their own phones, and every
submission lands live in your Admin Dashboard — synced through a free Firebase
backend. Past sessions stay saved on your device even after you start a new one.

## What changed from the Netlify version

- **No more Netlify functions.** The app is now 100% static files (works on
  GitHub Pages, Netlify's free static hosting, or any web host).
- **Central sync now runs on Firebase** (Firestore + Anonymous Auth), which has
  a generous free tier — this replaces the old `/api/attendance/...` calls.
- **Downloadable QR code** (PNG) next to "Show QR Code".
- **Full PWA**: installable on phones/desktops, works offline (the form shell
  loads offline; submissions sync once you're back online).
- **Past sessions**: starting a new session archives the old one — with all its
  participants and signatures — into on-device storage (IndexedDB) instead of
  deleting it. See the new "Past sessions" tab.

---

## Step 1 — Create your free Firebase project (~10 minutes)

1. Go to <https://console.firebase.google.com> and click **Add project**.
   Give it any name (e.g. `attendly`) and finish the wizard (Analytics is optional).
2. In the left sidebar, open **Build → Authentication** → **Get started**.
   Under **Sign-in method**, enable **Anonymous** and save.
3. Open **Build → Firestore Database** → **Create database**.
   Choose **Start in production mode**, pick a region close to you, and create it.
4. Go to the **Rules** tab of Firestore, delete the default contents, and paste
   in the contents of [`firestore.rules`](./firestore.rules) from this folder.
   Click **Publish**.
5. Go to **Project settings** (gear icon, top left) → scroll to **Your apps** →
   click the **Web** icon (`</>`) → register an app (any nickname, no need for
   Firebase Hosting) → copy the `firebaseConfig` object it shows you.
6. Open [`firebase-config.js`](./firebase-config.js) in this folder and paste
   your values in, replacing the placeholders. Save the file.

That's it — no server, no billing setup required. Firestore's free tier
(~50,000 reads / 20,000 writes per day) is far more than a training/attendance
tool needs.

## Step 2 — Put it on GitHub

1. Create a new **public** repository on GitHub (Pages needs it public unless
   you're on a paid plan), e.g. `attendly`.
2. Upload all the files in this folder to the repo root — keep the folder
   structure (`icons/` stays a subfolder).
3. Go to the repo's **Settings → Pages**. Under **Build and deployment**,
   set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`.
   Save.
4. After a minute, GitHub shows your live URL, something like:
   `https://your-username.github.io/attendly/`
   That's the link you'll open as the admin, and the base for every QR code.

> PWA install and offline features require HTTPS — GitHub Pages gives you
> that automatically, so no extra setup needed there.

## Step 3 — Run a session

1. Open your GitHub Pages URL. Fill in **Title**, **Location**, **Facilitator**,
   **Date** in the Admin Session Setup card — these are the "header" fields.
2. Click **Generate Link**. This creates the central session in Firestore and
   builds a link with your header details baked into the URL, so participants
   never see or fill those fields.
3. Click **Show QR Code**, then **Download QR (PNG)** if you want to print it
   or drop it into a slide/poster. Or just **Copy Link** to share directly.
4. As participants scan the QR and submit their **Name, Organization,
   Designation, Email, Phone, Signature**, they appear in your **Admin
   Dashboard** in real time — no manual refresh needed.
5. When the session ends, click **＋ New Session**. The finished session (with
   all participants and signatures) is saved under **Past sessions** on this
   device, and a blank form is ready for the next one. You can still export
   CSV / the master document for it any time from there.

### Installing it as an app

On your phone or desktop, open the GitHub Pages link in Chrome/Edge — you'll
see an **⤓ Install app** button in the top bar (or use the browser's own
"Install app" / "Add to Home Screen" option). On iOS Safari, use
**Share → Add to Home Screen**.

---

## Notes & limitations

- **Admin identity is per-browser.** Firebase signs your admin device in
  anonymously and remembers you via that browser's storage. If you clear
  site data or switch browsers/devices, you'll get a new identity and won't
  be able to see or manage sessions created under the old one (their data
  stays safely in Firestore, just not reachable from the new identity).
  If you want one admin login usable across multiple devices, the natural
  upgrade is swapping Anonymous Auth for **Email/Password** or **Google**
  sign-in — happy to wire that up if you'd like it.
- **Past sessions storage** lives in the browser's IndexedDB on that specific
  device/browser — it isn't synced anywhere, so exporting a CSV/master
  document after each session is still good practice if you need a backup
  copy elsewhere.
- Firestore's free tier is generous, but very large recurring events (many
  thousands of sign-ins a day) would eventually need the paid Blaze plan —
  still effectively free at typical training/workshop volumes.
