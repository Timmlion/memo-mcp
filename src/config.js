export const PORT = Number(process.env.PORT || 8787);
export const BASE_URL = new URL(process.env.BASE_URL || `http://localhost:${PORT}`);
export const RESOURCE_URL = new URL('/mcp', BASE_URL);
export const PLAN_URL = new URL('/plan', BASE_URL);
export const DATA_DIR = process.env.DATA_DIR || './data';
export const APPROVE_PHRASE_ENV = process.env.APPROVE_PHRASE || '';
export const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'google/gemini-2.5-flash';
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
