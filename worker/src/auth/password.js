// Password hashing runs inside Postgres (pgcrypto's crypt() with bcrypt),
// not in the Worker. Cloudflare's CPU limit (10 ms on the free plan) counts
// only time the Worker spends computing; waiting on the database doesn't
// count, so the Worker sends the password, waits, and reads the result in
// the same request. Needs `create extension pgcrypto` — see
// auth/db/0002_enable_pgcrypto.sql. Works on Neon and Supabase alike.
//
// Accounts created by chat's Node BetterAuth hold scrypt hashes
// ("<salt>:<key>"). Those are checked here once with node:crypto, which is
// expensive, and on success rewritten as bcrypt so later sign-ins hash in
// the database.

import { scrypt } from "node:crypto";

const BCRYPT_COST = 10;

function isBcrypt(hash) {
  return /^\$2[aby]\$/.test(hash);
}

function verifyScrypt(hash, password) {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return Promise.resolve(false);
  // Same parameters as @better-auth/utils/password.
  const N = 16384, r = 16, p = 1;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, 64, { N, r, p, maxmem: 128 * N * r * 2 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString("hex") === key);
    });
  });
}

export function databasePasswordHashing(database) {
  return {
    async hash(password) {
      const rows = await database.query(
        "select crypt($1, gen_salt('bf', $2)) as hash",
        [password.normalize("NFKC"), BCRYPT_COST]
      );
      return rows[0].hash;
    },

    async verify({ hash, password }) {
      const normalized = password.normalize("NFKC");
      if (isBcrypt(hash)) {
        const rows = await database.query("select crypt($1, $2) = $2 as ok", [normalized, hash]);
        return rows[0]?.ok === true;
      }
      const ok = await verifyScrypt(hash, password);
      if (ok) {
        await database.query(
          "update account set password = crypt($1, gen_salt('bf', $2)), updated_at = now() where provider_id = 'credential' and password = $3",
          [normalized, BCRYPT_COST, hash]
        );
      }
      return ok;
    },
  };
}
