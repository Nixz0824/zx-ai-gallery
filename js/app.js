import { STRINGS, interpolate, localized } from "./i18n.js";
import {
  fetchCatalog,
  loadLocalWorks,
  loadBlob,
  saveLocalWork,
  removeLocalWork,
  tryPersistToServer,
  tryDeleteOnServer,
  isOwnerName,
  loadLikes,
  saveLikes,
  loadLikeDelta,
  saveLikeDelta,
  loadDeleted,
  saveDeleted,
  loadLang,
  saveLang,
  loadRole,
  saveRole,
  downloadJson,
  saveDraftMeta,
  loadDraftMeta,
  clearDraftMeta,
  saveDraftBlobs,
  loadDraftBlobs,
  clearDraftBlobs,
} from "./store.js";
import { captureVideoPoster, blobToFile } from "./poster.js";
import { getLikeCount, addLike, getLikeCounts } from "./likes.js";
import {
  loadToken,
  saveToken,
  readSiteConfig,
  pagesUrl,
  checkRepo,
  publishWork,
  unpublishWork,
} from "./github.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  lang: loadLang(),
  role: loadRole(),
  cat: "image",
  works: [],
  index: 0,
  liked: loadLikes(),
  likeDelta: loadLikeDelta(),
  deleted: new Set(loadDeleted()),
  objectUrls: new Map(),
  refOpen: false,
  refIndex: 0,
  site: null,
  likeCounts: {},
  editingId: "",
};

const els = {
  doc: document.documentElement,
  title: document.querySelector("title"),
  wordmark: document.querySelector("[data-i18n='title']"),
  catImage: document.querySelector("[data-cat='image']"),
  catVideo: document.querySelector("[data-cat='video']"),
  role: document.querySelector("[data-role]"),
  langZh: document.querySelector("[data-lang='zh']"),
  langEn: document.querySelector("[data-lang='en']"),
  stage: document.querySelector(".stage"),
  media: document.querySelector(".stage-media"),
  models: document.querySelector("[data-models]"),
  prompt: document.querySelector("[data-prompt]"),
  like: document.querySelector("[data-like]"),
  likeIcon: document.querySelector("[data-like-icon]"),
  likeCount: document.querySelector("[data-like-count]"),
  spec: document.querySelector("[data-spec]"),
  pager: document.querySelector("[data-pager]"),
  refView: document.querySelector("#ref-view"),
  refViewImg: document.querySelector("#ref-view img"),
  refViewThumbs: document.querySelector("[data-ref-view-thumbs]"),
  strip: document.querySelector(".strip"),
  empty: document.querySelector(".empty"),
  emptyTitle: document.querySelector("[data-i18n='emptyTitle']"),
  emptyBody: document.querySelector("[data-i18n='emptyBody']"),
  emptyAction: document.querySelector("[data-empty-action]"),
  ownerBar: document.querySelector(".owner-bar"),
  uploadOpen: document.querySelector("[data-open-upload]"),
  editOpen: document.querySelector("[data-edit]"),
  exportBtn: document.querySelector("[data-export]"),
  leaveOwner: document.querySelector("[data-leave-owner]"),
  auth: document.querySelector("#auth"),
  authForm: document.querySelector("#auth-form"),
  authInput: document.querySelector("#github"),
  authError: document.querySelector("[data-auth-error]"),
  upload: document.querySelector("#upload"),
  uploadForm: document.querySelector("#upload-form"),
  drop: document.querySelector("[data-drop]"),
  file: document.querySelector("#file"),
  fileName: document.querySelector("[data-file-name]"),
  titleInput: document.querySelector("#work-title"),
  modelsInput: document.querySelector("#work-models"),
  chips: document.querySelector("[data-chips]"),
  promptZh: document.querySelector("#work-prompt-zh"),
  promptEn: document.querySelector("#work-prompt-en"),
  toast: document.querySelector(".toast"),
  publish: document.querySelector("#publish"),
  publishForm: document.querySelector("#publish-form"),
  publishOpen: document.querySelector("[data-publish]"),
  publishStatus: document.querySelector("[data-publish-status]"),
  tokenInput: document.querySelector("#gh-token"),
  clearToken: document.querySelector("[data-clear-token]"),
  openSite: document.querySelector("[data-open-site]"),
  likesDialog: document.querySelector("#likes"),
  likesOpen: document.querySelector("[data-likes-board]"),
  likesList: document.querySelector("[data-likes-list]"),
  refField: document.querySelector("[data-ref-field]"),
  refDrop: document.querySelector("[data-ref-drop]"),
  refFiles: document.querySelector("#ref-files"),
  refPreviews: document.querySelector("[data-ref-previews]"),
  refModeOn: document.querySelector("[data-ref-mode='on']"),
  refModeOff: document.querySelector("[data-ref-mode='off']"),
};

