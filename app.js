import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection,
  onSnapshot, query, orderBy, serverTimestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from "https://cdn.jsdelivr.net/npm/idb-keyval@6/+esm";

const isFirebaseConfigured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");

let fbApp = null, auth = null, db = null;
if (isFirebaseConfigured) {
  fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
  try { await enableIndexedDbPersistence(db); } catch (e) { /* multiple tabs open, ignore */ }
}

const $ = id => document.getElementById(id);
const fields = ["title", "location", "facilitator", "date", "day"];
const query_ = new URLSearchParams(window.location.search);
const urlMetadata = {};

function normalizeIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim().slice(0, 128) : "";
  return /^[a-zA-Z0-9-]{16,128}$/.test(normalized) ? normalized : "";
}
function createIdentifier() {
  return crypto.randomUUID();
}
function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

fields.forEach(key => {
  const value = query_.get(key);
  if (value === null || !value.trim()) return;
  if (key === "date" && !isValidIsoDate(value.trim())) return;
  urlMetadata[key] = value.trim();
});

const sharedSessionSignature = fields
  .filter(key => Object.hasOwn(urlMetadata, key))
  .map(key => `${key}=${encodeURIComponent(urlMetadata[key])}`)
  .join("&");
const urlSessionId = normalizeIdentifier(query_.get("session"));
const isParticipantMode = Boolean(sharedSessionSignature || urlSessionId);

let activeSessionId = urlSessionId;
let participants = [];
let lastUpdated = null;
let qrLibraryPromise = null;
let unsubscribeSubmissions = null;
let currentUser = null;
let lastQrLink = "";
let sessionAdminUid = null;

function isRegisteredHost(user = currentUser) {
  return Boolean(user && !user.isAnonymous);
}

function canAccessHostFeatures() {
  return isRegisteredHost() && !isParticipantMode;
}

// ---------- Auth pill / offline banner ----------
function setAuthPill(state, text) {
  const pill = $("authPill");
  pill.dataset.state = state;
  pill.textContent = `● ${text}`;
}

function updateOfflineBanner() {
  $("offlineBanner").classList.toggle("show", !navigator.onLine);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
updateOfflineBanner();

// ---------- Signature pad ----------
const canvas = $("signatureCanvas");
const ctx = canvas.getContext("2d");
let drawing = false;
let hasSignature = false;

function setCanvasStyle() {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#173b61";
  ctx.lineWidth = 3.2;
}
setCanvasStyle();

function getPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const source = event.touches ? event.touches[0] : event;
  return {
    x: (source.clientX - rect.left) * canvas.width / rect.width,
    y: (source.clientY - rect.top) * canvas.height / rect.height
  };
}
function startDrawing(event) {
  event.preventDefault();
  drawing = true;
  const p = getPoint(event);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
}
function draw(event) {
  if (!drawing) return;
  event.preventDefault();
  const p = getPoint(event);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  hasSignature = true;
}
function stopDrawing() {
  drawing = false;
  ctx.closePath();
}
canvas.addEventListener("pointerdown", startDrawing);
canvas.addEventListener("pointermove", draw);
canvas.addEventListener("pointerup", stopDrawing);
canvas.addEventListener("pointerleave", stopDrawing);
canvas.addEventListener("pointercancel", stopDrawing);

function clearSignature() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setCanvasStyle();
  hasSignature = false;
}
$("clearSignature").addEventListener("click", clearSignature);

// ---------- Session metadata ----------
function setToday(shouldSave = false) {
  const now = new Date();
  const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split("T")[0];
  $("date").value = iso;
  updateDay(shouldSave);
}
function updateDay(shouldSave = true) {
  if (!$("date").value) {
    $("day").value = "";
    updateAdminSummary();
    if (shouldSave) saveState();
    return;
  }
  const date = new Date($("date").value + "T12:00:00");
  $("day").value = date.toLocaleDateString(undefined, { weekday: "long" });
  updateAdminSummary();
  if (shouldSave) saveState();
}
$("date").addEventListener("change", updateDay);

