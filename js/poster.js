export function captureVideoPoster(source) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    const created = source instanceof Blob;
    const url = created ? URL.createObjectURL(source) : source;
    let settled = false;

    const finish = (blob) => {
      if (settled) return;
      settled = true;
      if (created) URL.revokeObjectURL(url);
      video.src = "";
      resolve(blob || null);
    };

    video.addEventListener("loadeddata", () => {
      const jump = Math.min(0.08, Math.max(0, (video.duration || 1) * 0.01));
      try {
        video.currentTime = jump;
      } catch {
        finish(null);
      }
    });
    video.addEventListener("seeked", () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        finish(null);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(video, 0, 0, width, height);
      canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.86);
    });
    video.addEventListener("error", () => finish(null));
    window.setTimeout(() => finish(null), 8000);
    video.src = url;
  });
}

export function blobToFile(blob, name, type) {
  if (!blob) return null;
  return new File([blob], name, { type: type || blob.type || "application/octet-stream" });
}