let pendingFile = null;
let pendingModels = [];
let pendingRefs = [];
let hasRefs = false;
let toastTimer = 0;
let skipDraftPersist = false;

function t(key, vars) {
  const table = STRINGS[state.lang] || STRINGS.zh;
  const value = table[key] || STRINGS.zh[key] || key;
  return vars ? interpolate(value, vars) : value;
}

function applyChrome() {
  document.documentElement.lang = state.lang === "en" ? "en" : "zh-Hans";
  document.title = t("docTitle");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((node) => {
    node.placeholder = t(node.dataset.i18nPh);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAria));
  });
  els.catImage.setAttribute("aria-current", state.cat === "image" ? "true" : "false");
  els.catVideo.setAttribute("aria-current", state.cat === "video" ? "true" : "false");
  els.langZh.setAttribute("aria-current", state.lang === "zh" ? "true" : "false");
  els.langEn.setAttribute("aria-current", state.lang === "en" ? "true" : "false");
  els.role.dataset.on = state.role === "owner" ? "true" : "false";
  els.role.textContent = state.role === "owner" ? t("owner") : t("viewer");
  els.ownerBar.hidden = state.role !== "owner";
  const uploadHead = document.querySelector("#upload h2");
  if (uploadHead) uploadHead.textContent = state.editingId ? t("editTitle") : t("uploadTitle");
}

function visibleWorks() {
  return state.works.filter(
    (work) => work.type === state.cat && !state.deleted.has(work.id)
  );
}

function currentWork() {
  const list = visibleWorks();
  if (!list.length) return null;
  if (state.index >= list.length) state.index = list.length - 1;
  if (state.index < 0) state.index = 0;
  return list[state.index];
}

function likesOf(work) {
  return Math.max(0, (work.likes || 0) + (state.likeDelta[work.id] || 0));
}

function srcOf(work) {
  if (state.objectUrls.has(work.id)) return state.objectUrls.get(work.id);
  return work.src;
}

function posterOf(work) {
  if (state.objectUrls.has(`${work.id}::poster`)) return state.objectUrls.get(`${work.id}::poster`);
  if (work.poster) return work.poster;
  return work.type === "image" ? srcOf(work) : "";
}