async function hydrateSessionMetadataFromServer() {
  // Legacy links still embed the fields directly — nothing to fetch.
  if (sharedSessionSignature) return;
  // Nothing to look up, or no way to look it up.
  if (!urlSessionId || !isFirebaseConfigured) return;
  try {
    const snap = await getDoc(doc(db, "sessions", urlSessionId));
    if (snap.exists()) {
      const data = snap.data();
      sessionAdminUid = data.adminUid || null;
      fields.forEach(key => {
        if (data[key]) urlMetadata[key] = data[key];
      });
    }
  } catch (error) {
    console.error("Could not load session details from the server.", error);
  }
}

function updateRoleBasedUI() {
  const hostMode = canAccessHostFeatures();
  document.querySelectorAll(".host-only").forEach(element => {
    element.hidden = !hostMode;
  });

  if (isParticipantMode) {
    $("sessionHeader").hidden = false;
    $("pageTitle").textContent = "Join the attendance register";
    $("pageSubtitle").textContent = "Add your participant details, sign, and submit your attendance below.";
    $("topbarTagline").textContent = "Participant attendance";
    renderParticipantSessionHeader();
    return;
  }

  $("sessionHeader").hidden = true;
  $("pageTitle").textContent = "Record a session";
  $("pageSubtitle").textContent = "Set up the session once, share its attendance link, and collect participant signatures in one export-ready register.";
  $("topbarTagline").textContent = "Digital attendance workspace";
}

function applyUrlMetadata() {
  fields.forEach(key => {
    if (!Object.hasOwn(urlMetadata, key)) return;
    const input = $(key);
    const field = input.closest(".field");
    const label = field.querySelector("label");
    input.value = urlMetadata[key];
    input.readOnly = true;
    input.setAttribute("aria-readonly", "true");
    input.classList.add("url-locked");
    field.classList.add("url-prefilled");
    label.dataset.lockNote = "From link";
  });

  if (Object.hasOwn(urlMetadata, "date") && !Object.hasOwn(urlMetadata, "day")) {
    updateDay(false);
    const dayField = $("day").closest(".field");
    dayField.classList.add("url-prefilled");
    dayField.querySelector("label").dataset.lockNote = "From date";
  }

  updateRoleBasedUI();
}

function metadata() {
  return {
    title: $("title").value.trim(),
    location: $("location").value.trim(),
    facilitator: $("facilitator").value.trim(),
    date: $("date").value,
    day: $("day").value
  };
}

function updateAdminSummary() {
  const info = metadata();
  const summary = [info.title, info.location, info.date, info.day].filter(Boolean).join(" · ");
  $("adminPanelHint").textContent = summary || "Set the session details, then generate a participant link";
}

function renderParticipantSessionHeader() {
  const info = metadata();
  $("sessionHeaderTitle").textContent = info.title || "Attendance session";
  setSessionHeaderItem("sessionLocationItem", "sessionLocation", info.location);
  setSessionHeaderItem("sessionFacilitatorItem", "sessionFacilitator", info.facilitator);
  setSessionHeaderItem("sessionDateItem", "sessionDate", formatSessionDate(info.date));
  setSessionHeaderItem("sessionDayItem", "sessionDay", info.day);
}
function setSessionHeaderItem(itemId, valueId, value) {
  $(itemId).hidden = !value;
  $(valueId).textContent = value || "";
}
function formatSessionDate(value) {
  if (!value) return "";
  const date = new Date(value + "T12:00:00");
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function buildShareLink() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (activeSessionId) url.searchParams.set("session", activeSessionId);
  return url.toString();
}

// ---------- Firestore session + submissions ----------
async function waitForAuth() {
  if (currentUser) return currentUser;
  return new Promise((resolve, reject) => {
    if (!auth) return reject(new Error("Firebase isn't configured yet. See firebase-config.js."));
    const unsub = onAuthStateChanged(auth, user => {
      if (user) { unsub(); resolve(user); }
    }, reject);
  });
}

async function registerSession() {
  const user = await waitForAuth();
  const info = metadata();
  await setDoc(doc(db, "sessions", activeSessionId), {
    adminUid: user.uid,
    updatedAt: serverTimestamp(),
    ...info,
  }, { merge: true });
}

async function copyText(value) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; } catch (error) {}
  }
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
  helper.remove();
  return copied;
}

