// Small dependency-free helpers shared across providers.

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { resolve, dirname, isAbsolute, extname } from "node:path";

const jwtCache = new Map();

export function decodeJwt(jwt) {
  if (!jwt || typeof jwt !== "string") return null;
  if (jwtCache.has(jwt)) return jwtCache.get(jwt);
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    if (jwtCache.size >= 128) jwtCache.clear();
    jwtCache.set(jwt, payload);
    return payload;
  } catch {
    return null;
  }
}

export function jwtExpiryMs(jwt) {
  const p = decodeJwt(jwt);
  return p?.exp ? p.exp * 1000 : null;
}

// The OAuth client id an account's tokens were issued for. Deriving it from the
// token itself means we never depend on a hardcoded id staying correct.
export function jwtClientId(jwt) {
  const p = decodeJwt(jwt);
  if (!p) return null;
  const aud = Array.isArray(p.aud) ? p.aud.find((a) => typeof a === "string" && a.startsWith("app_")) : p.aud;
  if (typeof aud === "string" && aud.startsWith("app_")) return aud;
  if (typeof p.client_id === "string" && p.client_id.startsWith("app_")) return p.client_id;
  return null;
}

export function detectImageMime(buf) {
  if (!buf || buf.length < 3) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  if (b0 === 0xff && b1 === 0xd8) return "image/jpeg";
  if (b0 === 0x89 && b1 === 0x50 && buf.length >= 8) return "image/png";
  if (
    b0 === 0x52 &&
    b1 === 0x49 &&
    buf.length >= 12 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    b0 === 0x47 &&
    b1 === 0x49 &&
    buf.length >= 6 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  return null;
}

export function extForMime(mime) {
  return { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" }[mime] || ".png";
}

// Never overwrite: out.png -> out-v2.png -> out-v3.png ...
export function freePath(requested) {
  if (!existsSync(requested)) return requested;
  const ext = extname(requested);
  const base = ext ? requested.slice(0, -ext.length) : requested;
  const candidateExt = ext || ".png";
  for (let v = 2; v <= 9999; v++) {
    const candidate = `${base}-v${v}${candidateExt}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find a free filename near ${requested}`);
}

export function saveImage(out, buf, cwd = process.cwd(), { force = false } = {}) {
  const requested = isAbsolute(out) ? out : resolve(cwd, out);
  mkdirSync(dirname(requested), { recursive: true });
  const finalPath = force ? requested : freePath(requested);
  writeFileSync(finalPath, buf);
  return { savedPath: finalPath, requestedPath: requested, versioned: finalPath !== requested };
}

export function slugify(text, maxLen = 32) {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return clean || "image";
}

export function batchVariantPath(requested, index, total) {
  const originalExt = extname(requested);
  const ext = originalExt || ".png";
  const base = originalExt ? requested.slice(0, -originalExt.length) : requested;
  const pad = total >= 10 ? String(total).length : 1;
  const num = String(index).padStart(pad, "0");
  return `${base}-${num}${ext}`;
}

export function batchItemPath(outDir, index, total, prompt = "", customOut = null) {
  if (customOut) return resolve(outDir, customOut);
  const pad = total >= 10 ? String(total).length : 2;
  const num = String(index).padStart(pad, "0");
  const slug = slugify(prompt);
  return resolve(outDir, `${num}-${slug}.png`);
}

// An MCP caller supplies reference-image paths, and the whole file is read into
// memory before being base64'd. Without a cap a huge file (or a special file
// like /dev/zero, which has no EOF) would hang or OOM the server.
export const MAX_REF_IMAGE_BYTES = 20 * 1024 * 1024;

export function readImageAsDataUrl(filePath, cwd = process.cwd()) {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const fd = openSync(abs, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
    if (st.size > MAX_REF_IMAGE_BYTES) {
      throw new Error(`reference image too large (${Math.round(st.size / 1048576)}MB; limit ${MAX_REF_IMAGE_BYTES / 1048576}MB): ${abs}`);
    }
  } finally {
    closeSync(fd);
  }
  const buf = readFileSync(abs);
  const mime = detectImageMime(buf);
  if (!mime) throw new Error(`unsupported reference image type: ${abs}`);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Same validation as readImageAsDataUrl, same errors, but reads only the magic
// bytes. Used where the point is to reject a bad reference before spending a
// request: the caller does not want the base64, and encoding a 40 MP photo to
// throw it away is pure latency. The provider re-reads the file when it actually
// needs the data URL.
const MAGIC_BUF = Buffer.alloc(12);
export function assertImageFile(filePath, cwd = process.cwd()) {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const fd = openSync(abs, "r");
  try {
    const n = readSync(fd, MAGIC_BUF, 0, 12, 0);
    const mime = detectImageMime(MAGIC_BUF.subarray(0, n));
    if (!mime) throw new Error(`unsupported reference image type: ${abs}`);
    return mime;
  } finally {
    closeSync(fd);
  }
}

// Read a response body as bytes, refusing payloads bigger than `max`. Every
// byte download (image file, raw body) goes through this: a hostile or
// misconfigured endpoint can otherwise stream unbounded data into memory.
export async function readBodyCapped(res, max = 64 * 1024 * 1024) {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error(`response body exceeds the ${Math.round(max / 1048576)}MB download limit`);
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return Buffer.concat(chunks);
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  timer.unref?.();
  const signal = opts.signal
    ? (typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal)
    : controller.signal;
  try {
    return await fetch(url, { ...opts, signal });
  } finally {
    clearTimeout(timer);
  }
}

// Minimal SSE `data:` line reader (no dependencies).
export async function* sseData(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = idx + 1 < buf.length ? buf.slice(idx + 1) : "";
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
      if (done) {
        const rest = buf.replace(/\r$/, "");
        if (rest.startsWith("data:")) yield rest.slice(5).trimStart();
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

// Actual pixel size straight out of the PNG IHDR chunk, which always follows
// the 8-byte signature (width @16, height @20). Returns null for non-PNG bytes.
// Worth reporting: some backends come back 1px off from the requested size.
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Append a chunk to child-process output, retaining at most the LAST lines.
// The provider `run()` helpers hold a CLI's whole output for the duration of a
// multi-minute generation; without a cap a chatty or spinning child grows the
// heap without bound (and string += is O(n²) in allocations). Cuts happen on
// line boundaries so per-line JSON and status markers stay parsable. A single
// line bigger than `max` still gets clipped mid-line rather than retained — the
// inline-base64 fallback then fails and the provider falls back to the saved
// file, which is what it prefers anyway.
export function appendTailed(s, chunk, max = 24 * 1024 * 1024) {
  s += chunk;
  if (s.length <= max) return s;
  const cut = s.indexOf("\n", s.length - max);
  return cut > 0 ? s.slice(cut + 1) : s.slice(-max);
}

export function normalizeSize(size) {
  if (!size || size === "auto") return null;
  const m = String(size).match(/^(\d+)\s*[xX*]\s*(\d+)$/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]), raw: `${m[1]}x${m[2]}` };
}
