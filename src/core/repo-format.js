'use strict';

/**
 * Team repository format: shared collections and environments as readable, merge-friendly files.
 *
 *   httpdash.json                                  marker { format: 'httpdash-repo', version }
 *   collections/<collection>/_collection.json      collection settings (auth, scripts, variables, dependency)
 *   collections/<collection>/<folder>/_folder.json folder settings
 *   collections/<collection>/…/<request>.request.json  one file per request (with its examples)
 *   environments/<environment>.json
 *
 * Every item file carries a "seq" number for ordering, so adding a request never edits a shared file.
 * Secret values are written empty; local values survive when the team version is applied.
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 'httpdash-repo';
const VERSION = 1;

const slug = (s) => String(s || 'untitled').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Variable names that hold auth-dependency tokens are never shared.
function tokenVarsOf(collections) {
  const names = new Set();
  const visit = (n) => {
    const dep = n.type === 'request' ? n.request && n.request.dependency : n.dependency;
    if (dep && dep.mode === 'enabled') {
      names.add(dep.tokenVar || 'token');
      if (dep.expiryVar) names.add(dep.expiryVar);
    }
    (n.items || []).forEach(visit);
  };
  collections.forEach(visit);
  return names;
}

const shareVars = (list, tokenVars) => (list || []).map((v) => {
  const out = { key: v.key, value: v.value, enabled: v.enabled !== false };
  if (v.secret) out.secret = true;
  if (v.description) out.description = v.description;
  if (v.secret || tokenVars.has(v.key)) {
    out.value = '';
    if (!v.secret) out.localOnly = true;
  }
  return out;
});

function uniqueName(used, base) {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return name;
}

// OAuth 2.0 tokens obtained by signing in belong to the person who signed in, so they are never
// shared; each person keeps their own (see keepLocalTokens). References like {{token}} are kept.
const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'tokenExpiresAt'];
const isVarRef = (v) => /^\s*\{\{[^{}]+\}\}\s*$/.test(String(v || ''));
function shareAuth(auth) {
  if (!auth || auth.type !== 'oauth2' || !auth.oauth2) return auth;
  const o = { ...auth.oauth2 };
  for (const f of TOKEN_FIELDS) if (o[f] && !isVarRef(o[f])) o[f] = '';
  return { ...auth, oauth2: o };
}
const shareItems = (items) => (items || []).map((it) => (it.type === 'folder'
  ? { ...it, auth: shareAuth(it.auth), items: shareItems(it.items) }
  : { ...it, request: it.request && { ...it.request, auth: shareAuth(it.request.auth) } }));

// Puts this person's own OAuth 2.0 tokens back into the team's copy of a collection.
function keepLocalTokens(teamCol, localCol) {
  if (!localCol) return teamCol;
  const mine = new Map();
  const collect = (id, auth) => { if (auth && auth.type === 'oauth2' && auth.oauth2) mine.set(id, auth.oauth2); };
  const walkLocal = (items) => (items || []).forEach((it) => { if (it.type === 'folder') { collect(it.id, it.auth); walkLocal(it.items); } else collect(it.id, it.request && it.request.auth); });
  collect(localCol.id, localCol.auth);
  walkLocal(localCol.items);
  const restore = (id, auth) => {
    const own = mine.get(id);
    if (!own || !auth || auth.type !== 'oauth2' || !auth.oauth2) return auth;
    const o = { ...auth.oauth2 };
    for (const f of TOKEN_FIELDS) if (!o[f] && own[f]) o[f] = own[f];
    return { ...auth, oauth2: o };
  };
  const walkTeam = (items) => (items || []).map((it) => (it.type === 'folder'
    ? { ...it, auth: restore(it.id, it.auth), items: walkTeam(it.items) }
    : { ...it, request: it.request && { ...it.request, auth: restore(it.id, it.request.auth) } }));
  return { ...teamCol, auth: restore(teamCol.id, teamCol.auth), items: walkTeam(teamCol.items) };
}

// The collections and environments exactly as they will be written: secrets and tokens blanked.
function shareable({ collections = [], environments = [] }) {
  const tokenVars = tokenVarsOf(collections);
  return {
    collections: collections.map((c) => ({ ...c, auth: shareAuth(c.auth), items: shareItems(c.items), variables: shareVars(c.variables, tokenVars) })),
    environments: environments.map((e) => ({ ...e, values: shareVars(e.values, tokenVars) })),
  };
}

// What each file holds. Shared by writeRepo and by change detection, so both see the same fields.
const collectionMeta = (col, tokenVars) => ({
  id: col.id, name: col.name, description: col.description || '', auth: shareAuth(col.auth), preRequestScript: col.preRequestScript || '', testScript: col.testScript || '',
  variables: shareVars(col.variables, tokenVars),
  ...(col.dependency ? { dependency: col.dependency } : {}),
  ...(col.mock ? { mock: col.mock } : {}),
});
const folderMeta = (it, seq) => ({
  id: it.id, seq, name: it.name, description: it.description || '', auth: shareAuth(it.auth), preRequestScript: it.preRequestScript || '', testScript: it.testScript || '',
  ...(it.dependency ? { dependency: it.dependency } : {}),
});
const requestFile = (it, seq) => ({ id: it.id, seq, name: it.name, request: it.request && { ...it.request, auth: shareAuth(it.request.auth) }, ...(it.examples && it.examples.length ? { examples: it.examples } : {}) });
const environmentFile = (env, tokenVars) => ({ id: env.id, name: env.name, values: shareVars(env.values, tokenVars) });

/**
 * Writes the shared collections and environments into root, replacing what was there before
 * (so local renames and deletions become file renames and deletions in git).
 */
