// api/profile/index.js
import { Pool } from "pg";

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

// Simple check
if (!DATABASE_URL) {
  console.error("Missing POSTGRES_URL environment variable.");
}

// Reuse pool across invocations to avoid exhausting connections in serverless
let pool;
if (!global.__pgPool) {
  global.__pgPool = new Pool({ connectionString: DATABASE_URL });
}
pool = global.__pgPool;

async function ensureSchema() {
  // Create tables if they don't exist
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        token TEXT,
        email TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_type TEXT,  -- e.g. "musician", "band_leader", etc.
        display_name TEXT,
        bio TEXT,
        metadata JSONB,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
      );
    `);
  } finally {
    client.release();
  }
}

async function getUserById(userId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]);
  return rows[0] || null;
}

async function getUserByToken(token) {
  const { rows } = await pool.query("SELECT * FROM users WHERE token = $1 LIMIT 1", [token]);
  return rows[0] || null;
}

async function getProfileForUser(userId) {
  const { rows } = await pool.query("SELECT * FROM profiles WHERE user_id = $1 LIMIT 1", [userId]);
  return rows[0] || null;
}

export default async function handler(req, res) {
  try {
    // Ensure DB schema exists (idempotent)
    await ensureSchema();

    // Authentication handling (simple & flexible for testing)
    // 1) First, allow a simple developer/test header: x-user-id
    // 2) Otherwise, allow Authorization: Bearer <token> that matches users.token
    const devUserId = req.headers["x-user-id"] || null;
    const authHeader = req.headers["authorization"] || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    let user = null;
    if (devUserId) {
      user = await getUserById(devUserId);
      // If user doesn't exist yet, create a minimal user record so the profile endpoint can work
      if (!user) {
        await pool.query("INSERT INTO users(id, created_at) VALUES($1, now()) ON CONFLICT DO NOTHING", [devUserId]);
        user = await getUserById(devUserId);
      }
    } else if (bearer) {
      user = await getUserByToken(bearer);
    } else {
      // No auth provided
      return res.status(401).json({ error: "Missing auth. Provide x-user-id (dev) or Authorization: Bearer <token>." });
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid auth / user not found." });
    }

    // Read profile (may be null)
    const profile = await getProfileForUser(user.id);

    return res.status(200).json({
      user,
      profile,
      profile_type: profile?.profile_type ?? null
    });
  } catch (err) {
    console.error("Profile API error:", err);
    return res.status(500).json({ error: "Server error", details: String(err?.message || err) });
  }
}
