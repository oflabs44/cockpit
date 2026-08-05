// Enrolment/credential secret generation and hash-at-rest (docs/type-design.md §2.1.1:
// "never stored in the clear"). Randomness for secret material goes through `deps.ids`,
// the one seam where it's allowed (docs/type-design.md §1) — never `crypto.randomUUID()`
// called directly outside `deps.ts`.

import type { Deps } from "./deps";

export function issueToken(ids: Deps["ids"]): string {
  return ids.id("ck_enrol");
}

export function issueCredential(ids: Deps["ids"]): string {
  return ids.id("ck_cred");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
