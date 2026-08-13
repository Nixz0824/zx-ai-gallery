#!/usr/bin/env python3
"""Local persist server for NIX.

Serves the static site and writes uploaded works into media/ plus data/works.json.
Run from this folder:

    python server.py
"""

from __future__ import annotations

import json
import re
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "works.json"
MEDIA = ROOT / "media"
OWNER = "nixz0824"


def load_works() -> list[dict]:
    if not DATA.exists():
        return []
    payload = json.loads(DATA.read_text(encoding="utf-8"))
    return list(payload.get("works") or [])


def save_works(works: list[dict]) -> None:
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps({"works": works}, ensure_ascii=False, indent=2), encoding="utf-8")


def extract_poster(video_path: Path, dest: Path) -> bool:
    """Grab the first usable frame. Optional: needs PyAV if the browser poster failed."""
    try:
        import av
    except ImportError:
        return False
    if not video_path.exists():
        return False
    try:
        container = av.open(str(video_path))
        stream = next((item for item in container.streams if item.type == "video"), None)
        if stream is None:
            container.close()
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        saved = False
        for index, frame in enumerate(container.decode(stream)):
            image = frame.to_image().convert("RGB")
            sample = image.resize((24, 24)).convert("L")
            avg = sum(sample.getdata()) / 576
            if avg > 10 or index >= 24:
                image.save(dest, "JPEG", quality=86)
                saved = dest.exists() and dest.stat().st_size > 400
                break
        container.close()
        return saved
    except Exception:
        return False


def stored_media_path(value) -> bool:
    text = str(value or "")
    return bool(text) and not text.startswith("blob:") and not text.startswith("data:")


def safe_name(name: str) -> str:
    stem = Path(name).name
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-")
    return stem or f"work-{uuid.uuid4().hex[:8]}"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/works":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            self.send_error(400, "multipart required")
            return
        boundary = None
        for part in ctype.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part.split("=", 1)[1].strip('"')
        if not boundary:
            self.send_error(400, "missing boundary")
            return
        fields, files = parse_multipart(body, boundary.encode())
        meta_raw = fields.get("meta", b"").decode("utf-8")
        try:
            meta = json.loads(meta_raw)
        except json.JSONDecodeError:
            self.send_error(400, "bad meta")
            return

        work_id = meta.get("id") or uuid.uuid4().hex
        existing_work = next((item for item in load_works() if item.get("id") == work_id), {}) or {}
        work_type = "video" if meta.get("type") == "video" else existing_work.get("type") or "image"
        folder = MEDIA / ("videos" if work_type == "video" else "images")
        folder.mkdir(parents=True, exist_ok=True)
        uploads = files.get("file") or []
        upload = uploads[0] if uploads else None
        src = existing_work.get("src") or ""
        if stored_media_path(meta.get("src")):
            src = meta.get("src")
        if upload:
            filename = safe_name(upload["filename"])
            dest = folder / filename
            if dest.exists():
                dest = folder / f"{dest.stem}-{uuid.uuid4().hex[:6]}{dest.suffix}"
            dest.write_bytes(upload["content"])
            src = dest.relative_to(ROOT).as_posix()

        ref_dir = MEDIA / "refs"
        ref_dir.mkdir(parents=True, exist_ok=True)
        refs = []
        for item in files.get("refs") or []:
            filename = safe_name(item["filename"])
            dest = ref_dir / filename
            if dest.exists():
                dest = ref_dir / f"{dest.stem}-{uuid.uuid4().hex[:6]}{dest.suffix}"
            dest.write_bytes(item["content"])
            refs.append(dest.relative_to(ROOT).as_posix())
        if not refs:
            incoming = meta.get("refs") or []
            refs = [item if isinstance(item, str) else (item or {}).get("src") for item in incoming]
            refs = [item for item in refs if stored_media_path(item)]
        if not refs:
            refs = list(existing_work.get("refs") or [])
        poster_path = existing_work.get("poster") or ""
        if stored_media_path(meta.get("poster")):
            poster_path = meta.get("poster")
        posters = files.get("poster") or []
        if posters:
            poster_dir = MEDIA / "posters"
            poster_dir.mkdir(parents=True, exist_ok=True)
            dest = poster_dir / f"{work_id}.jpg"
            dest.write_bytes(posters[0]["content"])
            poster_path = dest.relative_to(ROOT).as_posix()
        if work_type == "video" and not poster_path and src:
            poster_dir = MEDIA / "posters"
            dest = poster_dir / f"{work_id}.jpg"
            if extract_poster(ROOT / src, dest):
                poster_path = dest.relative_to(ROOT).as_posix()

        work = {
            "id": work_id,
            "type": work_type,
            "src": src,
            "poster": poster_path,
            "title": meta.get("title") or existing_work.get("title") or "",
            "models": meta.get("models") if meta.get("models") is not None else existing_work.get("models") or [],
            "prompt": meta.get("prompt") or existing_work.get("prompt") or "",
            "createdAt": meta.get("createdAt") or existing_work.get("createdAt") or "",
            "likes": int(meta.get("likes") if meta.get("likes") is not None else existing_work.get("likes") or 0),
            "refs": refs,
        }
        works = [item for item in load_works() if item.get("id") != work["id"]]
        works.insert(0, work)
        save_works(works)
        self._json(200, work)

    def do_DELETE(self):
        if not self.path.startswith("/api/works/"):
            self.send_error(404)
            return
        work_id = unquote(self.path.rsplit("/", 1)[-1])
        works = load_works()
        keep = [item for item in works if item.get("id") != work_id]
        save_works(keep)
        self._json(200, {"ok": True, "id": work_id})

    def _json(self, code: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def parse_multipart(body: bytes, boundary: bytes):
    fields: dict[str, bytes] = {}
    files: dict[str, list[dict]] = {}
    parts = body.split(b"--" + boundary)
    for part in parts:
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        header_blob, _, content = part.partition(b"\r\n\r\n")
        if content.endswith(b"\r\n"):
            content = content[:-2]
        headers = header_blob.decode("utf-8", "replace")
        name = ""
        filename = ""
        for line in headers.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                for item in line.split(";"):
                    item = item.strip()
                    if item.startswith("name="):
                        name = item.split("=", 1)[1].strip('"')
                    if item.startswith("filename="):
                        filename = item.split("=", 1)[1].strip('"')
        if not name:
            continue
        if filename:
            files.setdefault(name, []).append({"filename": filename, "content": content})
        else:
            fields[name] = content
    return fields, files


def main():
    MEDIA.joinpath("images").mkdir(parents=True, exist_ok=True)
    MEDIA.joinpath("videos").mkdir(parents=True, exist_ok=True)
    MEDIA.joinpath("refs").mkdir(parents=True, exist_ok=True)
    MEDIA.joinpath("posters").mkdir(parents=True, exist_ok=True)
    DATA.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("ZHANG XIN  http://127.0.0.1:8765")
    print("Owner gate uses GitHub name, case-insensitive.")
    server.serve_forever()


if __name__ == "__main__":
    main()
