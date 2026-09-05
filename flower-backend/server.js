const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

// Quick startup check - confirms whether Brevo env vars actually
// loaded, without printing the secret key itself. Remove these two
// lines once OTP emails are confirmed working.
console.log("BREVO_API_KEY loaded:", !!process.env.BREVO_API_KEY);
console.log(
  "BREVO_SENDER_EMAIL loaded:",
  process.env.BREVO_SENDER_EMAIL || "(empty - check .env location)"
);

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { Pool, types } = require("pg");
const { OAuth2Client } = require("google-auth-library");

// ============================================================
// DATE FIX
// PostgreSQL DATE values remain YYYY-MM-DD.
// This prevents 15 Aug becoming 14 Aug because of timezone.
// ============================================================

types.setTypeParser(1082, (value) => value);

const app = express();

const PORT = process.env.PORT || 4000;

const JWT_SECRET =
  process.env.JWT_SECRET ||
  "flower-ledger-change-this-secret";

// ============================================================
// GOOGLE SIGN-IN CONFIG
// ============================================================
//
// GOOGLE_CLIENT_ID must match the OAuth Client ID configured in
// Google Cloud Console for this app's "Continue with Google"
// button (index.html sends back an ID token; this server
// verifies it was issued for THIS client id, so a token minted
// for some other app/site can't be replayed here).
//
// There is no email allowlist - any Google account with a
// verified email can sign in, and gets an account auto-created
// on first login. See the comment on POST /api/auth/google below.
// ============================================================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

const googleClient = GOOGLE_CLIENT_ID
  ? new OAuth2Client(GOOGLE_CLIENT_ID)
  : null;

// ============================================================
// OTP EMAIL VERIFICATION (Brevo)
// ============================================================
//
// A 6-digit OTP is required exactly once: during password-based
// signup (POST /api/register -> /api/register/verify-otp), to
// confirm the person owns the email address before their account
// is activated. Google signups skip this - Google already verified
// the email when it issued the ID token - and no login (password or
// Google) requires an OTP; a correct password, or a valid Google ID
// token, is sufficient on its own. BREVO_API_KEY and
// BREVO_SENDER_EMAIL must be set in .env; BREVO_SENDER_EMAIL must be
// a sender verified in your Brevo account (Settings -> Senders), or
// sends will fail.
// ============================================================

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "";
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "S.P.S. Malaragam Flower Ledger";
const OTP_TTL_MINUTES = 10;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpExpiryDate() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