async function prepareSessionLink() {
  if (!$("title").value.trim() || !$("date").value) {
    $("session").open = true;
    const missingField = !$("title").value.trim() ? $("title") : $("date");
    missingField.focus();
    showToast("Add a session title and date before generating the link.");
    return "";
  }
  if (!isFirebaseConfigured) {
    showToast("Firebase isn't set up yet — see README.md to connect your free project.");
    $("linkStatus").textContent = "Firebase isn't configured yet (see README.md).";
    return "";
  }

  updateDay(false);
  if (!activeSessionId) activeSessionId = createIdentifier();
  $("linkStatus").textContent = "Creating the central attendance session…";
  try {
    await registerSession();
  } catch (error) {
    $("linkStatus").textContent = error.message;
    showToast("Could not create the central session.");
    return "";
  }
  saveState();
  const link = buildShareLink();
  $("shareLink").value = link;
  $("shareLinkResult").hidden = false;
  $("copyLinkBtn").disabled = false;
  return link;
}

function loadQrLibrary() {
  if (typeof window.qrcode === "function") return Promise.resolve();
  if (qrLibraryPromise) return qrLibraryPromise;
  qrLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return qrLibraryPromise;
}

async function renderQrCode(link) {
  const container = $("qrCode");
  container.innerHTML = "";
  container.textContent = "Preparing QR code…";
  $("qrPanel").hidden = false;

  try {
    await loadQrLibrary();
  } catch (error) {
    container.textContent = "QR code unavailable";
    $("linkStatus").textContent = "The link is ready, but the QR renderer could not load.";
    showToast("Link generated. QR code unavailable.");
    return false;
  }

  try {
    container.textContent = "";
    const code = window.qrcode(0, "M");
    code.addData(link);
    code.make();
    container.innerHTML = code.createSvgTag(6, 4);
    lastQrLink = link;
    return true;
  } catch (error) {
    container.textContent = "QR code unavailable";
    $("linkStatus").textContent = "The session link is too long to render as a QR code.";
    showToast("Link generated. QR code unavailable.");
    return false;
  }
}

async function downloadQrCode() {
  const svgEl = $("qrCode").querySelector("svg");
  if (!svgEl) {
    showToast("Generate the QR code first.");
    return;
  }
  const svgText = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const canvasEl = document.createElement("canvas");
    const padding = 24;
    canvasEl.width = 512 + padding * 2;
    canvasEl.height = 512 + padding * 2;
    const c = canvasEl.getContext("2d");
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, canvasEl.width, canvasEl.height);
    c.drawImage(img, padding, padding, 512, 512);
    URL.revokeObjectURL(svgUrl);
    canvasEl.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileBase() + "-qr-code.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("QR code image downloaded.");
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(svgUrl);
    showToast("Could not prepare the QR image. Try 'Show QR Code' again first.");
  };
  img.src = svgUrl;
}
$("downloadQrBtn").addEventListener("click", downloadQrCode);

async function generateLink() {
  const link = await prepareSessionLink();
  if (!link) return;
  subscribeToSubmissions();
  const rendered = await renderQrCode(link);
  if (rendered) {
    $("linkStatus").textContent = "Participant link and QR code generated.";
    showToast("Participant link and QR code generated.");
  }
}

async function copyGeneratedLink() {
  const link = $("shareLink").value || await prepareSessionLink();
  if (!link) return;
  const copied = await copyText(link);
  $("linkStatus").textContent = copied
    ? "Participant link copied. Share it with attendees."
    : "Select and copy the generated link manually.";
  showToast(copied ? "Participant link copied." : "Copy the displayed link manually.");
}

async function showQrCode() {
  const link = $("shareLink").value || await prepareSessionLink();
  if (!link) return;
  if (await renderQrCode(link)) {
    $("linkStatus").textContent = "QR code ready to project or scan.";
    showToast("QR code ready.");
  }
}

// ---------- Local (admin) state ----------
const LOCAL_KEY = "attendly-active-session";

function saveState() {
  const state = {
    metadata: metadata(),
    sessionId: activeSessionId,
    lastUpdated: lastUpdated?.toISOString() || "",
  };
  if (!isParticipantMode) localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  updateStats();
}

