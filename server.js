/* =========================================
   STUFFONE BACKEND — V2
   Améliorations:
   - SQLite (better-sqlite3) au lieu de JSON
   - Déduplication côté serveur
   - Pagination (?page=1&limit=20)
   - Compression gzip (responses)
   - API key via variable d'environnement
   - Détection automatique du type de page
   - Recherche étendue (title + category + type)
========================================= */

require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const zlib       = require("zlib");
const Database   = require("better-sqlite3");

const app = express();

/* =========================================
   CONFIG
========================================= */

app.use(cors());

app.use(express.json({ limit: "50mb" }));

app.use(express.urlencoded({ extended: true, limit: "50mb" }));

/* =========================================
   API KEY
   → Mettre STUFFONE_API_KEY dans Railway
     Variables d'environnement
========================================= */

const API_KEY = process.env.STUFFONE_API_KEY;

if(!API_KEY){
  console.warn("[WARN] STUFFONE_API_KEY non définie dans .env");
}

/* =========================================
   AUTH
========================================= */

function authenticate(req, res, next){

  const clientKey = req.headers["x-api-key"];

  if(clientKey !== API_KEY){
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();

}

/* =========================================
   BASE DE DONNÉES SQLITE
========================================= */

const DB_PATH = path.join(__dirname, "stuffone.db");

const db = new Database(DB_PATH);

// Activer WAL pour de meilleures performances
db.pragma("journal_mode = WAL");

// Créer la table si elle n'existe pas
db.exec(`
  CREATE TABLE IF NOT EXISTS structures (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL DEFAULT '',
    category   TEXT    NOT NULL DEFAULT '',
    type       TEXT    NOT NULL DEFAULT '',
    html       BLOB,
    css        BLOB,
    js         BLOB,
    createdAt  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_title    ON structures(title);
  CREATE INDEX IF NOT EXISTS idx_category ON structures(category);
  CREATE INDEX IF NOT EXISTS idx_type     ON structures(type);
`);

/* =========================================
   COMPRESSION / DÉCOMPRESSION
========================================= */

function compress(text){
  if(!text) return null;
  return zlib.gzipSync(Buffer.from(text, "utf8"));
}

function decompress(buffer){
  if(!buffer) return "";
  try {
    return zlib.gunzipSync(buffer).toString("utf8");
  } catch {
    // Ancien texte non compressé
    return buffer.toString("utf8");
  }
}

/* =========================================
   DÉTECTION AUTOMATIQUE DU TYPE DE PAGE
========================================= */

function detectType(html = "", category = ""){

  const h = html.toLowerCase();

  // Détection par mots-clés HTML
  const rules = [
    { type: "navbar",    keywords: ["<nav", "navbar", "navigation", "menu-bar", "topbar", "header"] },
    { type: "hero",      keywords: ["hero", "banner", "jumbotron", "headline", "get-started", "cta-main"] },
    { type: "footer",    keywords: ["<footer", "footer"] },
    { type: "pricing",   keywords: ["pricing", "plan", "subscribe", "per month", "/mo", "€/mois"] },
    { type: "contact",   keywords: ["contact", "form", "<input", "send message", "get in touch"] },
    { type: "auth",      keywords: ["login", "sign in", "sign up", "register", "password", "forgot"] },
    { type: "dashboard", keywords: ["dashboard", "analytics", "chart", "widget", "stats", "metric"] },
    { type: "portfolio", keywords: ["portfolio", "projects", "work", "case study", "my work"] },
    { type: "blog",      keywords: ["blog", "article", "post", "read more", "published"] },
    { type: "ecommerce", keywords: ["cart", "add to cart", "buy now", "shop", "product", "checkout"] },
  ];

  for(const rule of rules){
    if(rule.keywords.some(k => h.includes(k))){
      return rule.type;
    }
  }

  // Fallback sur la catégorie fournie
  return category || "other";

}

/* =========================================
   DÉDUPLICATION — vérifier si titre existe
========================================= */

function titleExists(title){
  const row = db.prepare(
    "SELECT id FROM structures WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))"
  ).get(title);
  return !!row;
}

/* =========================================
   PAGINATION HELPER
========================================= */

function paginate(req){
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/* =========================================
   HOME
========================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "StuffOne Backend V2 Running",
    version: "2.0.0"
  });
});

/* =========================================
   GET ALL STRUCTURES (avec pagination)
   GET /structures?page=1&limit=20
========================================= */

app.get("/structures", (req, res) => {

  const { page, limit, offset } = paginate(req);

  const total = db.prepare("SELECT COUNT(*) as count FROM structures").get().count;

  const rows = db.prepare(`
    SELECT id, title, category, type, createdAt
    FROM structures
    ORDER BY createdAt DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    data:  rows,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  });

});

/* =========================================
   GET ONE STRUCTURE
========================================= */

app.get("/structures/:id", (req, res) => {

  const row = db.prepare(
    "SELECT id, title, category, type, createdAt FROM structures WHERE id = ?"
  ).get(req.params.id);

  if(!row){
    return res.status(404).json({ success: false, message: "Structure introuvable" });
  }

  res.json(row);

});

/* =========================================
   GET SOURCE CODE
========================================= */

app.get("/structures/:id/code", (req, res) => {

  const row = db.prepare(
    "SELECT html, css, js FROM structures WHERE id = ?"
  ).get(req.params.id);

  if(!row){
    return res.status(404).json({ success: false, message: "Code introuvable" });
  }

  res.json({
    success: true,
    html: decompress(row.html),
    css:  decompress(row.css),
    js:   decompress(row.js),
  });

});

/* =========================================
   UPLOAD STRUCTURE
========================================= */

app.post("/upload", authenticate, (req, res) => {

  try {

    const { title, category, html, css, js } = req.body;

    const cleanTitle = (title || "").trim();

    // ── Déduplication ──
    if(cleanTitle && titleExists(cleanTitle)){
      return res.status(409).json({
        success: false,
        message: `Structure "${cleanTitle}" existe déjà (doublon ignoré)`
      });
    }

    // ── Détection du type ──
    const type = detectType(html, category);

    // ── Compression ──
    const htmlBuf = compress(html);
    const cssBuf  = compress(css);
    const jsBuf   = compress(js);

    const stmt = db.prepare(`
      INSERT INTO structures (title, category, type, html, css, js)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(cleanTitle, category || "", type, htmlBuf, cssBuf, jsBuf);

    res.json({
      success: true,
      message: "Structure uploadée",
      data: {
        id:       info.lastInsertRowid,
        title:    cleanTitle,
        category: category || "",
        type,
      }
    });

  } catch(error) {

    res.status(500).json({ success: false, message: error.message });

  }

});

/* =========================================
   SEARCH
   GET /search?q=hero&page=1&limit=20
========================================= */

app.get("/search", (req, res) => {

  const query = (req.query.q || "").toLowerCase().trim();
  const { page, limit, offset } = paginate(req);

  if(!query){
    return res.json({ data: [], meta: { total: 0, page, limit, pages: 0 } });
  }

  const like = `%${query}%`;

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM structures
    WHERE LOWER(title) LIKE ?
       OR LOWER(category) LIKE ?
       OR LOWER(type) LIKE ?
  `).get(like, like, like).count;

  const rows = db.prepare(`
    SELECT id, title, category, type, createdAt
    FROM structures
    WHERE LOWER(title) LIKE ?
       OR LOWER(category) LIKE ?
       OR LOWER(type) LIKE ?
    ORDER BY createdAt DESC
    LIMIT ? OFFSET ?
  `).all(like, like, like, limit, offset);

  res.json({
    data: rows,
    meta: { total, page, limit, pages: Math.ceil(total / limit) }
  });

});

/* =========================================
   DELETE STRUCTURE
========================================= */

app.delete("/structures/:id", authenticate, (req, res) => {

  const row = db.prepare("SELECT id FROM structures WHERE id = ?").get(req.params.id);

  if(!row){
    return res.status(404).json({ success: false, message: "Structure introuvable" });
  }

  db.prepare("DELETE FROM structures WHERE id = ?").run(req.params.id);

  res.json({ success: true, message: "Structure supprimée" });

});

/* =========================================
   DELETE ALL (vider le serveur)
========================================= */

app.delete("/structures", authenticate, (req, res) => {

  const info = db.prepare("DELETE FROM structures").run();

  res.json({
    success: true,
    message: `${info.changes} structure(s) supprimée(s)`
  });

});

/* =========================================
   STATS
========================================= */

app.get("/stats", (req, res) => {

  const total = db.prepare("SELECT COUNT(*) as count FROM structures").get().count;

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM structures
    GROUP BY category
    ORDER BY count DESC
  `).all();

  const byType = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM structures
    GROUP BY type
    ORDER BY count DESC
  `).all();

  res.json({ total, byCategory, byType });

});

/* =========================================
   SERVER
========================================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`StuffOne V2 running on port ${PORT}`);
});
