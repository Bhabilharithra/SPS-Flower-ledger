// ============================================================
// db.js
// S.P.S. MALARAGAM - SUPABASE DATABASE LAYER
//
// Database:
//   Supabase PostgreSQL
//
// Tables:
//   users
//   entries
//   flower_rates
// ============================================================

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// ============================================================
// SUPABASE CONFIGURATION
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is missing in .env");
}

if (!SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is missing in .env");
}

// IMPORTANT:
// SECRET KEY MUST ONLY BE USED BY THE BACKEND.
// NEVER PUT SUPABASE_SECRET_KEY IN index.html.

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ============================================================
// ERROR HELPER
// ============================================================

function checkError(error, action) {
  if (!error) return;

  console.error(`Supabase ${action} error:`);
  console.error(error);

  throw new Error(
    error.message || `Could not ${action}`
  );
}

// ============================================================
// ENTRIES
// ============================================================

async function getAll() {
  const { data, error } = await supabase
    .from("entries")
    .select("*")
    .order("entry_date", {
      ascending: false,
    })
    .order("entry_time", {
      ascending: false,
    });

  checkError(error, "load entries");

  return (data || []).map(mapEntryFromDatabase);
}

// ============================================================
// GET ONE ENTRY
// ============================================================

async function getEntry(id) {
  if (!id) return null;

  const { data, error } = await supabase
    .from("entries")
    .select("*")
    .eq("id", String(id))
    .maybeSingle();

  checkError(error, "load entry");

  if (!data) {
    return null;
  }

  return mapEntryFromDatabase(data);
}

// ============================================================
// CREATE / UPDATE ENTRY
// ============================================================

async function upsert(entry) {
  if (!entry) {
    throw new Error("Entry is required");
  }

  if (!entry.id) {
    throw new Error("Entry id is required");
  }

  const record = mapEntryToDatabase(entry);

  const { data, error } = await supabase
    .from("entries")
    .upsert(record, {
      onConflict: "id",
    })
    .select()
    .single();

  checkError(error, "save entry");

  return mapEntryFromDatabase(data);
}

// ============================================================
// DELETE ENTRY
// ============================================================

async function remove(id) {
  if (!id) {
    throw new Error("Entry id is required");
  }

  const { error } = await supabase
    .from("entries")
    .delete()
    .eq("id", String(id));

  checkError(error, "delete entry");

  return true;
}

// ============================================================
// MARK ENTRIES AS PAID
// ============================================================

async function settle(ids, paidDate) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const cleanIds = ids
    .filter(Boolean)
    .map((id) => String(id));

  if (cleanIds.length === 0) {
    return [];
  }

  const date =
    paidDate ||
    new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("entries")
    .update({
      paid: true,
      paid_date: date,
      updated_at: new Date().toISOString(),
    })
    .in("id", cleanIds)
    .select();

  checkError(error, "settle entries");

  return (data || []).map(mapEntryFromDatabase);
}

// ============================================================
// USERS
// ============================================================

async function getUsers() {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .order("created_at", {
      ascending: true,
    });

  checkError(error, "load users");

  return (data || []).map(mapUserFromDatabase);
}

// ============================================================
// FIND USER
// ============================================================

async function findUserByUsername(username) {
  const cleanUsername = String(username || "")
    .trim()
    .toLowerCase();

  if (!cleanUsername) {
    return null;
  }

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("username", cleanUsername)
    .maybeSingle();

  checkError(error, "find user");

  if (!data) {
    return null;
  }

  return mapUserFromDatabase(data);
}

// ============================================================
// CREATE USER
// ============================================================

async function createUser({
  username,
  name,
  passwordHash,
}) {
  const cleanUsername = String(username || "")
    .trim()
    .toLowerCase();

  const cleanName = String(name || "")
    .trim();

  if (!cleanUsername) {
    throw new Error("Username is required");
  }

  if (cleanUsername.length < 3) {
    throw new Error(
      "Username must contain at least 3 characters"
    );
  }

  if (!passwordHash) {
    throw new Error("Password hash is required");
  }

  const existing =
    await findUserByUsername(cleanUsername);

  if (existing) {
    throw new Error("Username already exists");
  }

  const { data, error } = await supabase
    .from("users")
    .insert({
      username: cleanUsername,
      name: cleanName || cleanUsername,
      password_hash: passwordHash,
      picture: null,
      google: false,
    })
    .select()
    .single();

  checkError(error, "create user");

  return mapUserFromDatabase(data);
}