function subscribeToSubmissions() {
  if (isParticipantMode || !isFirebaseConfigured) return;
  if (unsubscribeSubmissions) { unsubscribeSubmissions(); unsubscribeSubmissions = null; }
  if (!activeSessionId) return;

  $("dashboardSyncStatus").textContent = "Connecting to the central register…";
  const q = query(collection(db, "sessions", activeSessionId, "submissions"), orderBy("createdAt", "asc"));
  unsubscribeSubmissions = onSnapshot(q,
    snapshot => {
      participants = snapshot.docs.map(d => ({ submissionId: d.id, ...d.data() }));
      lastUpdated = new Date();
      $("dashboardSyncStatus").textContent = "Central register is up to date";
      $("dashboardSyncStatus").dataset.state = "live";
      renderParticipants();
      saveState();
    },
    error => {
      $("dashboardSyncStatus").textContent = navigator.onLine
        ? "Could not reach the central register (check Firebase setup)."
        : "Offline — showing the last synced data.";
      $("dashboardSyncStatus").dataset.state = "error";
    }
  );
}

async function loadState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LOCAL_KEY));
  } catch (error) { saved = null; }

  if (!isParticipantMode && saved?.metadata) {
    fields.forEach(key => { if ($(key)) $(key).value = saved.metadata[key] || ""; });
    activeSessionId = normalizeIdentifier(saved?.sessionId);
    lastUpdated = saved?.lastUpdated ? new Date(saved.lastUpdated) : null;
  }

  if (!saved) setToday(false);
  await hydrateSessionMetadataFromServer();
  applyUrlMetadata();
  updateAdminSummary();
  renderParticipants();
  updateStats();

  if (!isParticipantMode && activeSessionId) {
    $("shareLink").value = buildShareLink();
    $("shareLinkResult").hidden = false;
    $("copyLinkBtn").disabled = false;
    subscribeToSubmissions();
  }
  if (!isParticipantMode) renderHistoryList();
}

fields.forEach(key => {
  $(key).addEventListener("input", () => {
    saveState();
    updateAdminSummary();
    if (!isParticipantMode) {
      $("shareLink").value = "";
      $("shareLinkResult").hidden = true;
      $("copyLinkBtn").disabled = true;
      $("qrPanel").hidden = true;
      $("qrCode").innerHTML = "";
      $("linkStatus").textContent = "Only completed fields are included in the link.";
    }
  });
});

$("participantForm").addEventListener("submit", async function (event) {
  event.preventDefault();

  if (!$("title").value.trim() && !isParticipantMode) {
    showToast("Please add a session title first.");
    $("session").open = true;
    $("title").focus();
    return;
  }
  if (!activeSessionId) {
    showToast(isParticipantMode ? "This attendance link is missing its session ID." : "Generate the session link before collecting attendance.");
    if (!isParticipantMode) $("session").open = true;
    return;
  }
  if (!hasSignature) {
    showToast("Please add a participant signature.");
    return;
  }
  if (!isFirebaseConfigured) {
    showToast("This attendance form isn't connected yet. Ask the organizer to finish setup.");
    return;
  }

  const submissionId = $("participantForm").dataset.submissionId || createIdentifier();
  const participant = {
    sessionId: activeSessionId,
    name: $("name").value.trim(),
    organization: $("organization").value.trim(),
    designation: $("designation").value.trim(),
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    signature: canvas.toDataURL("image/png"),
    createdAt: serverTimestamp(),
  };
  $("participantForm").dataset.submissionId = submissionId;

  $("submitParticipantBtn").disabled = true;
  $("submitParticipantBtn").textContent = "Saving attendance…";
  $("submissionStatus").textContent = "Saving securely to the central register…";

  try {
    await waitForAuth();
    await setDoc(doc(db, "sessions", activeSessionId, "submissions", submissionId), participant);
    delete $("participantForm").dataset.submissionId;
    ["name", "organization", "designation", "email", "phone"].forEach(id => $(id).value = "");
    clearSignature();
    $("submissionStatus").textContent = "Attendance saved to the central register.";
    showToast("Attendance submitted successfully.");
    $("name").focus();
  } catch (error) {
    $("submissionStatus").textContent = "Submission was not saved. Check your connection and try again.";
    showToast(error.message || "Could not save attendance.");
  } finally {
    $("submitParticipantBtn").disabled = false;
    $("submitParticipantBtn").textContent = "＋ Submit attendance";
  }
});

