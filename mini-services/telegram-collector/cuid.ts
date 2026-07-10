// CUID-compatible ID generator for SQLite rows (Prisma reads these fine as TEXT).
import { randomBytes } from "node:crypto";

let counter = 0;

export function cuid(): string {
  counter = (counter + 1) % 36;
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString("hex");
  const c = counter.toString(36);
  return `c${ts}${c}${rand}`;
}
