#!/usr/bin/env node
/**
 * Exam Prepper — Ingest Script
 *
 * Parses source files (Markdown, PDF, TXT) into a SQLite database
 * and exports a material.json for LLM consumption.
 *
 * Usage:
 *   node ingest.js <file>                       Ingest a single file
 *   node ingest.js <file> --config <cfg.json>   Ingest with explicit config
 *   node ingest.js --all                        Ingest all files in ../data/sources/
 *   node ingest.js --export-material            Export material.json from current DB
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.resolve(__dirname, '../data');
const SOURCES_DIR = path.resolve(DATA_DIR, 'sources');
const DB_PATH     = path.resolve(DATA_DIR, 'notes.db');

// ── DB helpers (sql.js — in-memory, persisted to file) ───────────────────────

async function openDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  let db;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(`PRAGMA journal_mode = WAL;`);
  db.run(`
    CREATE TABLE IF NOT EXISTS sources (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      filename    TEXT NOT NULL,
      format      TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      config      TEXT
    );
    CREATE TABLE IF NOT EXISTS topics (
      id        TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      parent_id TEXT,
      name      TEXT NOT NULL,
      level     INTEGER NOT NULL DEFAULT 1,
      position  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id        TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      topic_id  TEXT,
      type      TEXT NOT NULL,
      content   TEXT,
      alt_text  TEXT,
      position  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_topics_source ON topics(source_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_topic  ON chunks(topic_id);
  `);
  return db;
}

function saveDb(db) {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(db, sql, params = []) {
  const rows = dbAll(db, sql, params);
  return rows[0] || null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

async function parseMarkdown(filePath, sourceId) {
  const { lexer } = require('marked');
  const src = fs.readFileSync(filePath, 'utf8');
  const tokens = lexer(src);

  const topics = [];
  const topicStack = [];
  let chunkPos = 0;
  let topicPos = 0;

  function currentTopicId() {
    return topicStack.length > 0 ? topicStack[topicStack.length - 1].id : null;
  }

  function pushChunk(type, content, altText = null) {
    const topicId = currentTopicId();
    const target = topics.find(t => t.id === topicId);
    if (target) {
      target.chunks.push({ type, content, alt_text: altText, position: chunkPos++ });
    }
  }

  for (const token of tokens) {
    if (token.type === 'heading') {
      const level = token.depth;
      const name = token.text;
      const id = `${sourceId}_t${topicPos++}_${slugify(name).slice(0, 40)}`;
      while (topicStack.length > 0 && topicStack[topicStack.length - 1].level >= level) {
        topicStack.pop();
      }
      const parentId = currentTopicId();
      topicStack.push({ id, level });
      topics.push({ id, name, level, parent_id: parentId, position: topicPos, chunks: [] });

    } else if (token.type === 'paragraph') {
      const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(token.raw || token.text)) !== null) {
        const [, alt, src] = imgMatch;
        let imageContent = null;
        const imgPath = path.resolve(path.dirname(filePath), src);
        if (fs.existsSync(imgPath)) {
          const ext = path.extname(imgPath).slice(1).toLowerCase();
          const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'image/png';
          imageContent = `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`;
        }
        pushChunk('image', imageContent || src, alt);
      }
      const text = (token.text || '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
      if (text) pushChunk('text', text);

    } else if (token.type === 'code') {
      pushChunk('code', token.text);

    } else if (token.type === 'list') {
      const items = token.items?.map(i => `• ${i.text}`).join('\n') || '';
      if (items) pushChunk('list', items);

    } else if (token.type === 'table') {
      const header = token.header?.map(h => h.text).join(' | ') || '';
      const rows = token.rows?.map(r => r.map(c => c.text).join(' | ')).join('\n') || '';
      pushChunk('table', `${header}\n${'-'.repeat(Math.max(0, header.length))}\n${rows}`);

    } else if (token.type === 'blockquote') {
      if (token.text) pushChunk('text', token.text);
    }
  }

  return topics;
}

async function parsePDF(filePath, sourceId) {
  const pdfParse = require('pdf-parse');
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);

  const topics = [];
  let topicPos = 0;
  let chunkPos = 0;

  const pages = data.text.split('\f').filter(p => p.trim());

  pages.forEach((pageText, pageIndex) => {
    const lines = pageText.split('\n');
    let currentTopic = topics[topics.length - 1];
    let textBuffer = [];

    function flush() {
      const text = textBuffer.join(' ').trim();
      if (text && currentTopic) {
        currentTopic.chunks.push({ type: 'text', content: text, alt_text: null, position: chunkPos++ });
      }
      textBuffer = [];
    }

    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) { flush(); return; }

      const isHeading = (trimmed.length < 80 && trimmed === trimmed.toUpperCase() && trimmed.length > 3)
                     || (trimmed.length < 60 && /^[A-Z]/.test(trimmed) && !trimmed.endsWith('.') && textBuffer.length === 0);

      if (isHeading && textBuffer.length === 0) {
        const id = `${sourceId}_t${topicPos++}_p${pageIndex + 1}_${slugify(trimmed).slice(0, 40)}`;
        currentTopic = { id, name: trimmed, level: 1, parent_id: null, position: topicPos, chunks: [] };
        topics.push(currentTopic);
      } else {
        textBuffer.push(trimmed);
      }
    });

    flush();
  });

  // Wrap everything if no headings were detected
  if (topics.length === 0) {
    const id = `${sourceId}_t0_main`;
    topics.push({ id, name: path.basename(filePath, '.pdf'), level: 1, parent_id: null, position: 0, chunks: [] });
    const fullText = data.text.replace(/\s+/g, ' ').trim();
    if (fullText) topics[0].chunks.push({ type: 'text', content: fullText, alt_text: null, position: 0 });
  }

  return topics;
}

async function parseTxt(filePath, sourceId) {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const topics = [];
  let currentTopic = null;
  let topicPos = 0;
  let chunkPos = 0;
  let textBuffer = [];

  function flush() {
    const text = textBuffer.join(' ').trim();
    if (text && currentTopic) currentTopic.chunks.push({ type: 'text', content: text, alt_text: null, position: chunkPos++ });
    textBuffer = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }

    if (/^#{1,6}\s/.test(line)) {
      flush();
      const level = (line.match(/^(#+)/) || ['', '#'])[1].length;
      const name = line.replace(/^#+\s+/, '');
      const id = `${sourceId}_t${topicPos++}_${slugify(name).slice(0, 40)}`;
      currentTopic = { id, name, level, parent_id: null, position: topicPos, chunks: [] };
      topics.push(currentTopic);
    } else {
      textBuffer.push(trimmed);
    }
  }
  flush();

  // Fallback: no headings found, wrap all text
  if (topics.length === 0) {
    const id = `${sourceId}_t0_main`;
    const name = path.basename(filePath, path.extname(filePath));
    topics.push({ id, name, level: 1, parent_id: null, position: 0, chunks: [] });
    const fullText = src.replace(/\s+/g, ' ').trim();
    if (fullText) topics[0].chunks.push({ type: 'text', content: fullText, alt_text: null, position: 0 });
  }

  return topics;
}

// ── Write to DB ───────────────────────────────────────────────────────────────

function writeToDb(db, sourceId, filename, format, title, config, topics) {
  const now = new Date().toISOString();

  // Remove existing data for this source
  db.run('DELETE FROM chunks WHERE source_id = ?', [sourceId]);
  db.run('DELETE FROM topics WHERE source_id = ?', [sourceId]);
  db.run('DELETE FROM sources WHERE id = ?', [sourceId]);

  db.run(
    'INSERT INTO sources (id, title, filename, format, imported_at, config) VALUES (?, ?, ?, ?, ?, ?)',
    [sourceId, title, filename, format, now, config ? JSON.stringify(config) : null]
  );

  topics.forEach(t => {
    db.run(
      'INSERT INTO topics (id, source_id, parent_id, name, level, position) VALUES (?, ?, ?, ?, ?, ?)',
      [t.id, sourceId, t.parent_id || null, t.name, t.level, t.position]
    );
    t.chunks.forEach((c, ci) => {
      const chunkId = `${t.id}_c${ci}`;
      db.run(
        'INSERT INTO chunks (id, source_id, topic_id, type, content, alt_text, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [chunkId, sourceId, t.id, c.type, c.content || null, c.alt_text || null, c.position ?? ci]
      );
    });
  });

  const totalChunks = topics.reduce((s, t) => s + t.chunks.length, 0);
  console.log(`  ✓ Stored ${topics.length} topics, ${totalChunks} chunks`);
}

// ── Export material.json ──────────────────────────────────────────────────────

function exportMaterial(db, outputPath) {
  const sources = dbAll(db, 'SELECT id, title, filename, format, imported_at, config FROM sources ORDER BY imported_at DESC');
  const out = sources.map(s => {
    const topics = dbAll(db, 'SELECT id, name, level, parent_id, position FROM topics WHERE source_id = ? ORDER BY position', [s.id]);
    return {
      id: s.id,
      title: s.title || s.filename,
      filename: s.filename,
      format: s.format,
      config: s.config ? JSON.parse(s.config) : null,
      topics: topics.map(t => {
        const chunks = dbAll(db, 'SELECT id, type, content, alt_text, position FROM chunks WHERE topic_id = ? ORDER BY position', [t.id]);
        return {
          id: t.id, name: t.name, level: t.level, parent_id: t.parent_id || null,
          chunks: chunks.map(c => ({ id: c.id, type: c.type, content: c.content, alt_text: c.alt_text || null, position: c.position }))
        };
      })
    };
  });

  const material = { export_version: '1.0', exported_at: new Date().toISOString(), sources: out };
  fs.writeFileSync(outputPath, JSON.stringify(material, null, 2));
  const totalTopics = out.reduce((s, src) => s + src.topics.length, 0);
  console.log(`✓ Exported material.json → ${outputPath}`);
  console.log(`  ${out.length} sources, ${totalTopics} topics`);
}

// ── Ingest a single file ──────────────────────────────────────────────────────

async function ingestFile(filePath, configPath) {
  const ext      = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath);
  const sourceId = `src_${slugify(path.basename(filePath, ext)).slice(0, 32)}_${Date.now()}`;

  let config = null;
  const autoConfigPath = filePath.replace(/\.[^.]+$/, '.config.json');
  if (configPath && fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (fs.existsSync(autoConfigPath)) {
    config = JSON.parse(fs.readFileSync(autoConfigPath, 'utf8'));
    console.log(`  Config: ${path.basename(autoConfigPath)}`);
  }

  const formatMap = { '.md': 'markdown', '.markdown': 'markdown', '.pdf': 'pdf', '.txt': 'text' };
  const format = formatMap[ext];
  if (!format) { console.error(`Unsupported format: ${ext}`); process.exit(1); }

  const title = config?.title || path.basename(filePath, ext);
  console.log(`Ingesting: ${filename} (${format})`);

  let topics;
  if (ext === '.md' || ext === '.markdown') topics = await parseMarkdown(filePath, sourceId);
  else if (ext === '.pdf')                  topics = await parsePDF(filePath, sourceId);
  else                                      topics = await parseTxt(filePath, sourceId);

  console.log(`  Parsed: ${topics.length} topics`);
  const db = await openDb();
  writeToDb(db, sourceId, filename, format, title, config, topics);
  saveDb(db);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s) {
  return (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--export-material')) {
    const db = await openDb();
    exportMaterial(db, path.resolve(DATA_DIR, 'material.json'));
    return;
  }

  const target = args.find(a => !a.startsWith('--'));

  // Folder path — ingest everything inside it
  if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const dir = path.resolve(target);
    const files = fs.readdirSync(dir).filter(f => /\.(md|markdown|pdf|txt)$/i.test(f));
    if (!files.length) { console.log('No supported files found in', dir); return; }
    console.log(`Found ${files.length} file(s) in ${dir}`);
    for (const file of files) await ingestFile(path.join(dir, file));
    const db = await openDb();
    exportMaterial(db, path.resolve(DATA_DIR, 'material.json'));
    return;
  }

  if (args.includes('--all')) {
    if (!fs.existsSync(SOURCES_DIR)) { console.error('Sources directory not found:', SOURCES_DIR); process.exit(1); }
    const files = fs.readdirSync(SOURCES_DIR).filter(f => /\.(md|markdown|pdf|txt)$/i.test(f));
    if (!files.length) { console.log('No source files found in', SOURCES_DIR); return; }
    for (const file of files) await ingestFile(path.join(SOURCES_DIR, file));
    const db = await openDb();
    exportMaterial(db, path.resolve(DATA_DIR, 'material.json'));
    return;
  }

  const filePath = target;
  if (!filePath) {
    console.log(`
Exam Prepper — Ingest Script

Usage:
  node ingest.js <folder>                      Ingest all files in a folder
  node ingest.js <file>                        Ingest a single file
  node ingest.js <file> --config <cfg.json>    Ingest with explicit config
  node ingest.js --all                         Ingest all files in data/sources/
  node ingest.js --export-material             Re-export material.json from DB

Supported formats: .md  .pdf  .txt
    `);
    return;
  }

  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : null;
  await ingestFile(path.resolve(filePath), configPath ? path.resolve(configPath) : null);

  // Auto-export material.json after each ingest
  const db = await openDb();
  exportMaterial(db, path.resolve(DATA_DIR, 'material.json'));
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
