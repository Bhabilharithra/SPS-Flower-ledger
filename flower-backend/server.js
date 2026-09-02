require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

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
});

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

async function syncUsersJson() {
  const result =
    await pool.query(`
      SELECT
        id,
        username,
        name,
        picture,
        google,
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
    // FLOWER RATES
    // ========================================================
    //
    // IMPORTANT:
    //
    // A flower can have MULTIPLE rates on the same date.
    //
    // Example:
    //
    // Malli
    // 25 Aug 2026
    // 07:00 AM
    // ₹80
    //
    // Malli
    // 25 Aug 2026
    // 01:00 PM
    // ₹100
    //
    // Both are stored.
    //
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

    // Remove the OLD unique restriction
    // that allowed only one rate per flower.
    await client.query(`
      ALTER TABLE flower_rates
      DROP CONSTRAINT IF EXISTS
      flower_rates_flower_key;
    `);

    // Add rate_time to existing databases.
    await client.query(`
      ALTER TABLE flower_rates
      ADD COLUMN IF NOT EXISTS
      rate_time TIME;
    `);

    // Existing rates are treated as midnight.
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

    // ========================================================
    // RATE SLOTS (1st / 2nd / 3rd Rate)
    // ========================================================
    //
    // BUG FIX + WORKFLOW CHANGE:
    //
    // Previously, entries were matched to a flower_rates row by
    // clock TIME (rate_time), and the New Flower Entry dropdown
    // only showed rate options that already existed - so it had
    // to be disabled/hidden until a rate was saved.
    //
    // The new workflow always shows exactly three fixed slots -
    // "1st Rate", "2nd Rate", "3rd Rate" - for every flower/date,
    // even before any price has been entered. The user picks a
    // slot up front; the entry is stored as "Pending" against
    // that slot until a matching price is saved later.
    //
    // rate_slot (1, 2, or 3) is the new join key between
    // flower_rates and entries, replacing rate_time for this
    // purpose. rate_time is kept only as an informational
    // timestamp (auto-set to when the rate was saved) - it is no
    // longer used to decide which entries get which price.
    // ========================================================

    await client.query(`
      ALTER TABLE flower_rates
      ADD COLUMN IF NOT EXISTS
      rate_slot SMALLINT;
    `);

    // Backfill rate_slot for pre-existing rows: order each
    // flower/date's rates by rate_time and number them 1, 2, 3.
    // Anything beyond a 3rd rate on the same day (rare legacy
    // data) is clipped into slot 3.
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

    // Safety cleanup so the new unique index below can never
    // fail: if legacy data ever produced two rows clipped into
    // the same (flower, rate_date, rate_slot), keep only the
    // most recently saved row.
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

    // Remove old indexes if they exist.
    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_unique;
    `);

    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_unique;
    `);

    // Old time-based unique key is retired in favour of the
    // slot-based key below.
    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_time_unique;
    `);

    // ========================================================
    // USER OWNERSHIP ON FLOWER_RATES
    // ========================================================
    //
    // WORKFLOW CHANGE:
    //
    // Rates were previously global - one shared price list for
    // every login. Saving a rate under any account backfilled
    // EVERY account's pending entries for that flower/date/slot.
    //
    // Each login now keeps its own independent rate list: rates
    // are scoped by user_id, and the backfill in POST /api/rates
    // only ever updates that same account's own pending entries.
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

    // Old shared-across-everyone unique key is retired - a rate
    // is now unique per (user, flower, date, slot) instead.
    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_slot_unique;
    `);

    // One rate for:
    // USER + FLOWER + DATE + SLOT (1st / 2nd / 3rd)
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

    // ========================================================
    // ALLOW PENDING ENTRIES (NULL price / amount)
    // ========================================================
    //
    // Entries created before a flower rate has been saved for
    // that flower/date need to be insertable with price = NULL
    // and amount = NULL, showing as "Pending" in the frontend
    // until a matching rate is saved (see POST /api/rates,
    // which then backfills these rows).
    //
    // These ALTER statements are idempotent - safe to run on
    // every startup, whether the columns are already nullable
    // or not.
    // ========================================================

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

    // ========================================================
    // STOP DEFAULTING / LABELING UNIT AS "kg"
    // ========================================================
    //
    // Quantity is not measured in kg for this ledger, so the
    // "kg" default/wording is removed. Existing rows that were
    // previously stamped with the old default are cleared too.
    // ========================================================

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

    // ========================================================
    // USER OWNERSHIP ON ENTRIES
    // ========================================================
    //
    // SECURITY FIX:
    //
    // Entries previously had no owner column at all, so every
    // logged-in user could see and query every other user's
    // entries (GET /api/entries, /api/summary, supplier search,
    // etc. returned the whole table to anyone with a valid
    // token). user_id now records which account created the
    // entry, and every entries route below filters by
    // req.user.id so each login only ever sees its own data.
    //
    // NOTE: entries created before this fix have user_id = NULL
    // and will not appear for ANY user until they are manually
    // reassigned - this is intentional, since we cannot safely
    // guess which account they used to belong to, and showing
    // them to everyone would repeat the original leak.
    // ========================================================

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

    // ========================================================
    // RATE SLOT ON ENTRIES
    // ========================================================
    //
    // Records which dropdown slot (1st / 2nd / 3rd Rate) the
    // entry was saved against. This is what the backfill in
    // POST /api/rates matches on, fixing the bug where saving
    // one slot's price used to overwrite entries saved under a
    // different slot.
    // ========================================================

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

  // MULLAI
  if (
    v === "mullai" ||
    v === "முல்லை" ||
    v.includes("mullai")
  ) {
    return "Mullai";
  }

  // ROYAL JASMINE / PICHI
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

  // MALLI
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

  // HTML date:
  // YYYY-MM-DD
  const match =
    str.match(
      /^(\d{4}-\d{2}-\d{2})/
    );

  if (match) {
    return match[1];
  }

  // MM/DD/YYYY fallback
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
//
// Accepts a number (1, 2, 3), a numeric string ("1", "2", "3"),
// or a label ("1st", "1st Rate", "2nd Rate", "3rd Rate", etc.)
// and returns a clean integer 1-3, or null if it can't be
// parsed / is out of range / was not supplied at all (rate_slot
// is OPTIONAL on entry creation - see POST /api/entries).
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

function authMiddleware(
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
    req.user =
      jwt.verify(
        token,
        JWT_SECRET
      );

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
// REGISTER
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

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !name ||
        !username ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Name, username and password are required.",
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

      const existing =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE LOWER(username)
                = LOWER($1)
          LIMIT 1
          `,
          [username]
        );

      if (
        existing.rows.length >
        0
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Username already exists.",
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const result =
        await pool.query(
          `
          INSERT INTO users
          (
            name,
            username,
            password_hash
          )

          VALUES
          (
            $1,
            $2,
            $3
          )

          RETURNING
            id,
            name,
            username,
            created_at
          `,
          [
            name,
            username,
            passwordHash,
          ]
        );

      const user =
        result.rows[0];

      await syncUsersJson();

      const token =
        createToken(user);

      res.status(201).json({
        success: true,
        message:
          "Account created successfully.",
        token,
        user,
      });
    } catch (error) {
      console.error(
        "Register error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Could not create account.",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// RESET PASSWORD
// ============================================================
//
// SECURITY FIX:
//
// This route previously reset a user's password from just their
// username, with no proof that the caller actually owned the
// account. Anyone who knew (or guessed) a valid username could
// take over that account.
//
// It now requires the account's CURRENT password and verifies it
// with bcrypt before allowing the change. A wrong username and a
// wrong current password both return the same generic 401 message
// so the endpoint cannot be used to discover which usernames exist.
//
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
    try {
      const username =
        String(
          req.body.username ||
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
        !username ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Username and password are required.",
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            username,
            password_hash,
            created_at

          FROM users

          WHERE LOWER(username)
                = LOWER($1)

          LIMIT 1
          `,
          [username]
        );

      let user =
        result.rows[0];

      // ======================================================
      // ENV ADMIN FALLBACK
      // ======================================================

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
          username ===
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

      const passwordOK =
        await bcrypt.compare(
          password,
          user.password_hash
        );

      if (!passwordOK) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid username or password.",
        });
      }

      delete user.password_hash;

      const token =
        createToken(user);

      res.json({
        success: true,
        message:
          "Login successful.",
        token,
        user,
      });
    } catch (error) {
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
// CURRENT USER
// ============================================================

app.get(
  "/api/me",
  authMiddleware,
  async (req, res) => {
    res.json({
      success: true,
      user:
        req.user,
    });
  }
);

// ============================================================
// GET FLOWER RATES
// ============================================================
//
// If date is provided (with or without "at"):
//
// Returns EVERY saved rate row for that date (all three slots),
// optionally limited to rates at-or-before the given "at" time.
//
// This intentionally does NOT collapse to a single "latest" row
// per flower, because the flower-ledger UI shows up to three
// saved rate slots (1st / 2nd / 3rd) per flower per day and needs
// all of them, not just the most recent one.
//
// Example:
//
// 1st Rate -> ₹80
// 2nd Rate -> ₹100
//
// GET /api/rates?date=2026-08-25
//   -> returns BOTH rows for that date.
//
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

      // ------------------------------------------------------
      // EXACT DATE (optionally filtered by time-of-day)
      // ------------------------------------------------------
      //
      // IMPORTANT: previously this branch used
      // "SELECT DISTINCT ON (flower) ... ORDER BY flower, rate_time DESC"
      // which collapsed the result to a single row per flower —
      // only the latest rate at-or-before the requested time.
      // That silently dropped the 1st/2nd/3rd rate slots the
      // frontend rate cards rely on. Now every matching row is
      // returned; the caller can pick "latest per flower" itself
      // if that's ever what it needs.
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // DATE RANGE
      // ------------------------------------------------------

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
//
// This endpoint intentionally DOES still return only the single
// latest rate at-or-before the given time for one named flower —
// that is its documented purpose (e.g. "what rate applies right
// now for Malli"), unlike the list endpoint above which now
// returns every saved slot for a date.
//
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
//
// Every rate is now saved against one of three fixed slots -
// 1st Rate, 2nd Rate, 3rd Rate - for a given flower + date,
// instead of a free-form clock time. rate_slot is required.
//
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

      // rate_time is kept only as an informational timestamp
      // (when this slot's price was saved) - it is no longer
      // part of the matching logic.
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

      // ======================================================
      // BACKFILL PENDING ENTRIES (SAME LOGIN ONLY)
      // ======================================================
      //
      // WORKFLOW (rate_slot optional on entries, rates scoped
      // per login):
      //
      // Entries can be added at any time WITHOUT picking a rate
      // slot up front - rate_slot is left NULL on the entry.
      // Whenever THIS account saves a rate for that flower +
      // date, every still-pending slot-less entry belonging to
      // THIS SAME account for that flower + date gets this
      // price applied.
      //
      // If an entry DOES have a specific rate_slot recorded
      // (either chosen at creation time or set explicitly via
      // edit), it is only backfilled by a rate saved under that
      // exact same slot - this preserves the original bug fix
      // where saving the 1st Rate must not overwrite an entry
      // that was tied to the 2nd or 3rd Rate.
      //
      // The "price IS NULL OR (price = 0 AND amount = 0)" guard
      // means once a slot-less entry is backfilled by whichever
      // rate is saved first for that date, later rate saves for
      // other slots on the same date will not re-overwrite it.
      //
      // user_id = $5 is the critical scoping condition: rates
      // are now per-account, so saving a rate NEVER touches
      // another login's entries, even if they logged the same
      // flower on the same date.
      // ======================================================

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
//
// WORKFLOW (rate_slot is OPTIONAL):
//
// The caller MAY pick a slot (rate_slot: 1, 2, or 3) up front,
// or leave it unset to add the entry with no rate decided yet -
// this supports "add entries for many days first, then fix the
// price by date later".
//
// - rate_slot provided + a price already exists for that
//   flower + date + slot -> entry is saved with that price
//   immediately.
// - rate_slot provided + no matching price yet -> entry is
//   created as "Pending" (price/amount NULL) and gets
//   backfilled only when THIS SAME account saves that exact
//   slot's rate (see the UPDATE in POST /api/rates).
// - rate_slot NOT provided -> entry is created as "Pending"
//   with rate_slot left NULL, price/amount NULL. It gets
//   backfilled by whichever rate (1st/2nd/3rd) THIS SAME
//   account saves FIRST for that flower + date (POST /api/rates
//   matches entries where rate_slot IS NULL OR rate_slot =
//   <slot just saved>, AND user_id = the account saving it).
//
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

      // IMPORTANT:
      // Frontend sends the time as req.body.time.
      // Accept all supported time field names.
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

      // ======================================================
      // RATE SLOT (OPTIONAL)
      // ======================================================
      //
      // The dropdown may offer "1st Rate", "2nd Rate", "3rd
      // Rate" - or the caller can skip it entirely. If none is
      // sent (or it doesn't parse to 1/2/3), normalizeRateSlot
      // returns null and the entry is saved with rate_slot NULL,
      // to be priced later.
      // ======================================================

      const rateSlot =
        normalizeRateSlot(
          req.body.rate_slot ||
          req.body.rateSlot ||
          req.body.slot
        );

      let price = null;
      let amount = null;

      // Only attempt to match an existing price if a specific
      // slot was chosen. A slot-less entry has nothing to match
      // against yet and simply stays Pending until any rate is
      // saved for this flower + date (see the backfill UPDATE
      // in POST /api/rates above).
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

        // ====================================================
        // NO MATCHING RATE YET -> CREATE AS "PENDING"
        // ====================================================
        //
        // The entry is still created, with price/amount left
        // NULL, and gets backfilled automatically once a
        // matching rate is saved for this exact slot (see the
        // UPDATE in POST /api/rates above).
        // ====================================================

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

      // SECURITY: every entries query is scoped to the logged-in
      // account, so one login can never see another login's data.
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

      // SECURITY: summary totals are scoped to the logged-in
      // account, so one login never sees another login's totals.
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
//
// IMPORTANT:
//
// This edits the EXISTING ledger entry.
//
// It does NOT require you to create another flower rate.
//
// You can change:
//
// Supplier
// Date
// Time
// Flower
// KG
// Price
// Rate slot (1st / 2nd / 3rd Rate)
//
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

      // IMPORTANT:
      // Frontend sends the time as req.body.time.
      // Accept all supported time field names.
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

      // Rate slot can also be changed on edit. If not supplied,
      // keep whatever the entry already has.
      const rateSlot =
        normalizeRateSlot(
          req.body.rate_slot ||
          req.body.rateSlot ||
          req.body.slot
        );

      // ------------------------------------------------------
      // IMPORTANT:
      // Editing an existing ledger entry allows direct
      // price modification.
      //
      // We do NOT force another flower-rate lookup here.
      // ------------------------------------------------------

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

      // SECURITY: a 0-row result here means either the entry
      // doesn't exist, OR it belongs to a different login - both
      // cases return the same generic "not found" so one account
      // can't probe for another account's entry IDs.
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

      // SECURITY: same generic "not found" whether the entry
      // never existed or belongs to a different login.
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

    // Sync JSON mirror every minute.
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