function writeRepo(root, { collections = [], environments = [] }) {
  const tokenVars = tokenVarsOf(collections);
  for (const sub of ['collections', 'environments']) fs.rmSync(path.join(root, sub), { recursive: true, force: true });
  if (!fs.existsSync(path.join(root, 'httpdash.json'))) writeJson(path.join(root, 'httpdash.json'), { format: FORMAT, version: VERSION });
  if (!fs.existsSync(path.join(root, 'README.md'))) {
    fs.writeFileSync(path.join(root, 'README.md'), '# Shared HttpDash workspace\n\nThis repository is managed by HttpDash team sync. Open HttpDash → Team → Connect a repository, and use this repository\'s URL.\n\nSecret values are never stored here; each person keeps their own.\n');
  }

  const writeItems = (dir, items) => {
    const used = new Set(['_collection', '_folder']);
    items.forEach((it, seq) => {
      const name = uniqueName(used, slug(it.name));
      if (it.type === 'folder') {
        writeJson(path.join(dir, name, '_folder.json'), folderMeta(it, seq));
        writeItems(path.join(dir, name), it.items || []);
      } else writeJson(path.join(dir, `${name}.request.json`), requestFile(it, seq));
    });
  };

  const usedCols = new Set();
  for (const col of collections) {
    const dir = path.join(root, 'collections', uniqueName(usedCols, slug(col.name)));
    writeJson(path.join(dir, '_collection.json'), collectionMeta(col, tokenVars));
    writeItems(dir, col.items || []);
  }
  const usedEnvs = new Set();
  for (const env of environments) writeJson(path.join(root, 'environments', `${uniqueName(usedEnvs, slug(env.name))}.json`), environmentFile(env, tokenVars));
}