function refsOf(work) {
  return (work.refs || [])
    .map((item, i) => {
      if (typeof item === "string") {
        return { src: item, key: `${work.id}::ref::${i}` };
      }
      const key = item.key || `${work.id}::ref::${i}`;
      return { src: item.src || state.objectUrls.get(key) || "", key };
    })
    .filter((item) => item.src);
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function formatRatio(width, height) {
  const common = [
    [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3], [21, 9], [1, 1],
  ];
  const value = width / height;
  const near = common.find(([a, b]) => Math.abs(value - a / b) < 0.02);
  if (near) return `${near[0]}:${near[1]}`;
  const divisor = gcd(width, height);
  let a = Math.round(width / divisor);
  let b = Math.round(height / divisor);
  if (a > 30 || b > 30) {
    if (value > 1) return `${value.toFixed(2)}:1`;
    return `1:${(1 / value).toFixed(2)}`;
  }
  return `${a}:${b}`;
}

function applyOrient(el) {
  const width = el.naturalWidth || el.videoWidth || 0;
  const height = el.naturalHeight || el.videoHeight || 0;
  if (!width || !height) {
    if (els.spec) els.spec.textContent = "";
    return;
  }
  const ratio = width / height;
  els.stage.dataset.orient = ratio > 1.12 ? "land" : ratio < 0.88 ? "port" : "square";
  if (els.spec) {
    els.spec.textContent = interpolate(t("spec"), {
      w: width,
      h: height,
      ratio: formatRatio(width, height),
    });
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutter(fn) {
  if (reduceMotion) {
    fn();
    return;
  }
  document.documentElement.classList.add("is-shutter");
  await wait(180);
  fn();
  await wait(40);
  document.documentElement.classList.remove("is-shutter");
}

function withViewTransition(fn) {
  if (reduceMotion || !document.startViewTransition) {
    fn();
    return;
  }
  document.startViewTransition(fn);
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove("is-on"), 2800);
}

function renderStage() {
  const list = visibleWorks();
  const work = currentWork();
  applyChrome();

  if (!work) {
    els.stage.hidden = true;
    els.strip.hidden = true;
    els.empty.hidden = false;
    els.emptyAction.hidden = state.role !== "owner";
    return;
  }

  els.empty.hidden = true;
  els.stage.hidden = false;
  els.strip.hidden = false;
  els.stage.dataset.kind = work.type;
  els.stage.dataset.paused = "false";

  const src = srcOf(work);
  const poster = posterOf(work);
  const bloom = poster || src;
  const refs = refsOf(work);
  if (state.refIndex >= refs.length) state.refIndex = 0;

  const title = localized(work.title, state.lang) || t("untitled");

  const promptEn = localized(work.prompt, "en");
  const promptZh = localized(work.prompt, "zh");
  const showRails = Boolean(promptEn || promptZh);
  els.stage.dataset.rails = showRails ? "true" : "false";

  const plateMedia = work.type === "video"
    ? `<video class="plate-media" src="${src}" poster="${poster}" playsinline muted loop autoplay></video>
       <button class="play" type="button" data-toggle-play aria-label="${t("pause")}">${icon("pause")}</button>`
    : `<img class="plate-media" src="${src}" alt="${title}">`;

  const rail = (side, text) => showRails
    ? `<aside class="prompt-rail" data-side="${side}"><div class="prompt-rail__body">${escapeHtml(text)}</div></aside>`
    : "";

  els.media.innerHTML = `
    <div class="bloom" aria-hidden="true"><img src="${bloom}" alt=""></div>
    <div class="stage-planes">
      ${rail("en", promptEn)}
      <div class="plate">
        <button class="hit prev" type="button" data-prev aria-label="${t("prev")}"></button>
        ${plateMedia}
        <button class="hit next" type="button" data-next aria-label="${t("next")}"></button>
      </div>
      ${rail("zh", promptZh)}
    </div>
  `;

  const main = els.media.querySelector(".plate-media");
  if (main) {
    const sync = () => {
      applyOrient(main);
      syncPromptRails();
    };
    main.addEventListener("load", sync);
    main.addEventListener("loadedmetadata", sync);
    main.addEventListener("resize", sync);
    if (main.complete || main.readyState >= 1) sync();
  }
  window.requestAnimationFrame(syncPromptRails);

  if (work.type === "video") {
    const video = els.media.querySelector(".plate video");
    video.play().catch(() => {
      els.stage.dataset.paused = "true";
      const btn = els.media.querySelector("[data-toggle-play]");
      if (btn) {
        btn.innerHTML = icon("play");
        btn.setAttribute("aria-label", t("play"));
      }
    });
  }

  els.models.textContent = (work.models || []).join("  ");
  const liked = Boolean(state.liked[work.id]);
  els.like.setAttribute("aria-pressed", liked ? "true" : "false");
  els.like.setAttribute("aria-label", t("like"));
  els.likeIcon.innerHTML = icon(liked ? "heart-fill" : "heart");
  const count = state.likeCounts[work.id];
  els.likeCount.textContent = count == null ? "" : String(count);
  refreshLikeCount(work.id);
  els.pager.textContent = interpolate(t("countOf"), {
    n: String(state.index + 1).padStart(2, "0"),
    total: String(list.length).padStart(2, "0"),
  });

  const refDock = refs.length
    ? `<div class="ref-dock">${refs.map((item, i) => `
        <button type="button" data-open-ref="${i}" aria-label="${t("refLabel")} ${i + 1}">
          <img src="${item.src}" alt="">
        </button>
      `).join("")}</div><span class="dock-rule" aria-hidden="true"></span>`
    : "";

  els.strip.innerHTML = refDock + list
    .map((item, i) => {
      const current = i === state.index;
      const thumb = posterOf(item) || srcOf(item);
      return `
        <button class="thumb" type="button" data-index="${i}" aria-current="${current}" aria-label="${localized(item.title, state.lang) || t("untitled")}">
          <img src="${thumb}" alt="">
        </button>
      `;
    })
    .join("");

  const active = els.strip.querySelector("[aria-current='true']");
  if (active) {
    active.scrollIntoView({ inline: "center", block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }
  fillMissingPosters(list);
}

function syncPromptRails() {
  const mediaEl = els.media.querySelector(".plate-media");
  const rails = els.media.querySelectorAll(".prompt-rail");
  if (!mediaEl || !rails.length) return;
  const height = Math.round(mediaEl.getBoundingClientRect().height);
  if (!height) return;
  rails.forEach((rail) => {
    rail.style.setProperty("--rail-h", `${height}px`);
    rail.style.height = `${height}px`;
  });
}

async function fillMissingPosters(list) {
  for (const item of list) {
    if (item.type !== "video") continue;
    if (posterOf(item)) continue;
    const src = srcOf(item);
    if (!src) continue;
    const blob = await captureVideoPoster(src);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    state.objectUrls.set(`${item.id}::poster`, url);
    item.poster = url;
    const thumb = els.strip.querySelector(`[data-index] img`);
    const index = list.indexOf(item);
    const button = els.strip.querySelector(`[data-index="${index}"] img`);
    if (button) button.src = url;
  }
}

function goTo(index, { shutterChange = false } = {}) {
  const list = visibleWorks();
  if (!list.length) {
    renderStage();
    return;
  }
  const next = (index + list.length) % list.length;
  const apply = () => {
    state.index = next;
    state.refOpen = false;
    state.refIndex = 0;
    if (els.refView.open) els.refView.close();
    renderStage();
  };
  if (shutterChange) shutter(apply);
  else withViewTransition(apply);
}

async function refreshLikeCount(workId) {
  if (!state.site || state.likeCounts[workId] != null) return;
  try {
    state.likeCounts[workId] = await getLikeCount(state.site.likesNamespace, workId);
  } catch {
    state.likeCounts[workId] = 0;
  }
  const work = currentWork();
  if (work && work.id === workId && els.likeCount) {
    els.likeCount.textContent = String(state.likeCounts[workId]);
  }
}

async function toggleLike() {
  const work = currentWork();
  if (!work || !state.site) return;
  if (state.liked[work.id]) return;
  state.liked[work.id] = true;
  saveLikes(state.liked);
  els.like.setAttribute("aria-pressed", "true");
  els.likeIcon.innerHTML = icon("heart-fill");
  try {
    state.likeCounts[work.id] = await addLike(state.site.likesNamespace, work.id);
  } catch {
    state.likeCounts[work.id] = (state.likeCounts[work.id] || 0) + 1;
  }
  els.likeCount.textContent = String(state.likeCounts[work.id]);
}

function setCat(cat) {
  if (state.cat === cat) return;
  shutter(() => {
    state.cat = cat;
    state.index = 0;
    renderStage();
  });
}

function setLang(lang) {
  if (state.lang === lang) return;
  state.lang = lang;
  saveLang(lang);
  renderStage();
}

function openAuth() {
  els.authError.textContent = "";
  els.authInput.value = "";
  els.auth.showModal();
  els.authInput.focus();
}

function enterOwner() {
  state.role = "owner";
  saveRole("owner");
  els.auth.close();
  renderStage();
}

function leaveOwner() {
  state.role = "viewer";
  saveRole("viewer");
  els.upload.close();
  renderStage();
}

function openRefView(index) {
  const refs = currentWork() ? refsOf(currentWork()) : [];
  if (!refs.length) return;
  state.refOpen = true;
  state.refIndex = (index + refs.length) % refs.length;
  const current = refs[state.refIndex];
  els.refViewImg.src = current.src;
  els.refViewImg.alt = `${t("refLabel")} ${state.refIndex + 1}`;
  els.refViewThumbs.innerHTML = refs.map((item, i) => `
    <button type="button" data-open-ref="${i}" aria-current="${i === state.refIndex}" aria-label="${t("refLabel")} ${i + 1}">
      <img src="${item.src}" alt="">
    </button>
  `).join("");
  if (!els.refView.open) els.refView.showModal();
}

function closeRefView() {
  state.refOpen = false;
  if (els.refView.open) els.refView.close();
}

function stepRef(delta) {
  const refs = currentWork() ? refsOf(currentWork()) : [];
  if (!refs.length) return;
  openRefView(state.refIndex + delta);
}

function togglePlay() {
  const video = els.media.querySelector(".plate video");
  if (!video) return;
  if (video.paused) {
    video.play();
    els.stage.dataset.paused = "false";
    const btn = els.media.querySelector("[data-toggle-play]");
    btn.innerHTML = icon("pause");
    btn.setAttribute("aria-label", t("pause"));
  } else {
    video.pause();
    els.stage.dataset.paused = "true";
    const btn = els.media.querySelector("[data-toggle-play]");
    btn.innerHTML = icon("play");
    btn.setAttribute("aria-label", t("play"));
  }
}

function renderChips() {
  els.chips.innerHTML = pendingModels
    .map(
      (name, i) => `
      <span class="chip">${escapeHtml(name)}
        <button type="button" data-remove-model="${i}" aria-label="${t("delete")}">×</button>
      </span>`
    )
    .join("");
}

function addModelFromInput() {
  const value = els.modelsInput.value.trim();
  if (!value) return;
  if (!pendingModels.includes(value)) pendingModels.push(value);
  els.modelsInput.value = "";
  renderChips();
}

function setRefMode(on) {
  hasRefs = on;
  els.refModeOn.setAttribute("aria-pressed", on ? "true" : "false");
  els.refModeOff.setAttribute("aria-pressed", on ? "false" : "true");
  els.refField.hidden = !on;
  if (!on) {
    pendingRefs.forEach((item) => URL.revokeObjectURL(item.url));
    pendingRefs = [];
    renderRefPreviews();
  }
}

function addRefFiles(fileList) {
  [...fileList].forEach((file) => {
    if (!file.type.startsWith("image/")) return;
    pendingRefs.push({ file, url: URL.createObjectURL(file) });
  });
  renderRefPreviews();
}

function renderRefPreviews() {
  els.refPreviews.innerHTML = pendingRefs
    .map((item, i) => `
      <figure>
        <img src="${item.url}" alt="">
        <button type="button" data-remove-ref="${i}" aria-label="${t("delete")}">×</button>
      </figure>
    `)
    .join("");
}

function resetUpload() {
  pendingFile = null;
  pendingModels = [];
  pendingRefs.forEach((item) => URL.revokeObjectURL(item.url));
  pendingRefs = [];
  els.uploadForm.reset();
  els.fileName.textContent = "";
  renderChips();
  setRefMode(false);
  state.editingId = "";
}

async function persistDraft() {
  saveDraftMeta({
    editingId: state.editingId,
    title: els.titleInput.value,
    models: pendingModels,
    promptZh: els.promptZh.value,
    promptEn: els.promptEn.value,
    hasRefs,
    fileName: pendingFile ? pendingFile.name : "",
    fileType: pendingFile ? pendingFile.type : "",
  });
  if (!state.editingId) {
    await saveDraftBlobs(pendingFile, pendingRefs.map((item) => item.file));
  }
}

async function applyDraftFields(meta, blobs) {
  pendingModels = Array.isArray(meta?.models) ? meta.models : [];
  els.titleInput.value = meta?.title || "";
  els.promptZh.value = meta?.promptZh || "";
  els.promptEn.value = meta?.promptEn || "";
  renderChips();
  setRefMode(Boolean(meta?.hasRefs));
  if (blobs?.file && blobs.file.blob) {
    pendingFile = blobToFile(blobs.file.blob, blobs.file.name || meta?.fileName || "work", blobs.file.type || meta?.fileType);
    els.fileName.textContent = pendingFile.name;
  }
  pendingRefs.forEach((item) => URL.revokeObjectURL(item.url));
  pendingRefs = (blobs?.refs || []).map((rec) => ({
    file: blobToFile(rec.blob, rec.name || "ref.jpg", rec.type),
    url: URL.createObjectURL(rec.blob),
  }));
  renderRefPreviews();
}

async function restoreDraft() {
  const meta = loadDraftMeta();
  const blobs = await loadDraftBlobs();
  if (meta?.editingId) {
    const work = state.works.find((item) => item.id === meta.editingId);
    if (work) {
      openEditor(work);
      await applyDraftFields(meta, { file: blobs.file, refs: [] });
      return;
    }
  }
  resetUpload();
  if (!meta && !blobs.file) return;
  await applyDraftFields(meta, blobs);
}

function openEditor(work) {
  resetUpload();
  state.editingId = work.id;
  els.titleInput.value = localized(work.title, "zh") || localized(work.title, "en");
  pendingModels = [...(work.models || [])];
  els.promptZh.value = localized(work.prompt, "zh");
  els.promptEn.value = localized(work.prompt, "en");
  els.fileName.textContent = t("keepFile");
  renderChips();
  setRefMode(refsOf(work).length > 0);
  els.upload.showModal();
}

async function handleUpload(event) {
  event.preventDefault();
  addModelFromInput();
  const title = els.titleInput.value.trim();
  const prompt = {
    zh: els.promptZh.value.trim(),
    en: els.promptEn.value.trim(),
  };
  const refFiles = hasRefs ? pendingRefs.map((item) => item.file) : [];
  const existing = state.editingId
    ? state.works.find((item) => item.id === state.editingId)
    : null;

  if (!existing && !pendingFile) {
    toast(t("needFile"));
    return;
  }

  const sourceFile = pendingFile;
  const isVideo = sourceFile
    ? sourceFile.type.startsWith("video/")
    : existing?.type === "video";
  let posterFile = null;
  if (sourceFile && isVideo) {
    posterFile = blobToFile(await captureVideoPoster(sourceFile), "poster.jpg", "image/jpeg");
  }

  const workId = existing ? existing.id : crypto.randomUUID();
  const work = existing || {
    id: workId,
    createdAt: new Date().toISOString().slice(0, 10),
    likes: 0,
  };

  work.type = sourceFile ? (isVideo ? "video" : "image") : (existing.type || "image");
  work.title = { zh: title, en: title };
  work.models = [...pendingModels];
  work.prompt = prompt;
  work.local = true;
  if (sourceFile) work.filename = sourceFile.name;
  if (refFiles.length) {
    work.refs = refFiles.map((_, i) => ({ key: `${workId}::ref::${i}` }));
  } else if (!hasRefs) {
    work.refs = [];
  }

  await saveLocalWork(work, sourceFile, refFiles, posterFile);
  if (sourceFile) {
    if (state.objectUrls.has(work.id)) URL.revokeObjectURL(state.objectUrls.get(work.id));
    state.objectUrls.set(work.id, URL.createObjectURL(sourceFile));
  }
  if (posterFile) {
    const posterUrl = URL.createObjectURL(posterFile);
    state.objectUrls.set(`${work.id}::poster`, posterUrl);
    work.poster = posterUrl;
  }
  refFiles.forEach((file, i) => {
    state.objectUrls.set(`${workId}::ref::${i}`, URL.createObjectURL(file));
  });
  if (!existing) state.works.unshift(work);

  const remote = await tryPersistToServer(work, sourceFile, refFiles, posterFile);
  if (remote.ok && remote.remote && remote.remote.src) {
    work.src = remote.remote.src;
    work.poster = remote.remote.poster || work.poster;
    if (remote.remote.refs) work.refs = remote.remote.refs;
    work.local = false;
  }

  const token = loadToken();
  let published = false;
  if (token && state.site) {
    try {
      const remoteWork = await publishWork(state.site, token, work, sourceFile, refFiles, posterFile);
      Object.assign(work, remoteWork);
      work.local = false;
      published = true;
    } catch (error) {
      toast(String(error.message || "").includes("80MB") ? t("fileTooBig") : t("publishFail"));
    }
  }

  state.cat = work.type;
  if (!existing) state.index = 0;
  skipDraftPersist = true;
  els.upload.close();
  resetUpload();
  await clearDraftBlobs();
  clearDraftMeta();
  skipDraftPersist = false;
  if (published) toast(t("published"));
  else toast(existing ? t("savedEdit") : t("saved"));
  renderStage();
}

async function deleteCurrent() {
  const work = currentWork();
  if (!work || state.role !== "owner") return;
  state.deleted.add(work.id);
  saveDeleted([...state.deleted]);
  if (work.local) await removeLocalWork(work.id);
  await tryDeleteOnServer(work.id);
  const token = loadToken();
  if (token && state.site) {
    try {
      await unpublishWork(state.site, token, work.id);
    } catch {
      /* keep local delete even if GitHub write fails */
    }
  }
  if (state.objectUrls.has(work.id)) {
    URL.revokeObjectURL(state.objectUrls.get(work.id));
    state.objectUrls.delete(work.id);
  }
  toast(t("deleted"));
  renderStage();
}

function exportList() {
  const works = state.works
    .filter((work) => !state.deleted.has(work.id))
    .map((work) => ({
      id: work.id,
      type: work.type,
      src: work.src || "",
      poster: work.poster || "",
      title: work.title,
      models: work.models,
      prompt: work.prompt,
      createdAt: work.createdAt,
      likes: likesOf(work),
      refs: (work.refs || []).map((item) => (typeof item === "string" ? item : item.src || "")).filter(Boolean),
    }));
  downloadJson("works.json", { works });
}

function bind() {
  els.catImage.addEventListener("click", () => setCat("image"));
  els.catVideo.addEventListener("click", () => setCat("video"));
  els.langZh.addEventListener("click", () => setLang("zh"));
  els.langEn.addEventListener("click", () => setLang("en"));
  els.role.addEventListener("click", () => {
    if (state.role === "owner") leaveOwner();
    else openAuth();
  });
  els.like.addEventListener("click", toggleLike);
  els.refView.addEventListener("click", (event) => {
    if (event.target === els.refView) closeRefView();
    const thumb = event.target.closest("[data-open-ref]");
    if (thumb) openRefView(Number(thumb.dataset.openRef));
  });
  document.querySelector("[data-close-ref]").addEventListener("click", closeRefView);
  document.querySelector("[data-ref-prev]").addEventListener("click", () => stepRef(-1));
  document.querySelector("[data-ref-next]").addEventListener("click", () => stepRef(1));
  els.refView.addEventListener("close", () => {
    state.refOpen = false;
  });
  els.uploadOpen.addEventListener("click", async () => {
    await restoreDraft();
    els.upload.showModal();
  });
  els.editOpen.addEventListener("click", () => {
    const work = currentWork();
    if (work) openEditor(work);
  });
  els.exportBtn.addEventListener("click", exportList);
  els.leaveOwner.addEventListener("click", leaveOwner);
  els.publishOpen.addEventListener("click", openPublish);
  els.publishForm.addEventListener("submit", savePublish);
  els.clearToken.addEventListener("click", () => {
    saveToken("");
    els.tokenInput.value = "";
    updatePublishStatus();
  });
  els.likesOpen.addEventListener("click", openLikesBoard);
  els.emptyAction.addEventListener("click", async () => {
    if (state.role !== "owner") return;
    await restoreDraft();
    els.upload.showModal();
  });

  els.stage.addEventListener("click", (event) => {
    if (event.target.closest("[data-prev]")) goTo(state.index - 1);
    if (event.target.closest("[data-next]")) goTo(state.index + 1);
    if (event.target.closest("[data-toggle-play]")) togglePlay();
    const refThumb = event.target.closest("[data-open-ref]");
    if (refThumb) openRefView(Number(refThumb.dataset.openRef));
  });

  els.strip.addEventListener("click", (event) => {
    const refThumb = event.target.closest("[data-open-ref]");
    if (refThumb) {
      openRefView(Number(refThumb.dataset.openRef));
      return;
    }
    const thumb = event.target.closest("[data-index]");
    if (!thumb) return;
    goTo(Number(thumb.dataset.index));
  });

  els.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (isOwnerName(els.authInput.value)) enterOwner();
    else els.authError.textContent = t("authError");
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest("dialog").close());
  });
  [els.auth, els.upload, els.publish, els.likesDialog, els.refView].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  els.uploadForm.addEventListener("submit", handleUpload);
  els.upload.addEventListener("close", () => {
    if (!skipDraftPersist) persistDraft();
  });
  ["input", "change"].forEach((type) => {
    els.uploadForm.addEventListener(type, () => persistDraft());
  });
  els.file.addEventListener("change", () => {
    pendingFile = els.file.files[0] || null;
    els.fileName.textContent = pendingFile ? pendingFile.name : "";
    persistDraft();
  });
  els.drop.addEventListener("click", () => els.file.click());
  els.drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.drop.classList.add("is-over");
  });
  els.drop.addEventListener("dragleave", () => els.drop.classList.remove("is-over"));
  els.drop.addEventListener("drop", (event) => {
    event.preventDefault();
    els.drop.classList.remove("is-over");
    const file = event.dataTransfer.files[0];
    if (!file) return;
    pendingFile = file;
    els.fileName.textContent = file.name;
  });
  els.modelsInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addModelFromInput();
    }
  });
  els.chips.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-remove-model]");
    if (!btn) return;
    pendingModels.splice(Number(btn.dataset.removeModel), 1);
    renderChips();
  });

  els.refModeOn.addEventListener("click", () => setRefMode(true));
  els.refModeOff.addEventListener("click", () => setRefMode(false));
  els.refFiles.addEventListener("change", () => {
    addRefFiles(els.refFiles.files);
    els.refFiles.value = "";
  });
  els.refDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.refDrop.classList.add("is-over");
  });
  els.refDrop.addEventListener("dragleave", () => els.refDrop.classList.remove("is-over"));
  els.refDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    els.refDrop.classList.remove("is-over");
    addRefFiles(event.dataTransfer.files);
  });
  els.refPreviews.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-remove-ref]");
    if (!btn) return;
    const index = Number(btn.dataset.removeRef);
    URL.revokeObjectURL(pendingRefs[index].url);
    pendingRefs.splice(index, 1);
    renderRefPreviews();
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea")) return;
    if (state.refOpen) {
      if (event.key === "ArrowLeft") stepRef(-1);
      if (event.key === "ArrowRight") stepRef(1);
      return;
    }
    if (event.key === "ArrowLeft") goTo(state.index - 1);
    if (event.key === "ArrowRight") goTo(state.index + 1);
    if (event.key === "l" || event.key === "L") toggleLike();
    if (event.key === "r" || event.key === "R") openRefView(0);
    if (event.key === " ") {
      event.preventDefault();
      togglePlay();
    }
    if (event.key === "Escape") {
      if (els.upload.open) els.upload.close();
      else if (els.auth.open) els.auth.close();
      else if (els.publish.open) els.publish.close();
      else if (els.likesDialog.open) els.likesDialog.close();
      else if (state.refOpen) closeRefView();
    }
  });

  let touchX = 0;
  els.stage.addEventListener("touchstart", (event) => {
    touchX = event.changedTouches[0].clientX;
  }, { passive: true });
  els.stage.addEventListener("touchend", (event) => {
    if (event.target.closest(".prompt-rail")) return;
    const dx = event.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) < 48) return;
    goTo(state.index + (dx < 0 ? 1 : -1));
  }, { passive: true });
  window.addEventListener("resize", syncPromptRails);

  document.querySelector("[data-delete]").addEventListener("click", deleteCurrent);
}

