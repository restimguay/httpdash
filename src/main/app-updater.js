'use strict';

/**
 * Keeps HttpDash up to date from GitHub releases.
 *
 * mode 'auto':   download new versions in the background and install them when the app quits
 *                (or right away with "Restart to update").
 * mode 'notify': show an Update button; nothing is downloaded until the person asks.
 * mode 'off':    only check when asked.
 *
 * Self-install works for the Windows installer build and for macOS when the app sits in a
 * writable folder (e.g. /Applications). Elsewhere (portable exe, Linux, a read-only location)
 * the Update button opens the release page instead.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { app, net, shell } = require('electron');
const { JsonStore } = require('./store');
const { compareVersions, latestRelease, downloadAsset } = require('../core/updates');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

class AppUpdater {
  constructor({ dataDir, repo, onChange, log }) {
    this.repo = repo;
    this.onChange = onChange || (() => {});
    this.log = log || (() => {});
    this.dir = path.join(dataDir, 'updates');
    this.store = new JsonStore(path.join(dataDir, 'updates.json'), () => ({ mode: 'notify', includePrereleases: false, skipVersion: null, lastCheck: null }));
    this.config = this.store.load();
    this.state = { status: 'idle', current: app.getVersion(), release: null, progress: null, error: null, file: null, canInstall: this.canSelfInstall() };
    this.timer = null;
  }

  get portable() { return !!process.env.PORTABLE_EXECUTABLE_FILE; }

  // The .app bundle on macOS, if the app may replace it.
  macBundle() {
    const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
    if (!bundle.endsWith('.app') || /AppTranslocation/.test(bundle)) return null;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return bundle; } catch { return null; }
  }

  canSelfInstall() {
    if (!app.isPackaged) return false;
    if (process.platform === 'win32') return !this.portable;
    if (process.platform === 'darwin') return !!this.macBundle();
    return false;
  }

  publicState() {
    return { ...this.state, mode: this.config.mode, includePrereleases: !!this.config.includePrereleases, lastCheck: this.config.lastCheck, file: undefined };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.publicState());
  }

  setConfig(patch) {
    this.config = { ...this.config, ...patch };
    if (!['auto', 'notify', 'off'].includes(this.config.mode)) this.config.mode = 'notify';
    this.store.save(this.config);
    this.onChange(this.publicState());
    if (patch.mode === 'auto' && this.state.status === 'available') this.download().catch(() => {});
    return this.publicState();
  }

  start() {
    if (this.config.mode === 'off') return;
    setTimeout(() => this.check().catch(() => {}), 15000);
    this.timer = setInterval(() => { if (this.config.mode !== 'off') this.check().catch(() => {}); }, CHECK_EVERY_MS);
  }

  async fetchJson(url) {
    const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `HttpDash/${app.getVersion()}` } });
    if (res.status === 404) return null; // no releases yet
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    return res.json();
  }

  // manual: the person clicked "Check for updates", so a skipped version is offered again.
  async check({ manual = false } = {}) {
    if (['checking', 'downloading'].includes(this.state.status)) return this.publicState();
    this.set({ status: 'checking', error: null });
    try {
      const release = await latestRelease({
        repo: this.repo, fetchJson: (u) => this.fetchJson(u), platform: process.platform, arch: process.arch,
        portable: this.portable, includePrereleases: this.config.includePrereleases,
      });
      this.config.lastCheck = Date.now();
      this.store.save(this.config);
      const newer = release && compareVersions(release.version, this.state.current) > 0;
      if (!newer || (!manual && this.config.skipVersion === release.version)) {
        this.set({ status: 'current', release: newer ? release : null });
        return this.publicState();
      }
      const ready = this.state.status === 'ready' && this.state.release && this.state.release.version === release.version;
      this.set({ status: ready ? 'ready' : 'available', release, canInstall: this.canSelfInstall() && !!release.asset });
      this.log('update.available', { version: release.version });
      if (this.config.mode === 'auto' && this.state.canInstall && !ready) this.download().catch(() => {});
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.publicState();
  }

  async download() {
    const { release } = this.state;
    if (!release || !release.asset || this.state.status === 'downloading') return this.publicState();
    this.set({ status: 'downloading', progress: { received: 0, total: release.asset.size || 0 }, error: null });
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      let last = 0;
      const { file } = await downloadAsset(release.asset, this.dir, {
        fetchStream: (u) => net.fetch(u, { headers: { 'User-Agent': `HttpDash/${app.getVersion()}` } }),
        onProgress: (p) => { if (Date.now() - last > 250) { last = Date.now(); this.set({ progress: p }); } },
      });
      const prepared = process.platform === 'darwin' ? await this.unpackMac(file) : file;
      this.set({ status: 'ready', file: prepared, progress: null });
      this.log('update.downloaded', { version: release.version });
    } catch (e) {
      this.set({ status: 'error', error: e.message, progress: null });
      throw e;
    }
    return this.publicState();
  }

  unpackMac(zip) {
    const out = path.join(this.dir, 'unpacked');
    return new Promise((resolve, reject) => {
      execFile('ditto', ['-x', '-k', zip, out], (err) => {
        if (err) return reject(new Error(`Could not unpack the update: ${err.message}`));
        const appDir = fs.readdirSync(out).find((f) => f.endsWith('.app'));
        if (!appDir) return reject(new Error('The update did not contain an app.'));
        resolve(path.join(out, appDir));
      });
    });
  }

  skip(version) {
    this.config.skipVersion = version;
    this.store.save(this.config);
    this.set({ status: 'current' });
    return this.publicState();
  }

  openReleasePage() {
    const url = (this.state.release && this.state.release.url) || `https://github.com/${this.repo}/releases/latest`;
    shell.openExternal(url);
  }

  // Starts the installer (or bundle swap) once this process exits. relaunch: start the new version after.
  install({ relaunch = true } = {}) {
    if (this.state.status !== 'ready' || !this.state.file || !fs.existsSync(this.state.file)) return false;
    this.log('update.install', { version: this.state.release.version });
    if (process.platform === 'win32') {
      // NSIS: /S installs silently over the current installation; --force-run starts it afterwards.
      spawn(this.state.file, ['/S', ...(relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      const bundle = this.macBundle();
      if (!bundle) return false;
      const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
      const script = [
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
        `rm -rf ${q(`${bundle}.old`)}`,
        `mv ${q(bundle)} ${q(`${bundle}.old`)} && ditto ${q(this.state.file)} ${q(bundle)} && rm -rf ${q(`${bundle}.old`)} || { rm -rf ${q(bundle)}; mv ${q(`${bundle}.old`)} ${q(bundle)}; }`,
        `xattr -dr com.apple.quarantine ${q(bundle)} 2>/dev/null`,
        relaunch ? `open ${q(bundle)}` : 'true',
      ].join('\n');
      spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
    } else return false;
    this.state.status = 'installing';
    return true;
  }
}

module.exports = { AppUpdater };