async function sendOtpEmail(toEmail, toName, otp, purpose) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.error(
      "BREVO_API_KEY or BREVO_SENDER_EMAIL is not configured in .env - cannot send OTP email"
    );
    throw new Error("Email service is not configured on this server.");
  }

  const subject =
    purpose === "login"
      ? "Your sign-in code"
      : "Your account verification code";

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#333;">
      <p>Hi ${toName ? String(toName) : "there"},</p>
      <p>Your one-time code is:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${otp}</p>
      <p>This code expires in ${OTP_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>
      <p style="color:#888;font-size:12px;">S.P.S. மலரகம் — Flower Ledger</p>
    </div>
  `;

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-key": BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    console.error("Brevo send error:", res.status, errorBody);
    throw new Error("Could not send verification email.");
  }
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  express.json({
    limit: "5mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
  })
);

// ============================================================
// DATABASE
// ============================================================

if (!process.env.SUPABASE_DB_URL) {
  console.error(
    "ERROR: SUPABASE_DB_URL is missing in .env"
  );

  process.exit(1);
}

const pool = new Pool({
  connectionString:
    process.env.SUPABASE_DB_URL,

  ssl: {
    rejectUnauthorized: false,
  },

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000,

  keepAlive: true,

  keepAliveInitialDelayMillis: 10000,
});

setInterval(() => {
  pool.query("SELECT 1").catch((error) => {
    console.error(
      "Keep-alive DB ping failed:",
      error.message
    );
  });
}, 4 * 60 * 1000); // every 4 minutes

if (process.env.SELF_PING_URL) {
  const selfPingUrl = process.env.SELF_PING_URL;

  setInterval(() => {
    const client = selfPingUrl.startsWith("https") ? https : http;

    client
      .get(selfPingUrl, (res) => {
        res.resume(); // drain response, don't hold the socket open
      })
      .on("error", (error) => {
        console.error("Self-ping failed:", error.message);
      });
  }, 10 * 60 * 1000); // every 10 minutes
}

// ============================================================
// LOCAL JSON FILES
// ============================================================

const dataFolder =
  path.join(
    __dirname,
    "data"
  );

const entriesJsonPath =
  path.join(
    dataFolder,
    "entries.json"
  );

const ratesJsonPath =
  path.join(
    dataFolder,
    "rates.json"
  );

const usersJsonPath =
  path.join(
    dataFolder,
    "users.json"
  );

function writeJsonFile(
  filePath,
  data
) {
  fs.mkdirSync(
    dataFolder,
    {
      recursive: true,
    }
  );

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      data,
      null,
      2
    ) + "\n",
    "utf8"
  );
}

// ============================================================
// SYNC ENTRIES JSON
// ============================================================

async function syncEntriesJson() {
  const result =
    await pool.query(`
      SELECT
        id,
        name,
        entry_date,
        entry_time,
        flower,
        qty,
        unit,
        price,
        amount,
        rate_slot,
        user_id,
        paid,
        paid_date,
        created_at,
        updated_at

      FROM entries

      ORDER BY
        entry_date DESC,
        created_at DESC
    `);

  writeJsonFile(
    entriesJsonPath,
    result.rows
  );

  console.log(
    `entries.json synced: ${result.rows.length} entries`
  );

  return result.rows.length;
}

// ============================================================
// SYNC RATES JSON
// ============================================================

async function syncRatesJson() {
  const result =
    await pool.query(`
      SELECT
        id,
        flower,
        name,
        english_name,
        price,
        rate_date,
        rate_time,
        rate_slot,
        user_id,
        created_at,
        updated_at

      FROM flower_rates

      ORDER BY
        rate_date DESC,
        rate_slot ASC,
        flower
    `);

  writeJsonFile(
    ratesJsonPath,
    result.rows
  );

  console.log(
    `rates.json synced: ${result.rows.length} rates`
  );

  return result.rows.length;
}

// ============================================================
// SYNC USERS JSON
// ============================================================
//
// UPDATE: now includes email + email_verified so the JSON mirror
// actually reflects OTP/verification state instead of silently
// omitting it.
// ============================================================

async function syncUsersJson() {
  const result =
    await pool.query(`
      SELECT
        id,
        username,
        name,
        email,
        picture,
        google,
        email_verified,
        created_at

      FROM users

      ORDER BY id
    `);

  writeJsonFile(
    usersJsonPath,
    result.rows
  );

  console.log(
    `users.json synced: ${result.rows.length} users`
  );

  return result.rows.length;
}

// ============================================================
// SYNC EVERYTHING
// ============================================================

async function syncAllJsonFiles() {
  try {
    const [
      entriesCount,
      ratesCount,
      usersCount,
    ] = await Promise.all([
      syncEntriesJson(),
      syncRatesJson(),
      syncUsersJson(),
    ]);

    console.log(
      `JSON mirror complete: ${entriesCount} entries, ${ratesCount} rates, ${usersCount} users`
    );
  } catch (error) {
    console.error(
      "JSON mirror sync error:",
      error.message
    );
  }
}

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {
  const client =
    await pool.connect();

  try {
    // UPDATE: bumped 3 -> 4. If an earlier deploy of this file
    // already recorded version 3 in _schema_migrations BEFORE the
    // OTP/email/google_sub columns existed, the old check would
    // have skipped this whole block forever and those columns
    // would never get created on that database. Bumping forces
    // the migration chain to run one more time on any existing
    // database that's missing them. Leave this at 4 after it has
    // run once.
    const SCHEMA_VERSION = 4;

    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        version INT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const { rows: versionRows } =
      await client.query(
        `SELECT version FROM _schema_migrations WHERE version = $1 LIMIT 1`,
        [SCHEMA_VERSION]
      );

    if (versionRows.length > 0) {
      console.log(
        `Database schema already at version ${SCHEMA_VERSION} - skipping migration chain.`
      );

      return;
    }

    // ========================================================
    // USERS
    // ========================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        picture TEXT,
        google BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ========================================================
    // GOOGLE SIGN-IN SUPPORT ON USERS
    // ========================================================
    //
    // Google-created accounts have no password at all, so
    // password_hash must become nullable (it was NOT NULL when
    // only username/password accounts existed).
    //
    // google_sub stores Google's stable per-account subject id
    // (from the verified ID token's "sub" claim) so the same
    // Google account is recognized as the same user even if its
    // email or display name ever changes. It is unique only
    // among non-null values, since normal password accounts
    // never have one.
    // ========================================================

    await client.query(`
      ALTER TABLE users
      ALTER COLUMN password_hash
      DROP NOT NULL;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS
      google_sub TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      users_google_sub_unique
      ON users(google_sub)
      WHERE google_sub IS NOT NULL;
    `);

    // ========================================================
    // OTP EMAIL VERIFICATION SUPPORT
    // ========================================================
    //
    // email: the address OTPs are sent to. Nullable so accounts
    // created before this feature keep working without one -
    // see the login route, which skips the OTP step for any
    // account with no email on file.
    //
    // otp_code / otp_expires_at: the currently-pending one-time
    // code for that account, if any. Cleared after use.
    //
    // pending_signups holds accounts that have NOT finished OTP
    // verification yet - both password-based signups and
    // Google-based signups (which need a username/password
    // chosen before the account can be created). A row here is
    // only ever promoted into `users` once its OTP is verified,
    // and is deleted either on success or when superseded by a
    // fresh signup attempt for the same username/email.
    // ========================================================

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS
      email TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      users_email_unique
      ON users(LOWER(email))
      WHERE email IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS
      email_verified BOOLEAN DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS
      otp_code TEXT;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS
      otp_expires_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_signups (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('password','google')),
        name TEXT,
        username TEXT,
        password_hash TEXT,
        email TEXT NOT NULL,
        google_sub TEXT,
        picture TEXT,
        otp_code TEXT,
        otp_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_pending_signups_email
      ON pending_signups(LOWER(email));
    `);

    // ========================================================
    // FLOWER RATES
    // ========================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS flower_rates (
        id BIGSERIAL PRIMARY KEY,
        flower TEXT NOT NULL,
        name TEXT,
        english_name TEXT,
        price NUMERIC(12,2) NOT NULL DEFAULT 0,
        rate_date DATE NOT NULL,
        rate_time TIME NOT NULL DEFAULT '00:00:00',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE flower_rates
      DROP CONSTRAINT IF EXISTS
      flower_rates_flower_key;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ADD COLUMN IF NOT EXISTS
      rate_time TIME;
    `);

    await client.query(`
      UPDATE flower_rates
      SET rate_time = '00:00:00'::time
      WHERE rate_time IS NULL;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ALTER COLUMN rate_time
      SET DEFAULT '00:00:00';
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ALTER COLUMN rate_time
      SET NOT NULL;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ADD COLUMN IF NOT EXISTS
      rate_slot SMALLINT;
    `);

    await client.query(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY flower, rate_date
            ORDER BY rate_time ASC, id ASC
          ) AS rn
        FROM flower_rates
        WHERE rate_slot IS NULL
      )
      UPDATE flower_rates fr
      SET rate_slot = LEAST(ranked.rn, 3)
      FROM ranked
      WHERE fr.id = ranked.id;
    `);

    await client.query(`
      DELETE FROM flower_rates a
      USING flower_rates b
      WHERE a.flower = b.flower
        AND a.rate_date = b.rate_date
        AND a.rate_slot = b.rate_slot
        AND a.rate_slot IS NOT NULL
        AND a.id < b.id;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ALTER COLUMN rate_slot
      SET DEFAULT 1;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ALTER COLUMN rate_slot
      SET NOT NULL;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      DROP CONSTRAINT IF EXISTS
      flower_rates_rate_slot_check;
    `);

    await client.query(`
      ALTER TABLE flower_rates
      ADD CONSTRAINT
      flower_rates_rate_slot_check
      CHECK (rate_slot BETWEEN 1 AND 3);
    `);

    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_unique;
    `);

    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_unique;
    `);

    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_time_unique;
    `);

    // ========================================================
    // USER OWNERSHIP ON FLOWER_RATES
    // ========================================================

    await client.query(`
      ALTER TABLE flower_rates
      ADD COLUMN IF NOT EXISTS
      user_id BIGINT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_flower_rates_user_id
      ON flower_rates(user_id);
    `);

    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_slot_unique;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      flower_rates_user_flower_date_slot_unique
      ON flower_rates
      (
        user_id,
        flower,
        rate_date,
        rate_slot
      );
    `);

    // ========================================================
    // ENTRIES
    // ========================================================

    await client.query(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entry_date DATE NOT NULL,
        entry_time TEXT,
        flower TEXT NOT NULL,
        qty NUMERIC(12,3) NOT NULL DEFAULT 0,
        unit TEXT DEFAULT '',
        price NUMERIC(12,2) NOT NULL DEFAULT 0,
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        paid BOOLEAN DEFAULT FALSE,
        paid_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE entries ALTER COLUMN price DROP NOT NULL;
    `);

    await client.query(`
      ALTER TABLE entries ALTER COLUMN price DROP DEFAULT;
    `);

    await client.query(`
      ALTER TABLE entries ALTER COLUMN amount DROP NOT NULL;
    `);

    await client.query(`
      ALTER TABLE entries ALTER COLUMN amount DROP DEFAULT;
    `);

    await client.query(`
      ALTER TABLE entries
      ALTER COLUMN unit
      SET DEFAULT '';
    `);

    await client.query(`
      UPDATE entries
      SET unit = ''
      WHERE unit = 'kg';
    `);

    await client.query(`
      ALTER TABLE entries
      ADD COLUMN IF NOT EXISTS
      user_id BIGINT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_entries_user_id
      ON entries(user_id);
    `);

    await client.query(`
      ALTER TABLE entries
      ADD COLUMN IF NOT EXISTS
      rate_slot SMALLINT;
    `);

    await client.query(`
      ALTER TABLE entries
      DROP CONSTRAINT IF EXISTS
      entries_rate_slot_check;
    `);

    await client.query(`
      ALTER TABLE entries
      ADD CONSTRAINT
      entries_rate_slot_check
      CHECK (rate_slot IS NULL OR rate_slot BETWEEN 1 AND 3);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_entries_date
      ON entries(entry_date);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_entries_name
      ON entries(name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_entries_flower
      ON entries(flower);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_entries_paid
      ON entries(paid);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_entries_rate_slot
      ON entries(flower, entry_date, rate_slot);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_flower_rates_date
      ON flower_rates(rate_date);
    `);

    await client.query(
      `INSERT INTO _schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
      [SCHEMA_VERSION]
    );

    console.log(
      "Database tables are ready."
    );
  } finally {
    client.release();
  }
}