function applyQuery() {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang");
  const cat = params.get("cat");
  if (lang === "en" || lang === "zh") {
    state.lang = lang;
    saveLang(lang);
  }
  if (cat === "video" || cat === "image") state.cat = cat;
  state.wantedId = params.get("id") || "";
  if (params.get("refs") === "1") state.refOpen = true;
}

function updatePublishStatus(message) {
  if (!els.publishStatus || !state.site) return;
  els.publishStatus.textContent = message || (loadToken() ? t("tokenOk") : t("tokenNeed"));
  if (els.openSite) els.openSite.href = pagesUrl(state.site);
}

function openPublish() {
  els.tokenInput.value = loadToken();
  updatePublishStatus();
  els.publish.showModal();
}

async function savePublish(event) {
  event.preventDefault();
  const token = els.tokenInput.value.trim();
  saveToken(token);
  if (!token || !state.site) {
    updatePublishStatus(t("tokenNeed"));
    return;
  }
  try {
    await checkRepo(state.site, token);
    updatePublishStatus(t("tokenOk"));
    toast(t("tokenOk"));
  } catch {
    updatePublishStatus(t("tokenBad"));
  }
}

async function openLikesBoard() {
  const works = state.works.filter((work) => !state.deleted.has(work.id));
  els.likesList.innerHTML = works
    .map((work) => `
      <div class="likes-row">
        <span>${escapeHtml(localized(work.title, state.lang) || t("untitled"))}</span>
        <strong data-like-row="${work.id}">${state.likeCounts[work.id] == null ? "…" : state.likeCounts[work.id]}</strong>
      </div>
    `)
    .join("") || `<p class="preview-name">${t("likesEmpty")}</p>`;
  els.likesDialog.showModal();
  if (!state.site) return;
  const counts = await getLikeCounts(state.site.likesNamespace, works.map((work) => work.id));
  state.likeCounts = { ...state.likeCounts, ...counts };
  works.forEach((work) => {
    const cell = els.likesList.querySelector(`[data-like-row="${work.id}"]`);
    if (cell) cell.textContent = String(state.likeCounts[work.id] || 0);
  });
}

