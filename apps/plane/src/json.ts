// One corrupt JSON-in-text column (`labels`, `presented`) must not fail an entire list/detail
// response — parse defensively per row and log which row was bad, rather than letting one
// throw take the whole endpoint down.
export function safeJsonParse<T>(raw: string, fallback: T, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // error, not warn: corrupt stored state is never routine, and a warn-level line is exactly
    // what nobody has an alert on.
    console.error(`corrupt JSON in ${context}:`, err);
    return fallback;
  }
}
