// SHA-256 hashing + UTF-8 byte sizing — match Python's
// hashlib.sha256(text.utf8).hexdigest() and len(text.encode("utf-8")).
//
// Lives in a neutral module so both the prompt editor and the source-policy
// store can use it without an import cycle.

const UTF8 = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return UTF8.encode(text).length;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", UTF8.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
