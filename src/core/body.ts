/**
 * Classifies raw response bytes once, so digest and inspect agree on what a
 * body *is*. Content-Type is a hint, not a fact: servers lie, and a body
 * labelled JSON that does not parse must degrade to text rather than throw.
 */

export type DecodedBody =
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string }
  /** Not decodable as UTF-8, or a content type we should not render. */
  | { readonly kind: "binary" };

/** Content types we attempt to read as text even though they are not `text/*`. */
const TEXTUAL_SUBTYPES = [
  "json",
  "xml",
  "yaml",
  "javascript",
  "ecmascript",
  "x-www-form-urlencoded",
];

export function decodeBody(bytes: Uint8Array, contentType: string | undefined): DecodedBody {
  if (bytes.byteLength === 0) return { kind: "empty" };

  const essence = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const textual =
    essence.startsWith("text/") ||
    TEXTUAL_SUBTYPES.some((subtype) => essence.includes(subtype)) ||
    essence === "";

  if (!textual) return { kind: "binary" };

  let text: string;
  try {
    // fatal:true is the point: invalid UTF-8 is reported as binary rather than
    // silently peppered with replacement characters that look like real content.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "binary" };
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      return { kind: "text", text };
    }
  }

  if (essence.includes("json")) {
    // Scalar JSON documents (`"a"`, `42`, `null`) are legal but rare.
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      return { kind: "text", text };
    }
  }

  return { kind: "text", text };
}

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Cuts a string to a UTF-8 byte budget without splitting a code point.
 * Iterates code points rather than slicing the buffer and repairing it —
 * slower, but there is no way to get it subtly wrong.
 */
export function capBytes(text: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // When the budget cannot even hold the marker, drop the marker rather than
  // blow the cap. The cap is an invariant; the marker is a courtesy.
  const suffix = Buffer.byteLength(marker, "utf8") <= maxBytes ? marker : "";
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));

  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > room) break;
    out += char;
    used += size;
  }
  return out + suffix;
}