// ============================================================
// FLOWER NORMALIZATION
// ============================================================

function normalizeFlowerType(value) {
  if (!value) {
    return "";
  }

  const v =
    String(value)
      .trim()
      .toLowerCase();

  if (
    v === "mullai" ||
    v === "முல்லை" ||
    v.includes("mullai")
  ) {
    return "Mullai";
  }

  if (
    v === "royal jasmine" ||
    v === "royal-jasmine" ||
    v === "jasmine" ||
    v === "பிச்சை" ||
    v === "பிச்சி" ||
    v === "pichi" ||
    v.includes("royal jasmine")
  ) {
    return "Royal Jasmine";
  }

  if (
    v === "malli" ||
    v === "மல்லி" ||
    v.includes("malli")
  ) {
    return "Malli";
  }

  return String(value).trim();
}

// ============================================================
// DATE NORMALIZATION
// ============================================================

function formatDateOnly(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const str =
    String(value).trim();

  const match =
    str.match(
      /^(\d{4}-\d{2}-\d{2})/
    );

  if (match) {
    return match[1];
  }

  const usMatch =
    str.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
    );

  if (usMatch) {
    const month =
      String(
        usMatch[1]
      ).padStart(2, "0");

    const day =
      String(
        usMatch[2]
      ).padStart(2, "0");

    const year =
      usMatch[3];

    return `${year}-${month}-${day}`;
  }

  const d =
    new Date(str);

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return null;
  }

  return [
    d.getFullYear(),
    String(
      d.getMonth() + 1
    ).padStart(2, "0"),
    String(
      d.getDate()
    ).padStart(2, "0"),
  ].join("-");
}

// ============================================================
// TIME NORMALIZATION
// ============================================================

function formatTimeOnly(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const str =
    String(value).trim();

  const match =
    str.match(
      /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );

  if (!match) {
    return null;
  }

  const hour =
    Number(match[1]);

  const minute =
    Number(match[2]);

  const second =
    match[3]
      ? Number(match[3])
      : 0;

  if (
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  return (
    String(hour).padStart(2, "0") +
    ":" +
    String(minute).padStart(2, "0") +
    ":" +
    String(second).padStart(2, "0")
  );
}

// ============================================================
// RATE SLOT NORMALIZATION (1st / 2nd / 3rd Rate)
// ============================================================

function normalizeRateSlot(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const match =
    String(value)
      .trim()
      .match(/[1-3]/);

  if (!match) {
    return null;
  }

  const slot =
    Number(match[0]);

  if (
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > 3
  ) {
    return null;
  }

  return slot;
}

function rateSlotLabel(slot) {
  if (slot === 1) return "1st Rate";
  if (slot === 2) return "2nd Rate";
  if (slot === 3) return "3rd Rate";
  return null;
}

// ============================================================
// AUTO USERNAME FOR GOOGLE SIGNUPS
// ============================================================
//
// New Google accounts are created automatically with no extra
// screen asking the person to pick a username (per the "no OTP, no
// extra step for Google" flow). A username is still required by the
// users table, so one is derived from the email's local part and
// de-duplicated against existing usernames.
// ============================================================

function usernameBaseFromEmail(email) {
  const local =
    String(email)
      .split("@")[0]
      .toLowerCase();

  let base =
    local.replace(/[^a-z0-9_]/g, "");

  if (base.length < 3) {
    base = `user${base}`;
  }

  return base.slice(0, 20);
}

async function generateUniqueUsernameFromEmail(email) {
  const base =
    usernameBaseFromEmail(email) ||
    "user";

  let candidate = base;
  let suffix = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing =
      await pool.query(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
        [candidate]
      );

    if (existing.rows.length === 0) {
      return candidate;
    }

    suffix += 1;
    candidate = `${base}${suffix}`;
  }
}

// ============================================================
// CURRENT SERVER TIME
// ============================================================

function currentServerTime() {
  const d =
    new Date();

  return (
    String(
      d.getHours()
    ).padStart(2, "0") +
    ":" +
    String(
      d.getMinutes()
    ).padStart(2, "0") +
    ":" +
    String(
      d.getSeconds()
    ).padStart(2, "0")
  );
}