// ============================================================
// SAVE USERS
// Compatibility function
// ============================================================

async function saveUsers(users) {
  if (!Array.isArray(users)) {
    throw new Error("Users must be an array");
  }

  for (const user of users) {
    if (!user || !user.username) {
      continue;
    }

    const username = String(user.username)
      .trim()
      .toLowerCase();

    const existing =
      await findUserByUsername(username);

    const record = {
      username,
      name:
        String(user.name || username).trim(),
      password_hash:
        user.passwordHash ||
        user.password_hash ||
        "",
      picture:
        user.picture || null,
      google:
        user.google === true,
    };

    if (existing) {
      const { error } = await supabase
        .from("users")
        .update({
          name: record.name,
          password_hash: record.password_hash,
          picture: record.picture,
          google: record.google,
        })
        .eq("username", username);

      checkError(error, "update user");
    } else {
      const { error } = await supabase
        .from("users")
        .insert(record);

      checkError(error, "insert user");
    }
  }

  return true;
}

// ============================================================
// GOOGLE USER
//
// Google login is currently disabled in your project,
// but this function is kept for future use.
// ============================================================

async function findOrCreateGoogleUser({
  email,
  name,
  picture,
}) {
  const cleanEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (!cleanEmail) {
    throw new Error("Google email is required");
  }

  const existing =
    await findUserByUsername(cleanEmail);

  if (existing) {
    const { data, error } = await supabase
      .from("users")
      .update({
        name:
          name ||
          existing.name ||
          cleanEmail,
        picture:
          picture ||
          existing.picture ||
          null,
        google: true,
      })
      .eq("username", cleanEmail)
      .select()
      .single();

    checkError(
      error,
      "update Google user"
    );

    return mapUserFromDatabase(data);
  }

  const { data, error } = await supabase
    .from("users")
    .insert({
      username: cleanEmail,
      name: name || cleanEmail,
      password_hash: "",
      picture: picture || null,
      google: true,
    })
    .select()
    .single();

  checkError(
    error,
    "create Google user"
  );

  return mapUserFromDatabase(data);
}

// ============================================================
// FLOWER RATES
// ============================================================

async function getRates() {
  const { data, error } = await supabase
    .from("flower_rates")
    .select("*")
    .order("name", {
      ascending: true,
    });

  checkError(error, "load flower rates");

  return (data || []).map(
    mapRateFromDatabase
  );
}

// ============================================================
// GET ONE FLOWER RATE
// ============================================================

async function getRate(flower) {
  const cleanFlower = String(flower || "")
    .trim();

  if (!cleanFlower) {
    return null;
  }

  const { data, error } = await supabase
    .from("flower_rates")
    .select("*")
    .eq("flower", cleanFlower)
    .maybeSingle();

  checkError(error, "load flower rate");

  if (!data) {
    return null;
  }

  return mapRateFromDatabase(data);
}

// ============================================================
// SAVE / UPDATE FLOWER RATE
// ============================================================