async function hydrate() {
  applyQuery();
  try {
    state.site = await readSiteConfig();
  } catch {
    state.site = null;
  }
  const [catalog, local] = await Promise.all([fetchCatalog(), loadLocalWorks()]);
  const merged = new Map();
  catalog.forEach((work) => merged.set(work.id, work));
  for (const work of local) {
    merged.set(work.id, work);
    if (!work.src) {
      const blob = await loadBlob(work.id);
      if (blob) state.objectUrls.set(work.id, URL.createObjectURL(blob));
    }
    const posterBlob = await loadBlob(`${work.id}::poster`);
    if (posterBlob) state.objectUrls.set(`${work.id}::poster`, URL.createObjectURL(posterBlob));
    const localRefs = work.refs || [];
    for (let i = 0; i < localRefs.length; i += 1) {
      const item = localRefs[i];
      if (typeof item === "string") continue;
      const key = item.key || `${work.id}::ref::${i}`;
      if (item.src) continue;
      const blob = await loadBlob(key);
      if (blob) state.objectUrls.set(key, URL.createObjectURL(blob));
    }
  }
  state.works = [...merged.values()].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
  if (state.wantedId) {
    const list = visibleWorks();
    const found = list.findIndex((work) => work.id === state.wantedId);
    if (found >= 0) state.index = found;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function icon(name) {
  const paths = {
    heart: '<path fill="currentColor" d="M178 40c-20.65 0-38.73 8.88-50 23.89C116.73 48.88 98.65 40 78 40a62.07 62.07 0 0 0-62 62c0 70 103.79 126.67 108.21 129a8 8 0 0 0 7.58 0C136.21 228.67 240 172 240 102a62.07 62.07 0 0 0-62-62Zm-50 174.8C109.74 204.16 32 155.69 32 102A46.06 46.06 0 0 1 78 56c19.45 0 35.78 10.36 42.6 27a8 8 0 0 0 14.8 0c6.82-16.67 23.15-27 42.6-27a46.06 46.06 0 0 1 46 46c0 53.61-77.76 102.13-96 112.8Z"/>',
    "heart-fill": '<path fill="currentColor" d="M240 102c0 70-103.79 126.66-108.21 129a8 8 0 0 1-7.58 0C119.79 228.66 16 172 16 102a62.07 62.07 0 0 1 62-62c20.65 0 38.73 8.88 50 23.89C139.27 48.88 157.35 40 178 40a62.07 62.07 0 0 1 62 62Z"/>',
    play: '<path fill="currentColor" d="M80 64.5v127l104-63.5Z"/>',
    pause: '<path fill="currentColor" d="M80 56h32v144H80Zm64 0h32v144h-32Z"/>',
  };
  return `<svg viewBox="0 0 256 256" aria-hidden="true">${paths[name]}</svg>`;
}

bind();
hydrate().then(renderStage);