function renderParticipants() {
  const body = $("participantBody");
  if (!body) return;
  body.innerHTML = "";
  const hostMode = canAccessHostFeatures();

  if (!participants.length) {
    const emptyMessage = activeSessionId
      ? "No signed attendees have reached the central register yet."
      : "Generate a participant link to create the central register.";
    body.innerHTML = `
      <tr id="emptyRow"><td colspan="8">
        <div class="empty-state">
          <div class="empty-icon">♙</div>
          <strong style="display:block;color:#536278;margin-bottom:4px;">Central register is empty</strong>
          ${emptyMessage}
        </div>
      </td></tr>`;
  } else {
    participants.forEach((person, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td class="number-cell">${index + 1}</td>
        <td class="person-name">${escapeHtml(person.name)}</td>
        <td>${escapeHtml(person.organization) || "—"}</td>
        <td>${escapeHtml(person.designation) || "—"}</td>
        <td>${escapeHtml(person.email) || "—"}</td>
        <td>${escapeHtml(person.phone) || "—"}</td>
        <td><img class="signature-thumb" src="${person.signature}" alt="Signature of ${escapeHtml(person.name)}"></td>
        <td>${hostMode ? `<button class="delete-link" title="Remove participant" aria-label="Remove ${escapeHtml(person.name)}" data-id="${person.submissionId}">×</button>` : ""}</td>`;
      body.appendChild(row);
    });
    body.querySelectorAll(".delete-link").forEach(button => {
      button.addEventListener("click", () => removeSubmission(button.dataset.id));
    });
  }

  if ($("recordHint")) {
    $("recordHint").textContent = participants.length ? `${participants.length} signed record${participants.length === 1 ? "" : "s"}` : "No records added yet";
  }
  if ($("footerCount")) {
    $("footerCount").textContent = `${participants.length} participant${participants.length === 1 ? "" : "s"} recorded`;
  }
  updateStats();
}

async function removeSubmission(submissionId) {
  if (!activeSessionId) return;
  try {
    await deleteDoc(doc(db, "sessions", activeSessionId, "submissions", submissionId));
    showToast("Participant removed from the central register.");
  } catch (error) {
    showToast(error.message || "Could not remove participant.");
  }
}

function updateStats() {
  if (!canAccessHostFeatures()) return;
  const count = participants.length;
  $("participantCount").textContent = count;
  $("sessionStatus").textContent = activeSessionId ? (count ? "Live" : "Open") : "Setup";
  $("sessionStatusNote").textContent = activeSessionId ? "Central attendance session is active" : "Generate a link to open attendance";
  $("lastUpdated").textContent = lastUpdated ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}
function csvValue(value) {
  return '"' + String(value ?? "").replace(/"/g, '""') + '"';
}
function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileBase(info = metadata()) {
  return (info.title || "attendance-register").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "attendance-register";
}

function exportCSV(info = metadata(), list = participants) {
  if (!list.length) {
    showToast("Add at least one participant before exporting.");
    return;
  }
  const rows = [
    ["Session title", info.title],
    ["Location", info.location],
    ["Facilitator", info.facilitator],
    ["Date", info.date],
    ["Day", info.day],
    [],
    ["No.", "Name of Participant", "Organization", "Designation / Job Title", "Email Address", "Phone Contact", "Signature (PNG data)"]
  ];
  list.forEach((p, i) => rows.push([i + 1, p.name, p.organization, p.designation, p.email, p.phone, p.signature]));
  const csv = "\uFEFF" + rows.map(row => row.map(csvValue).join(",")).join("\r\n");
  downloadFile(fileBase(info) + ".csv", csv, "text/csv;charset=utf-8");
  showToast("CSV / Excel file downloaded.");
}

function exportMaster(info = metadata(), list = participants) {
  if (!list.length) {
    showToast("Add at least one participant before exporting.");
    return;
  }
  const participantRows = list.map((p, i) => `
    <tr>
      <td>${i + 1}</td><td><strong>${escapeHtml(p.name)}</strong></td>
      <td>${escapeHtml(p.organization) || "—"}</td><td>${escapeHtml(p.designation) || "—"}</td>
      <td>${escapeHtml(p.email) || "—"}</td><td>${escapeHtml(p.phone) || "—"}</td>
      <td><img src="${p.signature}" alt="Signature"></td>
    </tr>`).join("");

  const htmlDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(info.title)} - Attendance Register</title>
  <style>body{font-family:Arial,sans-serif;color:#172033;padding:35px}h1{margin-bottom:5px;color:#10243e}p{color:#657388}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:25px 0}.meta div{padding:12px;background:#f3f6fa;border-radius:7px}.meta b{display:block;color:#758399;font-size:11px;text-transform:uppercase;margin-bottom:5px}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#10243e;color:#fff;text-align:left}th,td{padding:10px;border:1px solid #dce3ed}td img{width:95px;height:38px;object-fit:contain}</style></head>
  <body><h1>${escapeHtml(info.title || "Attendance Register")}</h1><p>Digital session attendance record</p>
  <div class="meta"><div><b>Location</b>${escapeHtml(info.location) || "—"}</div><div><b>Facilitator</b>${escapeHtml(info.facilitator) || "—"}</div><div><b>Date</b>${escapeHtml(info.date) || "—"} (${escapeHtml(info.day) || "—"})</div></div>
  <table><thead><tr><th>No.</th><th>Participant</th><th>Organization</th><th>Designation / Job Title</th><th>Email</th><th>Phone</th><th>Signature</th></tr></thead><tbody>${participantRows}</tbody></table></body></html>`;
  downloadFile(fileBase(info) + "-master-document.html", htmlDoc, "text/html;charset=utf-8");
  showToast("Master document downloaded.");
}

// ---------- History (local IndexedDB archive of past sessions) ----------
async function archiveCurrentSession() {
  if (!activeSessionId || !participants.length) return;
  const record = {
    sessionId: activeSessionId,
    metadata: metadata(),
    participants: participants,
    archivedAt: new Date().toISOString(),
  };
  try {
    await idbSet(`session:${activeSessionId}`, record);
  } catch (error) {
    showToast("Could not save this session to on-device history.");
  }
}

async function getAllHistory() {
  try {
    const allKeys = (await idbKeys()).filter(k => String(k).startsWith("session:"));
    const records = await Promise.all(allKeys.map(k => idbGet(k)));
    return records.filter(Boolean).sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  } catch (error) {
    return [];
  }
}

async function renderHistoryList() {
  const list = $("historyList");
  const records = await getAllHistory();
  if (!records.length) {
    list.innerHTML = `<div class="history-empty">No past sessions saved on this device yet. Sessions with at least one participant are archived here when you start a new session.</div>`;
    return;
  }
  list.innerHTML = "";
  records.forEach(record => {
    const card = document.createElement("div");
    card.className = "history-card";
    const info = record.metadata || {};
    card.innerHTML = `
      <div class="history-card-main">
        <p class="history-card-title">${escapeHtml(info.title || "Untitled session")}</p>
        <p class="history-card-meta">${[info.date, info.location, `${record.participants.length} participant${record.participants.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</p>
      </div>
      <div class="history-card-actions">
        <button class="btn btn-secondary btn-tiny" data-action="view" type="button">View</button>
        <button class="btn btn-secondary btn-tiny" data-action="delete" type="button">Delete</button>
      </div>`;
    card.querySelector('[data-action="view"]').addEventListener("click", () => showHistoryDetail(record));
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`Delete "${info.title || "this session"}" from on-device history? This can't be undone.`)) return;
      await idbDel(`session:${record.sessionId}`);
      showToast("Session removed from history.");
      renderHistoryList();
      $("historyDetail").hidden = true;
    });
    list.appendChild(card);
  });
}

function showHistoryDetail(record) {
  const info = record.metadata || {};
  $("historyDetail").hidden = false;
  $("historyDetailTitle").textContent = info.title || "Untitled session";
  const body = $("historyDetailBody");
  body.innerHTML = record.participants.map((p, i) => `
    <tr>
      <td class="number-cell">${i + 1}</td>
      <td class="person-name">${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.organization) || "—"}</td>
      <td>${escapeHtml(p.designation) || "—"}</td>
      <td>${escapeHtml(p.email) || "—"}</td>
      <td>${escapeHtml(p.phone) || "—"}</td>
      <td><img class="signature-thumb" src="${p.signature}" alt="Signature of ${escapeHtml(p.name)}"></td>
    </tr>`).join("");
  $("historyCsvBtn").onclick = () => exportCSV(info, record.participants);
  $("historyExportBtn").onclick = () => exportMaster(info, record.participants);
  $("historyDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("historyCloseBtn").addEventListener("click", () => { $("historyDetail").hidden = true; });

async function newSession() {
  if (participants.length && !confirm("Start a new session? This session will be saved to Past Sessions on this device, and stays live in the central register too.")) return;
  await archiveCurrentSession();
  if (unsubscribeSubmissions) { unsubscribeSubmissions(); unsubscribeSubmissions = null; }
  participants = [];
  activeSessionId = "";
  lastUpdated = null;
  localStorage.removeItem(LOCAL_KEY);
  fields.forEach(key => $(key).value = "");
  $("participantForm").reset();
  clearSignature();
  setToday(false);
  applyUrlMetadata();
  updateAdminSummary();
  $("shareLinkResult").hidden = true;
  $("shareLink").value = "";
  $("copyLinkBtn").disabled = true;
  $("qrPanel").hidden = true;
  $("qrCode").innerHTML = "";
  if (!isParticipantMode) {
    $("session").open = true;
    $("linkStatus").textContent = "Only completed fields are included in the link.";
  }
  $("dashboardSyncStatus").textContent = "Generate a session link to start syncing";
  $("dashboardSyncStatus").dataset.state = "";
  $("submissionStatus").innerHTML = "<span>*</span> Required fields";
  renderParticipants();
  updateStats();
  await renderHistoryList();
  showToast("New session ready. The previous one is saved under Past Sessions.");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

$("csvBtn").addEventListener("click", () => exportCSV());
$("exportBtnTop").addEventListener("click", () => exportMaster());
$("exportBtnBottom").addEventListener("click", () => exportMaster());
$("newSessionBtn").addEventListener("click", newSession);
$("generateLinkBtn").addEventListener("click", generateLink);
$("copyLinkBtn").addEventListener("click", copyGeneratedLink);
$("showQrBtn").addEventListener("click", showQrCode);

// ---------- Auth: participants sign in silently, hosts log in on a separate page ----------
const AUTH_ERROR_MESSAGES = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/user-not-found": "No account found with that email. Try \"Create account\" instead.",
  "auth/wrong-password": "Incorrect password. Try again.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/email-already-in-use": "An account already exists with that email. Try \"Log in\" instead.",
  "auth/weak-password": "Password must be at least 8 characters and include uppercase, lowercase, and a number.",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
};

const PASSWORD_CHECKS = {
  length: value => value.length >= 8,
  upper: value => /[A-Z]/.test(value),
  lower: value => /[a-z]/.test(value),
  number: value => /\d/.test(value),
};

function evaluatePassword(password) {
  const checks = {};
  Object.entries(PASSWORD_CHECKS).forEach(([key, test]) => {
    checks[key] = test(password);
  });
  return { checks, valid: Object.values(checks).every(Boolean) };
}

function updatePasswordRulesUI(password) {
  const { checks } = evaluatePassword(password);
  $("passwordRules").querySelectorAll(".password-rule").forEach(rule => {
    const key = rule.dataset.rule;
    const met = Boolean(checks[key]);
    rule.classList.toggle("met", met);
    rule.querySelector(".password-rule-icon").textContent = met ? "✓" : "○";
  });
}

function validateSignupPassword(password) {
  const result = evaluatePassword(password);
  if (result.valid) return "";
  if (!result.checks.length) return "Password must be at least 8 characters.";
  if (!result.checks.upper) return "Password must include at least one uppercase letter.";
  if (!result.checks.lower) return "Password must include at least one lowercase letter.";
  if (!result.checks.number) return "Password must include at least one number.";
  return "Password does not meet the requirements.";
}

function friendlyAuthError(error) {
  return AUTH_ERROR_MESSAGES[error?.code] || error?.message || "Something went wrong. Please try again.";
}

let authMode = "login";
let adminStateLoaded = false;
let authTransitionTimer = null;

function setAuthMode(mode, { animate = true } = {}) {
  if (mode === authMode) return;
  authMode = mode;
  $("authTabs").dataset.mode = mode;
  $("authTabLogin").classList.toggle("active", mode === "login");
  $("authTabSignup").classList.toggle("active", mode === "signup");
  $("authSubmitBtn").textContent = mode === "login" ? "Log in" : "Create account";
  $("authGateTitle").textContent = mode === "login" ? "Sign in to Attendly" : "Create your Attendly account";
  $("authGateSub").textContent = mode === "login"
    ? "Log in to create sessions and manage your attendance links. Participants filling in via a shared link never need an account."
    : "Create a free account to host sessions, generate attendance links, and export registers. You can manage your own sessions as an admin.";
  $("authPassword").placeholder = mode === "login" ? "Enter your password" : "Create a strong password";
  $("authPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("passwordRules").hidden = mode !== "signup";
  $("authError").hidden = true;

  if (animate) {
    const form = $("authForm");
    form.classList.remove("is-entering");
    void form.offsetWidth;
    form.classList.add("is-entering");
  }

  if (mode === "signup") updatePasswordRulesUI($("authPassword").value);
}

function showAuthScreen() {
  clearTimeout(authTransitionTimer);
  $("mainApp").hidden = true;
  $("mainApp").classList.remove("is-entering");
  const screen = $("authScreen");
  screen.hidden = false;
  screen.classList.remove("is-leaving");
}

function revealMainApp({ animate = true } = {}) {
  const screen = $("authScreen");
  const app = $("mainApp");
  app.hidden = false;
  updateRoleBasedUI();

  if (animate) {
    screen.classList.add("is-leaving");
    app.classList.add("is-entering");
    authTransitionTimer = setTimeout(() => {
      screen.hidden = true;
      screen.classList.remove("is-leaving");
      app.classList.remove("is-entering");
    }, 480);
  } else {
    screen.hidden = true;
    screen.classList.remove("is-leaving");
    app.classList.remove("is-entering");
  }
}

$("authTabLogin").addEventListener("click", () => setAuthMode("login"));
$("authTabSignup").addEventListener("click", () => setAuthMode("signup"));
$("authPassword").addEventListener("input", () => {
  if (authMode === "signup") updatePasswordRulesUI($("authPassword").value);
});

$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  $("authError").hidden = true;

  if (authMode === "signup") {
    const passwordError = validateSignupPassword(password);
    if (passwordError) {
      updatePasswordRulesUI(password);
      $("authError").textContent = passwordError;
      $("authError").hidden = false;
      return;
    }
  }

  $("authSubmitBtn").disabled = true;
  const originalLabel = $("authSubmitBtn").textContent;
  $("authSubmitBtn").textContent = "Please wait…";
  try {
    if (authMode === "login") {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      await createUserWithEmailAndPassword(auth, email, password);
    }
    $("authPassword").value = "";
    $("authEmail").blur();
  } catch (error) {
    $("authError").textContent = friendlyAuthError(error);
    $("authError").hidden = false;
  } finally {
    $("authSubmitBtn").disabled = false;
    $("authSubmitBtn").textContent = originalLabel;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  if (unsubscribeSubmissions) { unsubscribeSubmissions(); unsubscribeSubmissions = null; }
  adminStateLoaded = false;
  await signOut(auth);
});

function handleAdminAuthState(user) {
  currentUser = user;
  const loggedIn = isRegisteredHost(user);

  if (loggedIn) {
    setAuthPill("live", navigator.onLine ? (user.email || "Signed in") : "Offline (will sync)");
    revealMainApp({ animate: !adminStateLoaded });
    $("logoutBtn").hidden = false;
    if (!adminStateLoaded) {
      adminStateLoaded = true;
      loadState();
    } else {
      updateRoleBasedUI();
    }
  } else {
    showAuthScreen();
    setAuthPill("offline", "Sign in required");
    $("logoutBtn").hidden = true;
  }
}

// ---------- Auth bootstrap ----------
if (isFirebaseConfigured) {
  if (isParticipantMode) {
    onAuthStateChanged(auth, user => {
      currentUser = user;
      if (user) setAuthPill("live", navigator.onLine ? "Connected" : "Offline (will sync)");
    });
    signInAnonymously(auth).catch(error => {
      setAuthPill("error", "Connection failed — try reloading");
      console.error(error);
    });
    $("authScreen").hidden = true;
    revealMainApp({ animate: false });
    loadState();
  } else {
    setAuthMode("login", { animate: false });
    showAuthScreen();
    onAuthStateChanged(auth, handleAdminAuthState);
  }
} else {
  setAuthPill("offline", "Firebase not configured — see README.md");
  if (isParticipantMode) {
    $("authScreen").hidden = true;
    revealMainApp({ animate: false });
    loadState();
  } else {
    showAuthScreen();
    $("authError").textContent = "Firebase isn't configured yet. Update firebase-config.js to enable sign-in.";
    $("authError").hidden = false;
  }
}

// ---------- PWA: service worker + install prompt ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installBtn").hidden = true;
});
window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });
