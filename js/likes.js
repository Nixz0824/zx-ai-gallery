const BASE = "https://abacus.jasoncameron.dev";

export function likeKey(workId) {
  return String(workId || "work").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

export async function getLikeCount(namespace, workId) {
  const key = likeKey(workId);
  const res = await fetch(`${BASE}/get/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error("like get failed");
  const data = await res.json();
  return Number(data.value) || 0;
}

export async function addLike(namespace, workId) {
  const key = likeKey(workId);
  const res = await fetch(`${BASE}/hit/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error("like hit failed");
  const data = await res.json();
  return Number(data.value) || 0;
}

export async function getLikeCounts(namespace, workIds) {
  const entries = await Promise.all(
    workIds.map(async (id) => {
      try {
        return [id, await getLikeCount(namespace, id)];
      } catch {
        return [id, 0];
      }
    })
  );
  return Object.fromEntries(entries);
}
