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
        created_at,
        updated_at

      FROM flower_rates

      ORDER BY
        rate_date DESC,
        rate_time DESC,
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

    // Remove old indexes if they exist.
    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_date_unique;
    `);

    await client.query(`
      DROP INDEX IF EXISTS
      flower_rates_flower_unique;
    `);

    // One rate for:
    // FLOWER + DATE + TIME
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      flower_rates_flower_date_time_unique
      ON flower_rates
      (
        flower,
        rate_date,
        rate_time
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
        unit TEXT DEFAULT 'kg',
        price NUMERIC(12,2) NOT NULL DEFAULT 0,
        amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        paid BOOLEAN DEFAULT FALSE,
        paid_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
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
            username

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
        return res.status(404).json({
          success: false,
          message:
            "Username not found.",
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
// If date + time are provided:
//
// Returns the latest rate active at that time.
//
// Example:
//
// 08:00 ₹80
// 13:00 ₹100
//
// Asking for 10:00 -> ₹80
// Asking for 15:00 -> ₹100
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
      // EXACT DATE + TIME
      // ------------------------------------------------------

      if (date) {
        const atTime =
          at ||
          "23:59:59";

        const result =
          await pool.query(
            `
            SELECT DISTINCT ON (flower)

              id,
              flower,
              name,
              english_name,
              rate_date,
              rate_time,
              price,
              created_at,
              updated_at

            FROM flower_rates

            WHERE
              rate_date = $1

              AND
              rate_time <= $2::time

            ORDER BY
              flower,
              rate_time DESC,
              id DESC
            `,
            [
              date,
              atTime,
            ]
          );

        return res.json({
          success: true,
          date,
          at:
            atTime,
          rates:
            result.rows,
        });
      }

      // ------------------------------------------------------
      // DATE RANGE
      // ------------------------------------------------------

      const params = [];

      const conditions = [];

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
        conditions.length
          ? `WHERE ${conditions.join(
              " AND "
            )}`
          : "";

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
            price,
            created_at,
            updated_at

          FROM flower_rates

          ${where}

          ORDER BY
            rate_date DESC,
            rate_time DESC,
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
            price

          FROM flower_rates

          WHERE
            flower = $1

            AND
            rate_date = $2

            AND
            rate_time <= $3::time

          ORDER BY
            rate_time DESC,
            id DESC

          LIMIT 1
          `,
          [
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
// Multiple rates per day are allowed.
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
            NOW()
          )

          ON CONFLICT
          (
            flower,
            rate_date,
            rate_time
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

            updated_at =
              NOW()

          RETURNING
            id,
            flower,
            name,
            english_name,
            rate_date,
            rate_time,
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
          ]
        );

      await syncRatesJson();

      res.json({
        success: true,
        message:
          "Flower rate saved successfully.",
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
// The entry price is automatically determined from:
//
// FLOWER + ENTRY DATE + ENTRY TIME
//
// Example:
//
// Malli
// 25 Aug
// 08:00
//
// If rates are:
//
// 07:00 -> ₹80
// 13:00 -> ₹100
//
// Entry gets ₹80.
//
// An entry at 15:00 gets ₹100.
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
          : "kg";

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
      // FIND THE RATE SELECTED FROM THE RATE / TIME DROPDOWN
      // ======================================================

      // Frontend sends the selected flower rate time.
      const selectedRateTime =
        formatTimeOnly(
          req.body.rate_time ||
          req.body.rateTime
        );

      // If a rate is selected from the dropdown, find that exact rate.
      // Otherwise, fall back to the normal entry-time lookup.
      let rateResult;

      if (selectedRateTime) {

        rateResult = await pool.query(
          `
          SELECT
            price,
            rate_date,
            rate_time

          FROM flower_rates

          WHERE
            flower = $1

            AND
            rate_date = $2

            AND
            rate_time = $3::time

          ORDER BY
            id DESC

          LIMIT 1
          `,
          [
            flower,
            entryDate,
            selectedRateTime,
          ]
        );

      } else {

        rateResult = await pool.query(
          `
          SELECT
            price,
            rate_date,
            rate_time

          FROM flower_rates

          WHERE
            flower = $1

            AND
            rate_date = $2

            AND
            rate_time <= $3::time

          ORDER BY
            rate_time DESC,
            id DESC

          LIMIT 1
          `,
          [
            flower,
            entryDate,
            entryTime,
          ]
        );

      }

      if (
        rateResult.rows.length ===
        0
      ) {
        return res.status(400).json({
          success: false,
          code:
            "FLOWER_RATE_MISSING",

          message:
            `Please enter the ${flower} rate for ${entryDate} before adding this entry.`,

          flower,
          date:
            entryDate,
          time:
            entryTime,
        });
      }

      const price =
        Number(
          rateResult.rows[0].price
        );

      if (
        !Number.isFinite(price) ||
        price < 0
      ) {
        return res.status(400).json({
          success: false,
          code:
            "INVALID_FLOWER_RATE",

          message:
            "The flower rate is invalid. Please update the rate before adding the entry.",
        });
      }

      const amount =
        Number(
          (
            qty * price
          ).toFixed(2)
        );

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
            amount
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
            $9
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
          ]
        );

      await syncEntriesJson();

      res.status(201).json({
        success: true,
        message:
          "Entry added successfully.",
        entry:
          result.rows[0],
      });
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

      const params = [];

      const conditions = [];

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
        conditions.length
          ? `WHERE ${conditions.join(
              " AND "
            )}`
          : "";

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

      const params = [];

      const conditions = [];

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
        conditions.length
          ? `WHERE ${conditions.join(
              " AND "
            )}`
          : "";

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
            paid,
            paid_date,
            created_at

          FROM entries

          WHERE
            name ILIKE $1

          ORDER BY
            entry_date DESC,
            created_at DESC
          `,
          [name]
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
            paid,
            paid_date

          FROM entries

          WHERE
            name ILIKE $1

          ORDER BY
            entry_date DESC,
            created_at DESC
          `,
          [
            `%${q}%`,
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
          : "kg";

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

            updated_at =
              NOW()

          WHERE
            id = $11

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
            id,
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

          WHERE id = $1

          RETURNING id
          `,
          [id]
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
          "Multiple daily flower rates: ENABLED"
        );

        console.log(
          "Rate date + time: ENABLED"
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