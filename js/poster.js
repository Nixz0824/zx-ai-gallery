function attachOffscreen(video) {
  video.setAttribute("muted", "");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("playsinline", "");
  video.controls = false;
  video.tabIndex = -1;
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:96px",
    "height:54px",
    "opacity:0",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");
  document.body.appendChild(video);
}

function frameLooksEmpty(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return true;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const sample = ctx.getImageData(0, 0, Math.min(width, 32), Math.min(height, 32)).data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < sample.length; i += 4) {
    sum += (sample[i] + sample[i + 1] + sample[i + 2]) / 3;
    count += 1;
  }
  return count === 0 || sum / count < 8;
}

function drawFrame(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob && blob.size > 400 ? blob : null), "image/jpeg", 0.86);
  });
}

function waitFor(video, eventName, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener(eventName, finish);
      resolve();
    };
    video.addEventListener(eventName, finish);
    window.setTimeout(finish, ms);
  });
}

async function seekAndDraw(video, time) {
  const target = Math.max(0, Math.min(time, Math.max((video.duration || 1) - 0.05, 0)));
  const seekWait = waitFor(video, "seeked", 700);
  try {
    video.currentTime = target;
  } catch {
    /* some files refuse mid-seek; still try the current buffer */
  }
  await seekWait;
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      const timer = window.setTimeout(resolve, 400);
      video.requestVideoFrameCallback(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }
  const canvas = drawFrame(video);
  if (!canvas || frameLooksEmpty(canvas)) return null;
  return canvasToBlob(canvas);
}

export function captureFromVideoElement(video) {
  if (!video || video.readyState < 2) return Promise.resolve(null);
  const canvas = drawFrame(video);
  if (!canvas || frameLooksEmpty(canvas)) return Promise.resolve(null);
  return canvasToBlob(canvas);
}

export function captureVideoPoster(source) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const created = source instanceof Blob;
    const url = created ? URL.createObjectURL(source) : String(source || "");
    if (!url) {
      resolve(null);
      return;
    }
    if (!created && /^https?:/i.test(url) && !url.startsWith(location.origin)) {
      video.crossOrigin = "anonymous";
    }

    let settled = false;
    const finish = (blob) => {
      if (settled) return;
      settled = true;
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      if (created) URL.revokeObjectURL(url);
      resolve(blob || null);
    };

    const run = async () => {
      try {
        await video.play().catch(() => {});
        video.pause();
      } catch {
        /* autoplay can fail; decoded frames may still be available */
      }
      const duration = Number.isFinite(video.duration) ? video.duration : 1;
      const marks = [0, 0.04, Math.min(0.2, duration * 0.02), Math.min(0.8, duration * 0.08)];
      for (const mark of marks) {
        if (settled) return;
        const blob = await seekAndDraw(video, mark);
        if (blob) {
          finish(blob);
          return;
        }
      }
      finish(null);
    };

    attachOffscreen(video);
    video.addEventListener("error", () => finish(null));
    video.addEventListener("loadeddata", () => {
      run();
    }, { once: true });
    window.setTimeout(() => finish(null), 12000);
    video.src = url;
    video.load();
  });
}

export function blobToFile(blob, name, type) {
  if (!blob) return null;
  return new File([blob], name, { type: type || blob.type || "image/jpeg" });
}