// ============================================================
// JWT
// ============================================================

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username:
        user.username,
      name:
        user.name,
    },
    JWT_SECRET,
    {
      expiresIn: "30d",
    }
  );
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function authMiddleware(
  req,
  res,
  next
) {
  const header =
    req.headers.authorization ||
    "";

  if (
    !header.startsWith(
      "Bearer "
    )
  ) {
    return res.status(401).json({
      success: false,
      message:
        "Authentication required",
    });
  }

  const token =
    header.substring(7);

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (decoded.id !== 0) {
      const result =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [decoded.id]
        );

      if (
        result.rows.length ===
        0
      ) {
        return res.status(401).json({
          success: false,
          message:
            "Session expired. Please sign in again.",
        });
      }
    }

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message:
        "Session expired. Please sign in again.",
    });
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  async (req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      res.json({
        success: true,
        server:
          "Flower Ledger Backend",
        status:
          "running",
        database:
          "Supabase PostgreSQL",
        time:
          new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "Health check error:",
        error
      );

      res.status(500).json({
        success: false,
        server:
          "Flower Ledger Backend",
        status:
          "running",
        database:
          "connection failed",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// REGISTER  (step 1 of 2: validate + send OTP)
// ============================================================
//
// This does NOT create the account yet. It validates the
// username/email/password, stashes them in pending_signups
// along with a fresh OTP, emails the OTP, and waits for
// POST /api/register/verify-otp to actually create the user.
// ============================================================

app.post(
  "/api/register",
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ""
        ).trim();

      const username =
        String(
          req.body.username ||
            ""
        )
          .trim()
          .toLowerCase();

      const email =
        String(
          req.body.email || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !name ||
        !username ||
        !password ||
        !email
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Name, username, email and password are required.",
        });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid email address.",
        });
      }

      if (
        username.length < 3
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Username must contain at least 3 characters.",
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Password must contain at least 6 characters.",
        });
      }

      const existingUser =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE LOWER(username) = LOWER($1)
             OR LOWER(email) = LOWER($2)
          LIMIT 1
          `,
          [username, email]
        );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message:
            "Username or email already in use.",
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const otp = generateOtp();
      const otpExpiresAt = otpExpiryDate();
      const pendingId = crypto.randomUUID();

      // Superseding: drop any earlier unfinished attempt for the
      // same username or email so only the latest OTP is valid.
      await pool.query(
        `
        DELETE FROM pending_signups
        WHERE LOWER(username) = LOWER($1)
           OR LOWER(email) = LOWER($2)
        `,
        [username, email]
      );

      await pool.query(
        `
        INSERT INTO pending_signups
        (id, kind, name, username, password_hash, email, otp_code, otp_expires_at)
        VALUES
        ($1, 'password', $2, $3, $4, $5, $6, $7)
        `,
        [pendingId, name, username, passwordHash, email, otp, otpExpiresAt]
      );

      try {
        await sendOtpEmail(email, name, otp, "signup");
      } catch (emailError) {
        return res.status(502).json({
          success: false,
          message:
            emailError.message || "Could not send verification email.",
        });
      }

      res.status(200).json({
        success: true,
        message:
          "A verification code was sent to your email.",
        pendingId,
        username,
      });
    } catch (error) {
      console.error(
        "Register error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not start account creation.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// REGISTER  (step 2 of 2: verify OTP, actually create the user)
// ============================================================

app.post(
  "/api/register/verify-otp",
  async (req, res) => {
    try {
      const pendingId =
        String(req.body.pendingId || "").trim();

      const otp =
        String(req.body.otp || "").trim();

      if (!pendingId || !otp) {
        return res.status(400).json({
          success: false,
          message:
            "Verification code is required.",
        });
      }

      const pendingResult = await pool.query(
        `
        SELECT *
        FROM pending_signups
        WHERE id = $1 AND kind = 'password'
        LIMIT 1
        `,
        [pendingId]
      );

      const pending = pendingResult.rows[0];

      if (!pending) {
        return res.status(400).json({
          success: false,
          message:
            "This signup request could not be found. Please start again.",
        });
      }

      if (
        !pending.otp_code ||
        pending.otp_code !== otp ||
        new Date(pending.otp_expires_at).getTime() < Date.now()
      ) {
        return res.status(401).json({
          success: false,
          message:
            "Incorrect or expired code.",
        });
      }

      // Re-check uniqueness in case another account took the
      // name/email while this OTP was pending.
      const clash = await pool.query(
        `
        SELECT id FROM users
        WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)
        LIMIT 1
        `,
        [pending.username, pending.email]
      );

      if (clash.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message:
            "Username or email was taken while your code was pending. Please start again.",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO users
        (name, username, password_hash, email, email_verified)
        VALUES
        ($1, $2, $3, $4, TRUE)
        RETURNING id, name, username, email, created_at
        `,
        [pending.name, pending.username, pending.password_hash, pending.email]
      );

      await pool.query(
        `DELETE FROM pending_signups WHERE id = $1`,
        [pendingId]
      );

      const user = result.rows[0];
      await syncUsersJson();

      const token = createToken(user);

      res.status(201).json({
        success: true,
        message:
          "Account created successfully.",
        token,
        user,
      });
    } catch (error) {
      console.error(
        "Register verify-otp error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not verify code.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// RESET PASSWORD
// ============================================================

app.post(
  "/api/reset-password",
  async (req, res) => {
    try {
      const username =
        String(
          req.body.username ||
            ""
        )
          .trim()
          .toLowerCase();

      const currentPassword =
        String(
          req.body.currentPassword ||
            ""
        );

      const newPassword =
        String(
          req.body.newPassword ||
          req.body.password ||
          ""
        );

      if (
        !username ||
        !newPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Username and new password are required.",
        });
      }

      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message:
            "Current password is required.",
        });
      }

      if (
        newPassword.length < 6
      ) {
        return res.status(400).json({
          success: false,
          message:
            "New password must contain at least 6 characters.",
        });
      }

      const existing =
        await pool.query(
          `
          SELECT
            id,
            name,
            username,
            password_hash

          FROM users

          WHERE LOWER(username)
                = LOWER($1)

          LIMIT 1
          `,
          [username]
        );

      if (
        existing.rows.length ===
        0
      ) {
        return res.status(401).json({
          success: false,
          message:
            "Current password is incorrect.",
        });
      }

      const currentPasswordOK =
        await bcrypt.compare(
          currentPassword,
          existing.rows[0].password_hash
        );

      if (!currentPasswordOK) {
        return res.status(401).json({
          success: false,
          message:
            "Current password is incorrect.",
        });
      }

      const passwordHash =
        await bcrypt.hash(
          newPassword,
          12
        );

      const result =
        await pool.query(
          `
          UPDATE users

          SET
            password_hash = $1

          WHERE id = $2

          RETURNING
            id,
            name,
            username,
            created_at
          `,
          [
            passwordHash,
            existing.rows[0].id,
          ]
        );

      await syncUsersJson();

      res.json({
        success: true,
        message:
          "Password reset successfully. You can now sign in.",
        user:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Reset password error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not reset password.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// LOGIN
// ============================================================

app.post(
  "/api/login",
  async (req, res) => {
    const loginStart = Date.now();
    let tDbDone = null;
    let tBcryptDone = null;

    try {
      // UPDATE: accepts EITHER a username or an email address here -
      // the field is still called `username` in the request body for
      // backward compatibility with the existing frontend, but the
      // value the person types can be either. This matches the "Sign
      // in with Username or Email" field on the login screen.
      const identifier =
        String(
          req.body.username ||
          req.body.identifier ||
          req.body.email ||
            ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !identifier ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Username/email and password are required.",
        });
      }

      // UPDATE: added `email` to the SELECT, and match on EITHER
      // username or email (case-insensitive). Without `email` here,
      // `user.email` would always be undefined further down; without
      // matching on email too, a person who signed up with
      // name@gmail.com couldn't log in by typing their email address.
      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            username,
            email,
            password_hash,
            created_at

          FROM users

          WHERE
            LOWER(username) = LOWER($1)
            OR LOWER(email) = LOWER($1)

          LIMIT 1
          `,
          [identifier]
        );

      tDbDone = Date.now();

      let user =
        result.rows[0];

      if (!user) {
        const envUsername =
          String(
            process.env.ADMIN_USERNAME ||
              "admin"
          )
            .trim()
            .toLowerCase();

        const envPassword =
          String(
            process.env.ADMIN_PASSWORD ||
              ""
          );

        if (
          identifier ===
            envUsername &&
          envPassword &&
          password ===
            envPassword
        ) {
          user = {
            id: 0,
            name:
              process.env.ADMIN_NAME ||
              "Administrator",
            username:
              envUsername,
          };

          const token =
            createToken(user);

          return res.json({
            success: true,
            message:
              "Login successful.",
            token,
            user,
          });
        }

        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      if (!user.password_hash) {
        return res.status(401).json({
          success: false,
          message:
            "This account uses Google Sign-In. Please continue with Google instead.",
        });
      }

      const passwordOK =
        await bcrypt.compare(
          password,
          user.password_hash
        );

      tBcryptDone = Date.now();

      if (!passwordOK) {
        console.log(
          `[LOGIN TIMING] user=${identifier} db=${tDbDone - loginStart}ms bcrypt=${tBcryptDone - tDbDone}ms total=${Date.now() - loginStart}ms result=WRONG_PASSWORD`
        );

        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      console.log(
        `[LOGIN TIMING] user=${identifier} db=${tDbDone - loginStart}ms bcrypt=${tBcryptDone - tDbDone}ms total=${Date.now() - loginStart}ms result=PASSWORD_OK`
      );

      // ==========================================================
      // NO OTP ON LOGIN
      // ==========================================================
      //
      // OTP is only required once, during account creation (see
      // /api/register/verify-otp). A correct password on an already-
      // activated account is sufficient to log in - re-verifying
      // email on every login would just slow people down for no
      // real security benefit, since the address was already
      // confirmed at signup.
      // ==========================================================

      delete user.password_hash;
      const token = createToken(user);

      return res.json({
        success: true,
        message: "Login successful.",
        token,
        user,
      });
    } catch (error) {
      console.log(
        `[LOGIN TIMING] db=${tDbDone ? tDbDone - loginStart : "N/A"}ms bcrypt=${tBcryptDone && tDbDone ? tBcryptDone - tDbDone : "N/A"}ms total=${Date.now() - loginStart}ms result=ERROR`
      );

      console.error(
        "Login error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Login failed.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// GOOGLE SIGN-IN  (open - any verified Google account is allowed)
// ============================================================
//
// Flow:
//   1. Frontend: user clicks "Continue with Google", picks an
//      account, and Google's script hands back a signed ID token
//      (a "credential" JWT) - the frontend never sees a password.
//   2. Frontend POSTs { credential } to this endpoint.
//   3. This server verifies the token DIRECTLY WITH GOOGLE using
//      google-auth-library, checking the signature, expiry, and
//      that the token was issued for OUR GOOGLE_CLIENT_ID. This
//      step is what makes the flow trustworthy - we never trust
//      an email the browser merely claims, only what Google's own
//      verification returns.
//   4. NOTE: there is intentionally no allowlist check anymore.
//      Any Google account with a verified email is accepted, and
//      a new account is auto-created here on first sign-in for
//      that email/Google id. Access to this app is therefore only
//      as private as the URL - anyone who reaches the login page
//      and has any Google account can get in.
//   5. Existing account -> a JWT is issued immediately, no OTP -
//      Google's verification of the token IS the identity check.
//      New account -> created immediately in this same request, no
//      OTP, no password, and no username prompt - a username is
//      auto-generated from the email address (see
//      generateUniqueUsernameFromEmail) purely to satisfy the users
//      table's NOT NULL UNIQUE constraint. Either way
//      authMiddleware, /api/me, etc. don't need to know or care that
//      a given login came from Google.
// ============================================================

app.post(
  "/api/auth/google",
  async (req, res) => {
    try {
      if (!googleClient) {
        console.error(
          "GOOGLE_CLIENT_ID is not configured in .env"
        );

        return res.status(500).json({
          success: false,
          message:
            "Google Sign-In is not configured on this server.",
        });
      }

      const credential =
        String(
          req.body.credential ||
          req.body.idToken ||
          req.body.id_token ||
          req.body.token ||
          ""
        ).trim();

      if (!credential) {
        return res.status(400).json({
          success: false,
          message:
            "Google credential is required.",
        });
      }

      let payload;

      try {
        const ticket =
          await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
          });

        payload = ticket.getPayload();
      } catch (verifyError) {
        console.error(
          "Google token verification failed:",
          verifyError.message
        );

        return res.status(401).json({
          success: false,
          message:
            "Could not verify Google sign-in. Please try again.",
        });
      }

      if (!payload || !payload.email) {
        return res.status(401).json({
          success: false,
          message:
            "Could not verify Google sign-in. Please try again.",
        });
      }

      if (!payload.email_verified) {
        return res.status(403).json({
          success: false,
          message:
            "Your Google email is not verified.",
        });
      }

      const email =
        String(payload.email)
          .trim()
          .toLowerCase();

      const googleSub =
        String(payload.sub);

      const displayName =
        payload.name ||
        email.split("@")[0];

      const picture =
        payload.picture || null;

      // Find an existing account either by its stored Google
      // subject id (most reliable - stable even if email/name
      // changes) or, failing that, by matching username=email
      // (covers a user who first registered the classic way with
      // their Gmail address as their username, then switches to
      // "Continue with Google").
      const existing =
        await pool.query(
          `
          SELECT
            id, name, username, email, google_sub

          FROM users

          WHERE
            google_sub = $1
            OR LOWER(username) = LOWER($2)
            OR LOWER(email) = LOWER($2)

          LIMIT 1
          `,
          [googleSub, email]
        );

      // ==========================================================
      // EXISTING ACCOUNT -> this is a LOGIN. Send an OTP just like
      // the password login path does, rather than issuing a token
      // immediately.
      // ==========================================================
      if (existing.rows.length > 0) {
        const updated = await pool.query(
          `
          UPDATE users
          SET google_sub = $1, google = TRUE, picture = COALESCE($2, picture)
          WHERE id = $3
          RETURNING id, name, username, email
          `,
          [googleSub, picture, existing.rows[0].id]
        );

        const user = updated.rows[0];
        await syncUsersJson();

        // Google already verified this identity when it issued the
        // ID token above - no additional app-level OTP is needed for
        // login, unlike a password account.
        const token = createToken(user);

        console.log(`[GOOGLE LOGIN] token issued - email=${email}`);

        return res.json({
          success: true,
          message: "Login successful.",
          token,
          user,
        });
      }

      // ==========================================================
      // NEW ACCOUNT -> created automatically, right now. Google
      // already verified this person's identity and email when it
      // issued the ID token above, so there is no OTP and no extra
      // screen asking for a password or username - a username is
      // generated from the email's local part (see
      // generateUniqueUsernameFromEmail) purely because the users
      // table requires one; the person is never asked to choose it.
      // Going forward this account signs in exclusively via
      // "Continue with Google".
      // ==========================================================
      const generatedUsername =
        await generateUniqueUsernameFromEmail(email);

      const created = await pool.query(
        `
        INSERT INTO users
        (name, username, password_hash, email, email_verified, picture, google, google_sub)
        VALUES
        ($1, $2, NULL, $3, TRUE, $4, TRUE, $5)
        RETURNING id, name, username, email, picture, created_at
        `,
        [
          displayName,
          generatedUsername,
          email,
          picture,
          googleSub,
        ]
      );

      const newUser = created.rows[0];
      await syncUsersJson();

      const token = createToken(newUser);

      console.log(
        `[GOOGLE SIGNUP] account auto-created - email=${email} username=${generatedUsername}`
      );

      res.status(201).json({
        success: true,
        message: "Account created successfully.",
        token,
        user: newUser,
      });
    } catch (error) {
      console.error(
        "Google login error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Google login failed.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// LOGOUT
// ============================================================

app.post(
  "/api/logout",
  authMiddleware,
  (req, res) => {
    res.json({
      success: true,
      message:
        "Logged out.",
    });
  }
);

// ============================================================
// CURRENT USER / PROFILE
// ============================================================
//
// UPDATE: this used to just echo back req.user (the decoded JWT
// payload), which only has id/username/name - no email, picture,
// google flag, or verification status, so the Profile screen could
// never show a complete picture. It now looks the user up in the
// database and returns the full row.
// ============================================================

app.get(
  "/api/me",
  authMiddleware,
  async (req, res) => {
    try {

      // Admin account from .env
      if (req.user.id === 0) {

        return res.json({
          success: true,
          user: {
            id: 0,
            name:
              process.env.ADMIN_NAME ||
              "Administrator",

            username:
              process.env.ADMIN_USERNAME ||
              "admin",

            email: null,

            picture: null,

            google: false,

            isAdmin: true,
          },
        });
      }


      // Get complete user details from database
      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            username,
            email,
            picture,
            google,
            email_verified,
            created_at

          FROM users

          WHERE id = $1

          LIMIT 1
          `,
          [req.user.id]
        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({
          success: false,

          message:
            "User not found.",
        });
      }


      const user =
        result.rows[0];


      return res.json({
        success: true,

        user: {
          id:
            user.id,

          name:
            user.name,

          username:
            user.username,

          email:
            user.email,

          picture:
            user.picture,

          google:
            user.google === true,

          emailVerified:
            user.email_verified === true,

          createdAt:
            user.created_at,

          isAdmin:
            false,
        },
      });

    } catch (error) {

      console.error(
        "Get profile error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Could not load profile.",

        error:
          error.message,

      });

    }
  }
);

