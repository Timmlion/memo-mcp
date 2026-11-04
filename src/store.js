import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, APPROVE_PHRASE_ENV } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function fresh() {
  return { meta: {}, notes: [], uploads: [], clients: {}, codes: {}, tokens: {}, refresh: {} };
}

let state = fresh();

export function load() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  try {
    state = { ...fresh(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    state = fresh();
  }
  if (!state.meta.phrase) {
    state.meta.phrase = APPROVE_PHRASE_ENV || randomUUID().slice(0, 8);
    persist();
  }
  return state;
}

export function db() {
  return state;
}

export function persist() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

export function newId() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function addNote(text) {
  const note = { id: randomUUID(), text, createdAt: nowIso() };
  state.notes.push(note);
  persist();
  return note;
}

export function findNotes(query) {
  const q = String(query || '').toLowerCase();
  return state.notes
    .filter((n) => !q || n.text.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addUpload({ name, mime, bytes }) {
  const id = randomUUID();
  fs.writeFileSync(path.join(UPLOAD_DIR, id), bytes);
  const file = { id, name, mime, size: bytes.length, createdAt: nowIso() };
  state.uploads.push(file);
  persist();
  return file;
}

export function readUpload(id) {
  const file = state.uploads.find((u) => u.id === id);
  if (!file) return null;
  const p = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(p)) return null;
  return { ...file, bytes: fs.readFileSync(p) };
}
