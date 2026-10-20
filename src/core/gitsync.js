'use strict';

/**
 * Team sync through any git repository, using the git installed on this computer.
 *
 * Authentication uses whatever git already uses (SSH keys, Git Credential Manager, stored
 * credentials), or an access token sent as an HTTP header for this process only.
 * The token never appears in command-line arguments or in the repository's git config.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const format = require('./repo-format');

class GitError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

function friendly(stderr, args) {
  const s = String(stderr || '');
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401|Permission denied \(publickey\)|access denied|not authorized/i.test(s)) {
    return 'Git could not sign in to the repository. Check the access token, or that this computer\'s git credentials (SSH key or credential manager) can access it.';
  }
  if (/Repository not found|does not appear to be a git repository|not found/i.test(s) && args[0] !== 'rev-parse') return 'The repository was not found. Check the URL and that you have access to it.';
  if (/Could not resolve host|unable to access|Connection timed out|Failed to connect|Network is unreachable/i.test(s)) return `Could not reach the git server: ${s.split('\n').find((l) => /fatal|error/i.test(l)) || s.trim()}`;
  if (/Host key verification failed/i.test(s)) return 'SSH host key verification failed. Connect once with "ssh" from a terminal to trust the server, then try again.';
  return (s.split('\n').filter((l) => /fatal|error|rejected/i.test(l)).join(' ') || s.trim() || `git ${args[0]} failed`).replace(/\s+/g, ' ');
}

// A default commit message from "git status --porcelain": "Update List orders, Health; add Cancel order".
function describeChanges(porcelain) {
  const groups = { add: [], update: [], remove: [] };
  for (const line of porcelain.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const file = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
    const base = file.split('/').pop();
    if (!/\.request\.json$|^_collection\.json$|^_folder\.json$/.test(base) && !/environments\//.test(file)) continue;
    const name = /^_(collection|folder)\.json$/.test(base) ? file.split('/').slice(-2, -1)[0] : base.replace(/\.request\.json$|\.json$/, '');
    const verb = /D/.test(code) ? 'remove' : /A|\?/.test(code) ? 'add' : 'update';
    if (!groups[verb].includes(name)) groups[verb].push(name);
  }
  const list = (a) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} and ${a.length - 3} more` : a.join(', '));
  const parts = Object.entries(groups).filter(([, a]) => a.length).map(([verb, a]) => `${verb} ${list(a)}`);
  if (!parts.length) return 'Update shared HttpDash workspace';
  const text = parts.join('; ');
  return text[0].toUpperCase() + text.slice(1);
}

class TeamRepo {
  /**
   * opts: { dir (local clone), url, branch, subdir, token, username, userName, userEmail, timeoutMs }
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.url = opts.url;
    this.branch = opts.branch || 'main';
    this.subdir = (opts.subdir || '').replace(/^[/\\]+|[/\\]+$/g, '');
    this.token = opts.token || '';
    this.username = opts.username || 'oauth2';
    this.userName = opts.userName;
    this.userEmail = opts.userEmail;
    this.timeoutMs = opts.timeoutMs || 120000;
  }

  get root() { return this.subdir ? path.join(this.dir, this.subdir) : this.dir; }
  get rel() { return this.subdir || '.'; }

  env() {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      LC_ALL: 'C',
    };
    if (this.token) {
      // Passed through the environment so it never shows up in process listings or .git/config.
      const basic = Buffer.from(`${this.username}:${this.token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    if (this.userName) {
      env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = this.userName;
      env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = this.userEmail || `${this.userName.replace(/\s+/g, '.')}@users.noreply.httpdash`;
    }
    return env;
  }

  git(args, { cwd = this.dir, allowFail = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, env: this.env(), timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err && !allowFail) {
          if (err.code === 'ENOENT') return reject(new GitError('Git is not installed (or not on PATH). Install it from https://git-scm.com and restart HttpDash.'));
          if (err.killed) return reject(new GitError(`git ${args[0]} timed out`));
          return reject(new GitError(friendly(stderr, args), stderr));
        }
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  static async version() {
    const r = await new TeamRepo({ dir: os.tmpdir() }).git(['--version'], { cwd: os.tmpdir() });
    return r.stdout.trim();
  }

  async hasRemoteBranch() {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], { allowFail: true });
    return r.ok;
  }

  // Clones on first use; afterwards makes sure the clone points at the configured URL and branch.
  async ensureClone() {
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      fs.rmSync(this.dir, { recursive: true, force: true });
      await this.git(['clone', '--no-checkout', this.url, this.dir], { cwd: path.dirname(this.dir) });
      await this.git(['fetch', 'origin']);
      if (await this.hasRemoteBranch()) await this.git(['checkout', '-B', this.branch, `origin/${this.branch}`]);
      else await this.git(['checkout', '--orphan', this.branch]); // empty repository or new branch
    } else {
      await this.git(['remote', 'set-url', 'origin', this.url]);
      const head = (await this.git(['symbolic-ref', '--short', 'HEAD'], { allowFail: true })).stdout.trim();
      if (head !== this.branch) {
        await this.git(['fetch', 'origin']);
        if (await this.hasRemoteBranch()) await this.git(['checkout', '-B', this.branch, `origin/${this.branch}`]);
        else await this.git(['checkout', '--orphan', this.branch]);
      }
    }
    // A merge left unresolved by a crash or a closed window is cancelled rather than kept.
    if (fs.existsSync(path.join(this.dir, '.git', 'MERGE_HEAD'))) await this.git(['merge', '--abort'], { allowFail: true });
  }

  async hasCommits() {
    return (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).ok;
  }

  // Writes the local shared items into the clone and commits them. Returns true if anything changed.
  async commitLocal(state, message) {
    format.writeRepo(this.root, state);
    await this.git(['add', '-A', '--', this.rel]);
    const st = await this.git(['status', '--porcelain', '--', this.rel]);
    if (!st.stdout.trim()) return false;
    await this.git(['commit', '-m', message || describeChanges(st.stdout)]);
    return true;
  }

  // Fetches and merges the team's changes. Returns { conflicts: [paths] } or { merged: boolean }.
  async pullMerge() {
    await this.git(['fetch', 'origin']);
    if (!(await this.hasRemoteBranch())) return { merged: false, conflicts: [] };
    if (!(await this.hasCommits())) {
      await this.git(['checkout', '-B', this.branch, `origin/${this.branch}`]);
      return { merged: true, conflicts: [] };
    }
    const before = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const r = await this.git(['merge', '--no-edit', '-m', 'Merge team changes', `origin/${this.branch}`], { allowFail: true });
    if (!r.ok) {
      const conflicts = (await this.git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
      if (conflicts.length) return { merged: false, conflicts };
      if (/refusing to merge unrelated histories/i.test(r.stderr)) {
        const r2 = await this.git(['merge', '--no-edit', '--allow-unrelated-histories', '-m', 'Merge team changes', `origin/${this.branch}`], { allowFail: true });
        if (!r2.ok) {
          const c2 = (await this.git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
          if (c2.length) return { merged: false, conflicts: c2 };
          throw new GitError(friendly(r2.stderr, ['merge']));
        }
      } else throw new GitError(friendly(r.stderr, ['merge']));
    }
    const after = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    return { merged: before !== after, conflicts: [] };
  }

  // Resolves every conflicted file with one side: 'mine' (ours) or 'team' (theirs), then commits.
  async resolve(side) {
    const conflicts = (await this.git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const flag = side === 'mine' ? '--ours' : '--theirs';
    for (const file of conflicts) {
      const r = await this.git(['checkout', flag, '--', file], { allowFail: true });
      if (r.ok) await this.git(['add', '--', file]);
      else await this.git(['rm', '-q', '--', file]); // that side deleted the file
    }
    await this.git(['commit', '--no-edit']);
  }

  async abortMerge() {
    await this.git(['merge', '--abort'], { allowFail: true });
  }

  async push() {
    if (!(await this.hasCommits())) return false;
    const r = await this.git(['push', '-u', 'origin', `HEAD:refs/heads/${this.branch}`], { allowFail: true });
    if (r.ok) return true;
    if (/rejected|fetch first|non-fast-forward/i.test(r.stderr)) return null; // someone pushed meanwhile
    throw new GitError(friendly(r.stderr, ['push']), r.stderr);
  }

  async aheadBehind() {
    if (!(await this.hasCommits()) || !(await this.hasRemoteBranch())) return { ahead: (await this.hasCommits()) ? 1 : 0, behind: 0 };
    const r = await this.git(['rev-list', '--left-right', '--count', `HEAD...origin/${this.branch}`]);
    const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  // Fetches without merging and reports how many team commits are waiting. Cheap enough to poll.
  async check() {
    if (!fs.existsSync(path.join(this.dir, '.git'))) return { ahead: 0, behind: 0, files: [] };
    await this.git(['fetch', 'origin']);
    const status = await this.aheadBehind();
    let files = [];
    if (status.behind && (await this.hasCommits())) {
      const r = await this.git(['diff', '--name-only', `HEAD...origin/${this.branch}`, '--', this.rel], { allowFail: true });
      files = r.stdout.split('\n').filter(Boolean);
    }
    // Only changes inside the shared folder count.
    return { ...status, behind: files.length ? status.behind : 0, files: files.slice(0, 50) };
  }

  async log(limit = 20) {
    if (!(await this.hasCommits())) return [];
    const r = await this.git(['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--', this.rel]);
    return r.stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, author, date, subject] = line.split('\x1f');
      return { hash, author, date, subject };
    });
  }

  read() {
    return format.readRepo(this.root);
  }
}

/**
 * The whole sync: write + commit local changes, merge the team's, push (unless pullOnly).
 * Returns { conflicts } when the same files changed on both sides, otherwise the team state.
 * state null means "nothing of mine yet": used when joining, so the team's files aren't deleted.
 */
async function sync(repo, state, { message, pullOnly = false } = {}) {
  await repo.ensureClone();
  const committed = state ? await repo.commitLocal(state, message) : false;
  let merge = await repo.pullMerge();
  if (merge.conflicts.length) return { conflicts: merge.conflicts, committed };
  let pushed = false;
  if (!pullOnly) {
    let res = await repo.push();
    if (res === null) { // Lost a race with a teammate: merge again and retry once.
      merge = await repo.pullMerge();
      if (merge.conflicts.length) return { conflicts: merge.conflicts, committed };
      res = await repo.push();
      if (res === null) throw new GitError('The team repository keeps changing; try again in a moment.');
    }
    pushed = !!res;
  }
  const team = repo.read();
  return { conflicts: [], committed, merged: merge.merged, pushed, team, status: await repo.aheadBehind() };
}

async function finishConflicts(repo, side, { pullOnly = false } = {}) {
  await repo.resolve(side);
  let pushed = false;
  if (!pullOnly) pushed = !!(await repo.push());
  return { conflicts: [], pushed, team: repo.read(), status: await repo.aheadBehind() };
}

module.exports = { TeamRepo, sync, finishConflicts, GitError, describeChanges };
