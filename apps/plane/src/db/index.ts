import { drizzle } from "drizzle-orm/d1";

export function db(d1: D1Database) {
  return drizzle(d1);
}

export * from "./schema";

// D1 surfaces a unique-constraint violation as a thrown `DrizzleQueryError` wrapping D1's own
// error in `.cause` (itself wrapping SQLite's), not a typed result — walk the cause chain and
// string-match the SQLite message (`column` is e.g. "servers.name") rather than letting it 500.
export function isUniqueConstraintError(err: unknown, column: string): boolean {
  for (let cause: unknown = err; cause; cause = (cause as { cause?: unknown }).cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("UNIQUE constraint failed") && message.includes(column)) return true;
  }
  return false;
}
