'use strict';

// A small subset of the CryptoJS API, which many Postman scripts rely on.
const crypto = require('crypto');

class WordArray {
  constructor(buf) {
    this.buffer = Buffer.from(buf);
    this.sigBytes = this.buffer.length;
  }
  toString(encoder) {
    return (encoder || enc.Hex).stringify(this);
  }
}

const toBuf = (v) => (v instanceof WordArray ? v.buffer : Buffer.from(v == null ? '' : String(v), 'utf8'));

const enc = {
  Hex: { stringify: (wa) => wa.buffer.toString('hex'), parse: (s) => new WordArray(Buffer.from(s, 'hex')) },
  Base64: { stringify: (wa) => wa.buffer.toString('base64'), parse: (s) => new WordArray(Buffer.from(s, 'base64')) },
  Utf8: { stringify: (wa) => wa.buffer.toString('utf8'), parse: (s) => new WordArray(Buffer.from(s, 'utf8')) },
  Latin1: { stringify: (wa) => wa.buffer.toString('latin1'), parse: (s) => new WordArray(Buffer.from(s, 'latin1')) },
};

const hash = (alg) => (msg) => new WordArray(crypto.createHash(alg).update(toBuf(msg)).digest());
const hmac = (alg) => (msg, key) => new WordArray(crypto.createHmac(alg, toBuf(key)).update(toBuf(msg)).digest());

const CryptoJS = {
  enc,
  lib: { WordArray: { random: (n) => new WordArray(crypto.randomBytes(n)), create: (b) => new WordArray(b || []) } },
  MD5: hash('md5'),
  SHA1: hash('sha1'),
  SHA256: hash('sha256'),
  SHA512: hash('sha512'),
  HmacMD5: hmac('md5'),
  HmacSHA1: hmac('sha1'),
  HmacSHA256: hmac('sha256'),
  HmacSHA512: hmac('sha512'),
};

module.exports = CryptoJS;
