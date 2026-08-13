const DB_NAME = "nix-archive";
const DB_VERSION = 1;
const WORKS_STORE = "works";
const BLOBS_STORE = "blobs";
const OWNER_NAME = "nixz0824";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORKS_STORE)) {
        db.createObjectStore(WORKS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
}

async function idbDelete(store, id) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(id);
  await txDone(tx);
}

export function isOwnerName(value) {
  return String(value || "").trim().toLowerCase() === OWNER_NAME;
}

export function loadLikes() {
  try {
    return JSON.parse(localStorage.getItem("nix-likes") || "{}");
  } catch {
    return {};
  }
}

export function saveLikes(map) {
  localStorage.setItem("nix-likes", JSON.stringify(map));
}

export function loadLikeDelta() {
  try {
    return JSON.parse(localStorage.getItem("nix-like-delta") || "{}");
  } catch {
    return {};
  }
}

export function saveLikeDelta(map) {
  localStorage.setItem("nix-like-delta", JSON.stringify(map));
}

export function loadDeleted() {
  try {
    return JSON.parse(localStorage.getItem("nix-deleted") || "[]");
  } catch {
    return [];
  }
}

export function saveDeleted(ids) {
  localStorage.setItem("nix-deleted", JSON.stringify(ids));
}

export function loadLang() {
  const stored = localStorage.getItem("nix-lang");
  if (stored === "en" || stored === "zh") return stored;
  return navigator.language && navigator.language.toLowerCase().startsWith("zh")
    ? "zh"
    : "zh";
}

export function saveLang(lang) {
  localStorage.setItem("nix-lang", lang);
}

export function loadRole() {
  return sessionStorage.getItem("nix-role") === "owner" ? "owner" : "viewer";
}

export function saveRole(role) {
  if (role === "owner") sessionStorage.setItem("nix-role", "owner");
  else sessionStorage.removeItem("nix-role");
}

export async function fetchCatalog() {
  const res = await fetch("data/works.json", { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.works) ? data.works : [];
}

export async function loadLocalWorks() {
  return idbGetAll(WORKS_STORE);
}

export async function loadBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(BLOBS_STORE, "readonly").objectStore(BLOBS_STORE).get(id);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocalWork(work, blob, refBlobs = []) {
  await idbPut(WORKS_STORE, work);
  if (blob) await idbPut(BLOBS_STORE, { id: work.id, blob });
  for (let i = 0; i < refBlobs.length; i += 1) {
    await idbPut(BLOBS_STORE, { id: `${work.id}::ref::${i}`, blob: refBlobs[i] });
  }
}

export async function removeLocalWork(id) {
  await idbDelete(WORKS_STORE, id);
  await idbDelete(BLOBS_STORE, id);
  const all = await idbGetAll(BLOBS_STORE);
  for (const item of all) {
    if (String(item.id).startsWith(`${id}::ref::`)) {
      await idbDelete(BLOBS_STORE, item.id);
    }
  }
}

export async function tryPersistToServer(work, file, refFiles = []) {
  const body = new FormData();
  body.append("meta", JSON.stringify({
    id: work.id,
    type: work.type,
    title: work.title,
    models: work.models,
    prompt: work.prompt,
    createdAt: work.createdAt,
    likes: work.likes || 0,
    poster: work.poster || "",
    refs: work.refs || [],
  }));
  if (file) body.append("file", file, file.name);
  refFiles.forEach((refFile) => {
    body.append("refs", refFile, refFile.name);
  });

  try {
    const res = await fetch("/api/works", { method: "POST", body });
    if (!res.ok) return { ok: false };
    return { ok: true, remote: await res.json() };
  } catch {
    return { ok: false };
  }
}

export async function tryDeleteOnServer(id) {
  try {
    const res = await fetch(`/api/works/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
