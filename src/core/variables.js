'use strict';

const crypto = require('crypto');

const FIRST_NAMES = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim'];
const LAST_NAMES = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Lee'];
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'test.dev'];
const COLORS = ['red', 'green', 'blue', 'orange', 'purple', 'teal', 'black', 'white'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Postman-compatible dynamic variables ({{$guid}}, {{$timestamp}}, ...).
const DYNAMIC = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randInt(0, 1000)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomFirstName: () => pick(FIRST_NAMES),
  $randomLastName: () => pick(LAST_NAMES),
  $randomFullName: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  $randomUserName: () => `${pick(FIRST_NAMES).toLowerCase()}${randInt(1, 999)}`,
  $randomEmail: () => `${pick(FIRST_NAMES).toLowerCase()}.${pick(LAST_NAMES).toLowerCase()}@${pick(DOMAINS)}`,
  $randomWord: () => pick(WORDS),
  $randomWords: () => [pick(WORDS), pick(WORDS), pick(WORDS)].join(' '),
  $randomColor: () => pick(COLORS),
  $randomHexColor: () => '#' + crypto.randomBytes(3).toString('hex'),
  $randomIP: () => [randInt(1, 254), randInt(0, 255), randInt(0, 255), randInt(1, 254)].join('.'),
  $randomPhoneNumber: () => `${randInt(200, 999)}-${randInt(200, 999)}-${randInt(1000, 9999)}`,
  $randomAlphaNumeric: () => pick('abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
  $randomUrl: () => `https://${pick(WORDS)}.${pick(DOMAINS)}`,
  $randomDomainName: () => pick(DOMAINS),
  $randomCity: () => pick(['Lisbon', 'Osaka', 'Nairobi', 'Lima', 'Oslo', 'Austin']),
  $randomCountry: () => pick(['Portugal', 'Japan', 'Kenya', 'Peru', 'Norway', 'USA']),
  $randomLoremSentence: () => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
};

// Turns a [{key, value, enabled}] list into a plain object, skipping disabled rows.
function listToObject(list) {
  const out = {};
  for (const v of list || []) {
    if (v && v.key && v.enabled !== false) out[v.key] = v.value == null ? '' : String(v.value);
  }
  return out;
}

function objectToList(obj, previous) {
  const prev = new Map((previous || []).map((v) => [v.key, v]));
  return Object.entries(obj).map(([key, value]) => ({
    ...(prev.get(key) || {}),
    key,
    value: value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value),
    enabled: true,
  }));
}

// Scopes are ordered from lowest to highest precedence:
// globals < collection < environment < data < local.
function mergeScopes(scopes) {
  return Object.assign({}, scopes.globals, scopes.collection, scopes.environment, scopes.data, scopes.local);
}

function resolve(input, vars, depth = 0) {
  if (typeof input !== 'string' || input.indexOf('{{') === -1) return input;
  const out = input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    if (DYNAMIC[name]) return DYNAMIC[name]();
    return match;
  });
  // Variables may reference other variables; resolve a few levels deep.
  if (out !== input && depth < 5 && /\{\{[^{}]+\}\}/.test(out)) return resolve(out, vars, depth + 1);
  return out;
}

// Returns the variable names referenced in a string that could not be resolved.
function unresolved(input, vars) {
  const missing = [];
  if (typeof input !== 'string') return missing;
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(input))) {
    if (!(m[1] in vars) && !DYNAMIC[m[1]]) missing.push(m[1]);
  }
  return missing;
}

module.exports = { resolve, unresolved, mergeScopes, listToObject, objectToList, DYNAMIC };
