// src/util/gen.js — random credential and workspace-name generators.
//
// Split provenance (per contract): username/password follow the REPO's
// GitHub-account rule from gen-accounts.mjs (NOT gen.py — the DB identity
// scheme), while the workspace name is ported from gen.py (it names the
// CapCut workspace, unrelated to login credentials).
import crypto from 'node:crypto';
import { choice, randInt } from './util.js';

// Adjectives for workspace names — word list ported verbatim from gen.py.
const ADJ = ['fast', 'blue', 'calm', 'bold', 'cool', 'dark', 'keen', 'warm',
  'neat', 'pure', 'wise', 'brave', 'sharp', 'bright', 'swift', 'quiet',
  'clever', 'mighty', 'silent', 'sunny', 'lucky', 'noble', 'rapid', 'vivid'];

// Nouns for workspace names — verbatim from gen.py (the duplicate 'harbor'
// is kept on purpose: faithful port, same probability weights as the tool
// that has been running in production).
const NOUN = ['fox', 'wolf', 'hawk', 'pine', 'river', 'stone', 'cloud', 'ember',
  'comet', 'falcon', 'otter', 'raven', 'tiger', 'maple', 'cedar', 'delta',
  'nova', 'quartz', 'willow', 'harbor', 'summit', 'harbor', 'meadow', 'ridge'];

/**
 * Random login username: 'u' + 10 hex chars (crypto random). Repo
 * GitHub-account convention (gen-accounts.mjs --random): 'u' marks the
 * unpredictable-identity scheme and 10 hex chars give a ~10^12 space, so
 * collisions are effectively impossible while staying valid for GitHub
 * and CapCut alike. The email is always username@EMAIL_DOMAIN.
 */
export function randomUsername() {
  return 'u' + crypto.randomBytes(5).toString('hex');
}

/**
 * Random login password: 'Vt-' + 12 hex + '-9x!K' (crypto random). Exact repo
 * convention (gen-accounts.mjs): fixed affixes + hex body always satisfy
 * GitHub/CapCut strength rules (upper, lower, digit, special, >= 15 chars).
 */
export function randomPassword() {
  return 'Vt-' + crypto.randomBytes(6).toString('hex') + '-9x!K';
}

/**
 * Random CapCut workspace name, e.g. 'Bright Meadow Studio 4821' — ported
 * from gen.py random_workspace_name (same word lists, same ranges 100-9999).
 * The input field has maxlength="50", so the name is always cut to <= 50
 * chars. Meaningful words + a number instead of a random string make it look
 * like a real human-chosen name; CapCut's default is 'user448579073269's
 * space' and keeping that would make every account look identical.
 */
export function randomWorkspaceName() {
  const kinds = ['Studio', 'Workspace', 'Space', 'Lab', 'Team', 'Media',
    'Films', 'Creative', 'Works', 'Project'];
  const cap = (w) => w[0].toUpperCase() + w.slice(1); // Python str.capitalize() on an already-lowercase word
  const name = `${cap(choice(ADJ))} ${cap(choice(NOUN))} ${choice(kinds)} ${randInt(100, 9999)}`;
  return name.slice(0, 50);
}
