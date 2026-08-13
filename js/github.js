const TOKEN_KEY = "zx-github-token";

export function loadToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function saveToken(token) {
  const value = String(token || "").trim();
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function readSiteConfig() {
  const res = await fetch("data/site.json", { cache: "no-store" });
  if (!res.ok) throw new Error("missing site.json");
  return res.json();
}

export function pagesUrl(site) {
  return `https://${site.githubUser}.github.io/${site.githubRepo}/`;
}

export async function checkRepo(site, token) {
  const res = await fetch(
    `https://api.github.com/repos/${site.githubUser}/${site.githubRepo}`,
    { headers: headers(token) }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ${res.status}`);
  }
  return res.json();
}

async function getContent(site, token, path) {
  const res = await fetch(
    `https://api.github.com/repos/${site.githubUser}/${site.githubRepo}/contents/${path}?ref=${encodeURIComponent(site.githubBranch)}`,
    { headers: headers(token) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${path} failed`);
  return res.json();
}

function decodeBase64Utf8(b64) {
  const binary = atob(String(b64 || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function putContent(site, token, path, bytes, message, sha) {
  const body = {
    message,
    content: bytesToBase64(bytes),
    branch: site.githubBranch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${site.githubUser}/${site.githubRepo}/contents/${path}`,
    {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `write ${path} failed`);
  }
  return res.json();
}

async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function extOf(file, fallback) {
  const name = file && file.name ? file.name : "";
  const match = name.match(/(\.[A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : fallback;
}

export async function publishWork(site, token, work, file, refFiles = []) {
  if (file && file.size > 80 * 1024 * 1024) {
    throw new Error("file too large for GitHub");
  }

  const published = { ...work };
  delete published.local;
  delete published.filename;

  if (file) {
    const folder = work.type === "video" ? "media/videos" : "media/images";
    const path = `${folder}/${work.id}${extOf(file, work.type === "video" ? ".mp4" : ".jpg")}`;
    const existing = await getContent(site, token, path);
    await putContent(site, token, path, await fileToBytes(file), `add work ${work.id}`, existing && existing.sha);
    published.src = path;
    if (work.type === "image") published.poster = "";
  }

  const refs = [];
  for (let i = 0; i < refFiles.length; i += 1) {
    const refFile = refFiles[i];
    const path = `media/refs/${work.id}-${i + 1}${extOf(refFile, ".jpg")}`;
    const existing = await getContent(site, token, path);
    await putContent(site, token, path, await fileToBytes(refFile), `add ref ${work.id}`, existing && existing.sha);
    refs.push(path);
  }
  if (refs.length) published.refs = refs;

  const catalogFile = await getContent(site, token, "data/works.json");
  let catalog = { works: [] };
  if (catalogFile && catalogFile.content) {
    catalog = JSON.parse(decodeBase64Utf8(catalogFile.content));
  }
  const works = Array.isArray(catalog.works) ? catalog.works.filter((item) => item.id !== published.id) : [];
  works.unshift(published);
  await putContent(
    site,
    token,
    "data/works.json",
    textToBytes(JSON.stringify({ works }, null, 2) + "\n"),
    `update catalog ${work.id}`,
    catalogFile && catalogFile.sha
  );
  return published;
}

export async function unpublishWork(site, token, workId) {
  const catalogFile = await getContent(site, token, "data/works.json");
  if (!catalogFile || !catalogFile.content) return;
  const catalog = JSON.parse(decodeBase64Utf8(catalogFile.content));
  const works = (catalog.works || []).filter((item) => item.id !== workId);
  await putContent(
    site,
    token,
    "data/works.json",
    textToBytes(JSON.stringify({ works }, null, 2) + "\n"),
    `remove ${workId}`,
    catalogFile.sha
  );
}
