// Postgres connection for sign-in, chosen from POSTGRES_URL.
//
// Workers can't use a regular pooled Postgres client, so there are two paths:
// - Neon (host ends in .neon.tech): Neon's serverless driver over HTTP.
//   Stateless, no connection to open or close — the fastest option here.
// - Any other Postgres, e.g. Supabase: postgres.js over a TCP socket, one
//   connection per request, closed after the response. For Supabase use the
//   connection pooler URL (port 6543) — the direct db.<project>.supabase.co
//   host is IPv6-only on newer projects.
//
// Neither path supports multi-statement transactions over HTTP, so BetterAuth's
// adapter runs with transaction: false (its default).

import { neon } from "@neondatabase/serverless";
import postgres from "postgres";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleSocket } from "drizzle-orm/postgres-js";
import { configuredValue } from "../http.js";
import * as schema from "./schema.js";

export function databaseUrl(env) {
  return configuredValue(env, "POSTGRES_URL");
}

function usesHttpDriver(url) {
  try {
    return new URL(url).hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

// Returns { db, query(text, params) -> rows, close() } or null when
// POSTGRES_URL isn't set.
export function openDatabase(env) {
  const url = databaseUrl(env);
  if (!url) return null;

  if (usesHttpDriver(url)) {
    const sql = neon(url);
    return {
      db: drizzleHttp({ client: sql, schema }),
      query: (text, params) => sql.query(text, params),
      close: async () => {},
    };
  }

  const sql = postgres(url, { max: 1, prepare: false, fetch_types: false, connect_timeout: 10 });
  return {
    db: drizzleSocket({ client: sql, schema }),
    query: (text, params) => sql.unsafe(text, params),
    close: () => sql.end({ timeout: 5 }),
  };
}

export async function databaseStatus(env) {
  const database = openDatabase(env);
  if (!database) return "not-configured";
  try {
    await database.query("select 1", []);
    return "ok";
  } catch {
    return "unreachable";
  } finally {
    await database.close().catch(() => {});
  }
}