// Reads the shared collections and environments from root. Unreadable files are reported, not fatal.
function readRepo(root) {
  const problems = [];
  const safeRead = (file) => {
    try { return readJson(file); } catch (e) { problems.push(`${path.relative(root, file)}: ${e.message}`); return null; }
  };
  const readItems = (dir) => {
    const items = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const meta = fs.existsSync(path.join(full, '_folder.json')) ? safeRead(path.join(full, '_folder.json')) : null;
        if (!meta) continue;
        const { seq, ...rest } = meta;
        items.push({ seq, item: { type: 'folder', ...rest, items: readItems(full) } });
      } else if (entry.name.endsWith('.request.json')) {
        const r = safeRead(full);
        if (!r) continue;
        const { seq, ...rest } = r;
        items.push({ seq, item: { type: 'request', ...rest } });
      }
    }
    return items.sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || String(a.item.name).localeCompare(b.item.name)).map((x) => x.item);
  };

  const collections = [];
  const colRoot = path.join(root, 'collections');
  if (fs.existsSync(colRoot)) {
    for (const entry of fs.readdirSync(colRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = safeRead(path.join(colRoot, entry.name, '_collection.json'));
      if (!meta) continue;
      collections.push({ type: 'collection', variables: [], ...meta, items: readItems(path.join(colRoot, entry.name)) });
    }
  }
  const environments = [];
  const envRoot = path.join(root, 'environments');
  if (fs.existsSync(envRoot)) {
    for (const f of fs.readdirSync(envRoot)) {
      if (!f.endsWith('.json')) continue;
      const env = safeRead(path.join(envRoot, f));
      if (env) environments.push({ values: [], ...env });
    }
  }
  collections.sort((a, b) => a.name.localeCompare(b.name));
  environments.sort((a, b) => a.name.localeCompare(b.name));
  return { collections, environments, problems };
}

// Keeps this person's own values for secret and local-only variables that the team copy leaves empty.
function keepLocalValues(teamList, localList) {
  const local = new Map((localList || []).map((v) => [v.key, v]));
  return (teamList || []).map((v) => {
    const mine = local.get(v.key);
    const out = { ...v };
    if ((v.secret || v.localOnly) && !v.value && mine && mine.value) out.value = mine.value;
    if (mine && mine.discovered) out.discovered = mine.discovered; // service-discovery link is local
    delete out.localOnly;
    return out;
  });
}

/**
 * Applies the repository's contents to the local workspace for one team repo.
 * Items linked to the repo (team === repoId) are replaced by the team version, added if new,
 * and removed if the team deleted them. Everything else is left alone.
 * keepMissing keeps linked items the repository doesn't have yet (when first joining it).
 * Returns { collections, environments, summary }.
 */
function applyRepo(local, repoState, repoId, { keepMissing = false } = {}) {
  const summary = { added: [], updated: [], removed: [] };
  const tokenVars = tokenVarsOf([...(local.collections || []), ...repoState.collections]);
  const itemsForm = (items) => (items || []).map((it, seq) => (it.type === 'folder' ? { ...folderMeta(it, seq), items: itemsForm(it.items) } : requestFile(it, seq)));
  const sharedForm = {
    collection: (c) => ({ ...collectionMeta(c, tokenVars), items: itemsForm(c.items) }),
    environment: (e) => environmentFile(e, tokenVars),
  };
  const merge = (localList, teamList, kind, convert) => {
    const out = [];
    const teamById = new Map(teamList.map((t) => [t.id, t]));
    for (const item of localList) {
      if (teamById.has(item.id)) {
        const next = { ...convert(teamById.get(item.id), item), team: repoId };
        if (canonical(sharedForm[kind](next)) !== canonical(sharedForm[kind](item))) summary.updated.push(`${kind} "${next.name}"`);
        out.push(next);
        teamById.delete(item.id);
      } else if (item.team === repoId && !keepMissing) {
        summary.removed.push(`${kind} "${item.name}"`);
      } else out.push(item);
    }
    for (const t of teamById.values()) {
      out.push({ ...convert(t, null), team: repoId });
      summary.added.push(`${kind} "${t.name}"`);
    }
    return out;
  };
  const collections = merge(local.collections || [], repoState.collections, 'collection', (t, mine) => ({
    ...keepLocalTokens(t, mine), variables: keepLocalValues(t.variables, mine && mine.variables),
  }));
  const environments = merge(local.environments || [], repoState.environments, 'environment', (t, mine) => ({
    ...t, values: keepLocalValues(t.values, mine && mine.values),
    ...(mine && mine.discoverySourceId ? { discoverySourceId: mine.discoverySourceId } : {}),
  }));
  return { collections, environments, summary };
}

// JSON with sorted keys, so key order alone never counts as a change.
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

module.exports = { shareable, writeRepo, readRepo, applyRepo, keepLocalValues, keepLocalTokens, slug, FORMAT };
