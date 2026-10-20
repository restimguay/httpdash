'use strict';

const crypto = require('crypto');

const uid = () => crypto.randomUUID();

function newRequestDef(overrides = {}) {
  return {
    method: 'GET',
    url: '',
    params: [],
    pathVariables: [],
    headers: [],
    body: { mode: 'none', raw: '', rawLanguage: 'json', urlencoded: [], formdata: [], binary: '', graphql: { query: '', variables: '' } },
    auth: { type: 'inherit' },
    preRequestScript: '',
    testScript: '',
    description: '',
    ...overrides,
  };
}

function newRequestItem(name = 'New Request', request = {}) {
  return { id: uid(), type: 'request', name, request: newRequestDef(request) };
}

function newFolder(name = 'New Folder') {
  return { id: uid(), type: 'folder', name, description: '', items: [], auth: { type: 'inherit' }, preRequestScript: '', testScript: '' };
}

function newCollection(name = 'New Collection') {
  return { id: uid(), type: 'collection', name, description: '', items: [], variables: [], auth: { type: 'none' }, preRequestScript: '', testScript: '' };
}

function newEnvironment(name = 'New Environment') {
  return { id: uid(), name, values: [] };
}

module.exports = { uid, newRequestDef, newRequestItem, newFolder, newCollection, newEnvironment };
