'use strict';

const fs = require('fs');
const path = require('path');

// Small JSON file store with atomic writes.
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
  }
  load() {
    try {
      return { ...this.defaults(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep a copy of an unreadable file rather than silently overwriting it.
        try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      return this.defaults();
    }
  }
  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