async function upsertRate({
  flower,
  name,
  englishName,
  price,
  date,
}) {
  const cleanFlower = String(flower || "")
    .trim();

  if (!cleanFlower) {
    throw new Error(
      "Flower name is required"
    );
  }

  const numericPrice = Number(price);

  if (
    Number.isNaN(numericPrice) ||
    numericPrice < 0
  ) {
    throw new Error(
      "Price must be a valid number"
    );
  }

  if (!date) {
    throw new Error(
      "Rate date is required"
    );
  }

  const record = {
    flower: cleanFlower,

    name:
      String(name || cleanFlower).trim(),

    english_name:
      String(englishName || "").trim(),

    price: numericPrice,

    rate_date: date,

    updated_at:
      new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("flower_rates")
    .upsert(record, {
      onConflict: "flower",
    })
    .select()
    .single();

  checkError(
    error,
    "save flower rate"
  );

  return mapRateFromDatabase(data);
}

// ============================================================
// SAVE MULTIPLE FLOWER RATES
// ============================================================

async function saveFlowerRates(rateList) {
  if (!Array.isArray(rateList)) {
    throw new Error(
      "Rates must be an array"
    );
  }

  const records = rateList
    .filter(
      (rate) =>
        rate &&
        String(rate.flower || "").trim()
    )
    .map((rate) => {
      const flower = String(
        rate.flower
      ).trim();

      const price = Number(rate.price);

      if (
        Number.isNaN(price) ||
        price < 0
      ) {
        throw new Error(
          `Invalid price for ${flower}`
        );
      }

      if (!rate.date) {
        throw new Error(
          `Date is required for ${flower}`
        );
      }

      return {
        flower,

        name:
          String(
            rate.name || flower
          ).trim(),

        english_name:
          String(
            rate.englishName || ""
          ).trim(),

        price,

        rate_date: rate.date,

        updated_at:
          new Date().toISOString(),
      };
    });

  if (records.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("flower_rates")
    .upsert(records, {
      onConflict: "flower",
    })
    .select();

  checkError(
    error,
    "save flower rates"
  );

  return (data || []).map(
    mapRateFromDatabase
  );
}

// ============================================================
// DELETE FLOWER RATE
// ============================================================

async function removeRate(flower) {
  const cleanFlower = String(flower || "")
    .trim();

  if (!cleanFlower) {
    return false;
  }

  const { error } = await supabase
    .from("flower_rates")
    .delete()
    .eq("flower", cleanFlower);

  checkError(
    error,
    "delete flower rate"
  );

  return true;
}

// ============================================================
// ENTRY MAPPING
// ============================================================

function mapEntryToDatabase(entry) {
  const qty = Number(entry.qty) || 0;
  const price = Number(entry.price) || 0;

  const amount =
    entry.amount !== undefined
      ? Number(entry.amount) || 0
      : qty * price;

  return {
    id: String(entry.id),

    name:
      String(entry.name || "").trim(),

    entry_date:
      entry.date ||
      entry.entry_date ||
      new Date()
        .toISOString()
        .slice(0, 10),

    entry_time:
      entry.time ||
      entry.entry_time ||
      "",

    flower:
      String(entry.flower || "").trim(),

    qty,

    unit:
      entry.unit || "kg",

    price,

    amount,

    paid:
      entry.paid === true,

    paid_date:
      entry.paidDate ||
      entry.paid_date ||
      null,

    updated_at:
      new Date().toISOString(),
  };
}

function mapEntryFromDatabase(entry) {
  return {
    id: entry.id,

    name:
      entry.name || "",

    date:
      entry.entry_date,

    time:
      entry.entry_time || "",

    flower:
      entry.flower || "",

    qty:
      Number(entry.qty) || 0,

    unit:
      entry.unit || "kg",

    price:
      Number(entry.price) || 0,

    amount:
      Number(entry.amount) || 0,

    paid:
      entry.paid === true,

    paidDate:
      entry.paid_date || null,
  };
}

// ============================================================
// USER MAPPING
// ============================================================

function mapUserFromDatabase(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,

    username:
      user.username,

    name:
      user.name ||
      user.username,

    passwordHash:
      user.password_hash ||
      null,

    picture:
      user.picture ||
      null,

    google:
      user.google === true,

    createdAt:
      user.created_at ||
      null,
  };
}

// ============================================================
// FLOWER RATE MAPPING
// ============================================================

function mapRateFromDatabase(rate) {
  if (!rate) {
    return null;
  }

  return {
    id: rate.id,

    flower:
      rate.flower,

    name:
      rate.name ||
      rate.flower,

    englishName:
      rate.english_name ||
      "",

    price:
      Number(rate.price) || 0,

    date:
      rate.rate_date,

    createdAt:
      rate.created_at ||
      null,

    updatedAt:
      rate.updated_at ||
      null,
  };
}

// ============================================================
// DATABASE CONNECTION TEST
// ============================================================

async function testConnection() {
  try {
    const { error } = await supabase
      .from("flower_rates")
      .select("id")
      .limit(1);

    if (error) {
      console.error(
        "❌ Supabase connection failed:"
      );

      console.error(error.message);

      return false;
    }

    console.log(
      "✅ Supabase database connected successfully."
    );

    return true;
  } catch (error) {
    console.error(
      "❌ Supabase connection exception:"
    );

    console.error(error);

    return false;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Supabase
  supabase,
  testConnection,

  // Entries
  getAll,
  getEntry,
  upsert,
  remove,
  settle,

  // Users
  getUsers,
  saveUsers,
  findUserByUsername,
  createUser,
  findOrCreateGoogleUser,

  // Flower rates
  getRates,
  getRate,
  upsertRate,
  saveFlowerRates,
  removeRate,
};