// ============================================================
// GET FLOWER RATES
// ============================================================

app.get(
  "/api/rates",
  authMiddleware,
  async (req, res) => {
    try {
      const date =
        formatDateOnly(
          req.query.date
        );

      const at =
        formatTimeOnly(
          req.query.at
        );

      const from =
        formatDateOnly(
          req.query.from
        );

      const to =
        formatDateOnly(
          req.query.to
        );

      if (date) {
        const params = [
          req.user.id,
          date,
        ];

        let timeCondition = "";

        if (at) {
          params.push(at);
          timeCondition = `AND rate_time <= $${params.length}::time`;
        }

        const result =
          await pool.query(
            `
            SELECT
              id,
              flower,
              name,
              english_name,
              rate_date,
              rate_time,
              rate_slot,
              price,
              created_at,
              updated_at

            FROM flower_rates

            WHERE
              user_id = $1

              AND
              rate_date = $2

              ${timeCondition}

            ORDER BY
              flower,
              rate_slot ASC,
              id ASC
            `,
            params
          );

        return res.json({
          success: true,
          date,
          at:
            at || null,
          rates:
            result.rows,
        });
      }

      const params = [
        req.user.id,
      ];

      const conditions = [
        "user_id = $1",
      ];

      if (from) {
        params.push(from);

        conditions.push(
          `rate_date >= $${params.length}`
        );
      }

      if (to) {
        params.push(to);

        conditions.push(
          `rate_date <= $${params.length}`
        );
      }

      const where =
        `WHERE ${conditions.join(
          " AND "
        )}`;

      const result =
        await pool.query(
          `
          SELECT
            id,
            flower,
            name,
            english_name,
            rate_date,
            rate_time,
            rate_slot,
            price,
            created_at,
            updated_at

          FROM flower_rates

          ${where}

          ORDER BY
            rate_date DESC,
            rate_slot ASC,
            flower,
            id DESC
          `,
          params
        );

      res.json({
        success: true,
        rates:
          result.rows,
        count:
          result.rows.length,
      });
    } catch (error) {
      console.error(
        "Get rates error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not load flower rates.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// GET ONE FLOWER RATE
// ============================================================

app.get(
  "/api/rates/:flowerType",
  authMiddleware,
  async (req, res) => {
    try {
      const flower =
        normalizeFlowerType(
          req.params.flowerType
        );

      const date =
        formatDateOnly(
          req.query.date
        );

      const at =
        formatTimeOnly(
          req.query.at
        ) ||
        "23:59:59";

      if (!date) {
        return res.status(400).json({
          success: false,
          message:
            "Valid date is required.",
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            flower,
            name,
            english_name,
            rate_date,
            rate_time,
            rate_slot,
            price

          FROM flower_rates

          WHERE
            user_id = $1

            AND
            flower = $2

            AND
            rate_date = $3

            AND
            rate_time <= $4::time

          ORDER BY
            rate_time DESC,
            id DESC

          LIMIT 1
          `,
          [
            req.user.id,
            flower,
            date,
            at,
          ]
        );

      if (
        result.rows.length ===
        0
      ) {
        return res.json({
          success: true,
          found:
            false,
          flower,
          date,
          at,
          price:
            null,
          rate:
            null,
        });
      }

      res.json({
        success: true,
        found:
          true,
        flower,
        date,
        at,
        rate:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Get individual rate error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not load flower rate.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// SAVE FLOWER RATE
// ============================================================

app.post(
  "/api/rates",
  authMiddleware,
  async (req, res) => {
    try {
      const flower =
        normalizeFlowerType(
          req.body.flower ||
          req.body.flower_type ||
          req.body.flowerType
        );

      const name =
        req.body.name
          ? String(
              req.body.name
            ).trim()
          : null;

      const englishName =
        req.body.english_name
          ? String(
              req.body.english_name
            ).trim()
          : req.body.englishName
          ? String(
              req.body.englishName
            ).trim()
          : null;

      const rateDate =
        formatDateOnly(
          req.body.rate_date ||
          req.body.rateDate ||
          req.body.date
        );

      const rateSlot =
        normalizeRateSlot(
          req.body.rate_slot ||
          req.body.rateSlot ||
          req.body.slot
        );

      const rateTime =
        formatTimeOnly(
          req.body.rate_time ||
          req.body.rateTime ||
          req.body.time
        ) ||
        currentServerTime();

      const price =
        Number(
          req.body.price ||
          req.body.price_per_kg ||
          req.body.pricePerKg
        );

      if (!flower) {
        return res.status(400).json({
          success: false,
          message:
            "Flower type is required.",
        });
      }

      if (!rateDate) {
        return res.status(400).json({
          success: false,
          message:
            "Rate date is required.",
        });
      }

      if (!rateSlot) {
        return res.status(400).json({
          success: false,
          message:
            "Rate slot (1st, 2nd, or 3rd Rate) is required.",
        });
      }

      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          success: false,
          message:
            "Valid price is required.",
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO flower_rates
          (
            flower,
            name,
            english_name,
            price,
            rate_date,
            rate_time,
            rate_slot,
            user_id,
            updated_at
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NOW()
          )

          ON CONFLICT
          (
            user_id,
            flower,
            rate_date,
            rate_slot
          )

          DO UPDATE SET

            name =
              COALESCE(
                EXCLUDED.name,
                flower_rates.name
              ),

            english_name =
              COALESCE(
                EXCLUDED.english_name,
                flower_rates.english_name
              ),

            price =
              EXCLUDED.price,

            rate_time =
              EXCLUDED.rate_time,

            updated_at =
              NOW()

          RETURNING
            id,
            flower,
            name,
            english_name,
            rate_date,
            rate_time,
            rate_slot,
            price,
            created_at,
            updated_at
          `,
          [
            flower,
            name,
            englishName,
            price,
            rateDate,
            rateTime,
            rateSlot,
            req.user.id,
          ]
        );

      await pool.query(
        `
        UPDATE entries

        SET
          price = $1,
          amount = ROUND(qty * $1, 2),
          updated_at = NOW()

        WHERE
          flower = $2

          AND
          entry_date = $3

          AND
          (
            rate_slot IS NULL
            OR rate_slot = $4
          )

          AND
          user_id = $5

          AND
          (
           price IS NULL
           OR (price = 0 AND amount = 0)
          )
        `,
        [
          price,
          flower,
          rateDate,
          rateSlot,
          req.user.id,
        ]
      );

      await syncRatesJson();
      await syncEntriesJson();

      res.json({
        success: true,
        message:
          `Flower rate saved successfully (${rateSlotLabel(rateSlot)}).`,
        rate:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Save rate error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not save flower rate.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// CREATE ENTRY
// ============================================================

app.post(
  "/api/entries",
  authMiddleware,
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name ||
          req.body.supplier_name ||
          req.body.supplierName ||
          req.body.supplier ||
          ""
        ).trim();

      const entryDate =
        formatDateOnly(
          req.body.entry_date ||
          req.body.entryDate ||
          req.body.date
        );

      const entryTime =
        formatTimeOnly(
          req.body.entry_time ||
          req.body.entryTime ||
          req.body.time
        ) ||
        currentServerTime();

      const flower =
        normalizeFlowerType(
          req.body.flower ||
          req.body.flower_type ||
          req.body.flowerType
        );

      const qty =
        Number(
          req.body.qty ||
          req.body.quantity ||
          req.body.quantity_kg ||
          req.body.quantityKg ||
          0
        );

      const unit =
        req.body.unit
          ? String(
              req.body.unit
            ).trim()
          : "";

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Supplier name is required.",
        });
      }

      if (!entryDate) {
        return res.status(400).json({
          success: false,
          message:
            "Entry date is required.",
        });
      }

      if (!flower) {
        return res.status(400).json({
          success: false,
          message:
            "Flower type is required.",
        });
      }

      if (
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Quantity must be greater than zero.",
        });
      }

      const rateSlot =
        normalizeRateSlot(
          req.body.rate_slot ||
          req.body.rateSlot ||
          req.body.slot
        );

      let price = null;
      let amount = null;

      if (rateSlot) {
        const rateResult =
          await pool.query(
            `
            SELECT
              price

            FROM flower_rates

            WHERE
              flower = $1

              AND
              rate_date = $2

              AND
              rate_slot = $3

            ORDER BY
              id DESC

            LIMIT 1
            `,
            [
              flower,
              entryDate,
              rateSlot,
            ]
          );

        if (
          rateResult.rows.length >
          0
        ) {
          const rawPrice =
            Number(
              rateResult.rows[0].price
            );

          if (
            !Number.isFinite(rawPrice) ||
            rawPrice < 0
          ) {
            return res.status(400).json({
              success: false,
              code:
                "INVALID_FLOWER_RATE",

              message:
                "The flower rate is invalid. Please update the rate before adding the entry.",
            });
          }

          price = rawPrice;

          amount =
            Number(
              (
                qty * price
              ).toFixed(2)
            );
        }
      }

      const id =
        crypto.randomUUID();

      const result =
        await pool.query(
          `
          INSERT INTO entries
          (
            id,
            name,
            entry_date,
            entry_time,
            flower,
            qty,
            unit,
            price,
            amount,
            rate_slot,
            user_id
          )

          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11
          )

          RETURNING
            id,
            name,
            entry_date,
            entry_time,
            flower,
            qty,
            unit,
            price,
            amount,
            rate_slot,
            paid,
            paid_date,
            created_at
          `,
          [
            id,
            name,
            entryDate,
            entryTime,
            flower,
            qty,
            unit,
            price,
            amount,
            rateSlot,
            req.user.id,
          ]
        );

      const slotLabel =
        rateSlotLabel(rateSlot);

      res.status(201).json({
        success: true,
        message:
          price === null
            ? slotLabel
              ? `Entry added as pending (${slotLabel} not set yet).`
              : "Entry added as pending (no rate selected yet)."
            : `Entry added successfully (${slotLabel}).`,
        entry:
          result.rows[0],
      });

      await syncEntriesJson();
    } catch (error) {
      console.error(
        "Create entry error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not add entry.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// GET ENTRIES
// ============================================================

app.get(
  "/api/entries",
  authMiddleware,
  async (req, res) => {
    try {
      const from =
        formatDateOnly(
          req.query.from ||
          req.query.start
        );

      const to =
        formatDateOnly(
          req.query.to ||
          req.query.end
        );

      const name =
        String(
          req.query.supplier ||
          req.query.name ||
          ""
        ).trim();

      const paid =
        req.query.paid;

      const params = [
        req.user.id,
      ];

      const conditions = [
        "user_id = $1",
      ];

      if (from) {
        params.push(from);

        conditions.push(
          `entry_date >= $${params.length}`
        );
      }

      if (to) {
        params.push(to);

        conditions.push(
          `entry_date <= $${params.length}`
        );
      }

      if (name) {
        params.push(
          `%${name}%`
        );

        conditions.push(
          `name ILIKE $${params.length}`
        );
      }

      if (
        paid === "true" ||
        paid === "false"
      ) {
        params.push(
          paid === "true"
        );

        conditions.push(
          `paid = $${params.length}`
        );
      }

      const where =
        `WHERE ${conditions.join(
          " AND "
        )}`;

      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            entry_date,
            entry_time,
            flower,
            qty,
            unit,
            price,
            amount,
            rate_slot,
            paid,
            paid_date,
            created_at,
            updated_at

          FROM entries

          ${where}

          ORDER BY
            entry_date DESC,
            created_at DESC
          `,
          params
        );

      res.json({
        success: true,
        entries:
          result.rows,
        count:
          result.rows.length,
      });
    } catch (error) {
      console.error(
        "Get entries error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not load entries.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// SUMMARY
// ============================================================

app.get(
  "/api/summary",
  authMiddleware,
  async (req, res) => {
    try {
      const from =
        formatDateOnly(
          req.query.from
        );

      const to =
        formatDateOnly(
          req.query.to
        );

      const params = [
        req.user.id,
      ];

      const conditions = [
        "user_id = $1",
      ];

      if (from) {
        params.push(from);

        conditions.push(
          `entry_date >= $${params.length}`
        );
      }

      if (to) {
        params.push(to);

        conditions.push(
          `entry_date <= $${params.length}`
        );
      }

      const where =
        `WHERE ${conditions.join(
          " AND "
        )}`;

      const result =
        await pool.query(
          `
          SELECT

            COUNT(*)::int
              AS entries,

            COUNT(
              DISTINCT LOWER(
                TRIM(name)
              )
            )::int
              AS suppliers,

            COALESCE(
              SUM(amount),
              0
            )::numeric
              AS total_amount,

            COALESCE(
              SUM(amount)
              FILTER (
                WHERE paid = TRUE
              ),
              0
            )::numeric
              AS paid_amount,

            COALESCE(
              SUM(amount)
              FILTER (
                WHERE
                  paid = FALSE
                  OR paid IS NULL
              ),
              0
            )::numeric
              AS unpaid_amount

          FROM entries

          ${where}
          `,
          params
        );

      res.json({
        success: true,
        summary:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Summary error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not load summary.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// SUPPLIER HISTORY
// ============================================================

app.get(
  "/api/suppliers/:supplierName",
  authMiddleware,
  async (req, res) => {
    try {
      const name =
        String(
          req.params.supplierName ||
            ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Supplier name is required.",
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            entry_date,
            entry_time,
            flower,
            qty,
            unit,
            price,
            amount,
            rate_slot,
            paid,
            paid_date,
            created_at

          FROM entries

          WHERE
            name ILIKE $1

            AND
            user_id = $2

          ORDER BY
            entry_date DESC,
            created_at DESC
          `,
          [name, req.user.id]
        );

      res.json({
        success: true,
        supplier:
          name,
        entries:
          result.rows,
        count:
          result.rows.length,
      });
    } catch (error) {
      console.error(
        "Supplier history error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not load supplier history.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// SEARCH SUPPLIER
// ============================================================

app.get(
  "/api/search-supplier",
  authMiddleware,
  async (req, res) => {
    try {
      const q =
        String(
          req.query.q || ""
        ).trim();

      if (!q) {
        return res.json({
          success: true,
          entries: [],
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            entry_date,
            entry_time,
            flower,
            qty,
            unit,
            price,
            amount,
            rate_slot,
            paid,
            paid_date

          FROM entries

          WHERE
            name ILIKE $1

            AND
            user_id = $2

          ORDER BY
            entry_date DESC,
            created_at DESC
          `,
          [
            `%${q}%`,
            req.user.id,
          ]
        );

      res.json({
        success: true,
        entries:
          result.rows,
        count:
          result.rows.length,
      });
    } catch (error) {
      console.error(
        "Search supplier error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not search supplier.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// EDIT ENTRY
// ============================================================

app.put(
  "/api/entries/:id",
  authMiddleware,
  async (req, res) => {
    try {
      const id =
        String(
          req.params.id || ""
        ).trim();

      if (!id) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid entry ID.",
        });
      }

      const name =
        String(
          req.body.name ||
          req.body.supplier_name ||
          req.body.supplierName ||
          req.body.supplier ||
          ""
        ).trim();

      const entryDate =
        formatDateOnly(
          req.body.entry_date ||
          req.body.entryDate ||
          req.body.date
        );

      const entryTime =
        formatTimeOnly(
          req.body.entry_time ||
          req.body.entryTime ||
          req.body.time
        ) ||
        currentServerTime();

      const flower =
        normalizeFlowerType(
          req.body.flower ||
          req.body.flower_type ||
          req.body.flowerType
        );

      const qty =
        Number(
          req.body.qty ||
          req.body.quantity ||
          req.body.quantity_kg ||
          req.body.quantityKg
        );

      const unit =
        req.body.unit
          ? String(
              req.body.unit
            ).trim()
          : "";

      const rateSlot =
        normalizeRateSlot(
          req.body.rate_slot ||
          req.body.rateSlot ||
          req.body.slot
        );

      const price =
        Number(
          req.body.price ||
          req.body.price_per_kg ||
          req.body.pricePerKg
        );

      const paid =
        typeof req.body.paid ===
        "boolean"
          ? req.body.paid
          : req.body.paid ===
            "true";

      const paidDate =
        formatDateOnly(
          req.body.paid_date ||
          req.body.paidDate
        );

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Supplier name is required.",
        });
      }

      if (!entryDate) {
        return res.status(400).json({
          success: false,
          message:
            "Valid date is required.",
        });
      }

      if (!flower) {
        return res.status(400).json({
          success: false,
          message:
            "Flower type is required.",
        });
      }

      if (
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Quantity must be greater than zero.",
        });
      }

      if (
        !Number.isFinite(price) ||
        price < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid price is required.",
        });
      }

      const amount =
        Number(
          (
            qty * price
          ).toFixed(2)
        );

      const result =
        await pool.query(
          `
          UPDATE entries

          SET

            name =
              $1,

            entry_date =
              $2,

            entry_time =
              $3,

            flower =
              $4,

            qty =
              $5,

            unit =
              $6,

            price =
              $7,

            amount =
              $8,

            paid =
              $9,

            paid_date =
              $10,

            rate_slot =
              COALESCE($11, rate_slot),

            updated_at =
              NOW()

          WHERE
            id = $12

            AND
            user_id = $13

          RETURNING

            id,
            name,
            entry_date,
            entry_time,
            flower,
            qty,
            unit,
            price,
            amount,
            rate_slot,
            paid,
            paid_date,
            updated_at
          `,
          [
            name,
            entryDate,
            entryTime,
            flower,
            qty,
            unit,
            price,
            amount,
            paid,
            paidDate,
            rateSlot,
            id,
            req.user.id,
          ]
        );

      if (
        result.rows.length ===
        0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Entry not found.",
        });
      }

      await syncEntriesJson();

      res.json({
        success: true,
        message:
          "Entry updated successfully.",
        entry:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Update entry error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not update entry.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// DELETE ENTRY
// ============================================================

app.delete(
  "/api/entries/:id",
  authMiddleware,
  async (req, res) => {
    try {
      const id =
        String(
          req.params.id || ""
        ).trim();

      if (!id) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid entry ID.",
        });
      }

      const result =
        await pool.query(
          `
          DELETE FROM entries

          WHERE
            id = $1

            AND
            user_id = $2

          RETURNING id
          `,
          [id, req.user.id]
        );

      if (
        result.rows.length ===
        0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Entry not found.",
        });
      }

      await syncEntriesJson();

      res.json({
        success: true,
        message:
          "Entry deleted successfully.",
        id,
      });
    } catch (error) {
      console.error(
        "Delete entry error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not delete entry.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// SERVE FRONTEND
// ============================================================

const frontendFolder =
  path.join(
    __dirname,
    "..",
    "flower-frontend"
  );

console.log(
  "Frontend folder:",
  frontendFolder
);

app.use(
  express.static(
    frontendFolder
  )
);

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        frontendFolder,
        "index.html"
      ),
      (error) => {
        if (error) {
          console.error(
            "Could not load frontend:",
            error
          );

          if (
            !res.headersSent
          ) {
            res.status(500).json({
              success: false,
              message:
                "Frontend index.html could not be loaded.",
            });
          }
        }
      }
    );
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      message:
        "API route not found.",
      path:
        req.path,
    });
  }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Server error:",
      error
    );

    if (
      !res.headersSent
    ) {
      res.status(500).json({
        success: false,
        message:
          "Internal server error.",
      });
    }
  }
);

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    await initializeDatabase();

    await syncAllJsonFiles();

    setInterval(
      syncAllJsonFiles,
      60 * 1000
    );

    app.listen(
      PORT,
      () => {
        console.log("");

        console.log(
          "======================================"
        );

        console.log(
          "       FLOWER LEDGER BACKEND"
        );

        console.log(
          "======================================"
        );

        console.log(
          `Server: http://localhost:${PORT}`
        );

        console.log(
          `Health: http://localhost:${PORT}/api/health`
        );

        console.log(
          "Database: Supabase PostgreSQL"
        );

        console.log(
          "Slot-based flower rates (1st/2nd/3rd): ENABLED"
        );

        console.log(
          "rate_slot on entry creation: OPTIONAL"
        );

        console.log(
          "Direct ledger editing: ENABLED"
        );

        console.log(
          "JSON mirror: ENABLED"
        );

        console.log(
          "Password reset: ENABLED"
        );

        console.log(
          "Auth session validated against users table: ENABLED"
        );

        console.log(
          "Logout endpoint: ENABLED"
        );

        console.log(
          "Google Sign-In (any Google account): " +
            (googleClient ? "ENABLED" : "disabled (set GOOGLE_CLIENT_ID in .env)")
        );

        console.log(
          "OTP email verification (password signup only): " +
            (BREVO_API_KEY && BREVO_SENDER_EMAIL
              ? "ENABLED (Brevo)"
              : "disabled (set BREVO_API_KEY and BREVO_SENDER_EMAIL in .env)")
        );

        console.log(
          "DB keep-alive ping: ENABLED (every 4 min)"
        );

        console.log(
          process.env.SELF_PING_URL
            ? "Self-ping: ENABLED (every 10 min)"
            : "Self-ping: disabled (set SELF_PING_URL in .env to enable)"
        );

        console.log(
          "Status: RUNNING"
        );

        console.log(
          "======================================"
        );

        console.log("");
      }
    );
  } catch (error) {
    console.error("");

    console.error(
      "FAILED TO START SERVER"
    );

    console.error(error);

    console.error("");

    process.exit(1);
  }
}

startServer();

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on(
  "SIGINT",
  async () => {
    console.log(
      "Shutting down..."
    );

    await pool.end();

    process.exit(0);
  }
);

process.on(
  "SIGTERM",
  async () => {
    console.log(
      "Shutting down..."
    );

    await pool.end();

    process.exit(0);
  }
);