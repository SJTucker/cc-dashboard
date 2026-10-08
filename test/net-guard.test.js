'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { hostGuard, securityHeaders } = require('../lib/net-guard');
const { bootServer } = require('./helpers');

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = (type) => { res.headers['content-type'] = type; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  return res;
}

function runGuard(host) {
  const req = { headers: host === undefined ? {} : { host } };
  const res = fakeRes();
  let nextCalled = false;
  hostGuard(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('hostGuard lets loopback hosts through', () => {
  for (const host of ['localhost', 'localhost:3600', '127.0.0.1:3600', '[::1]:3600', 'LOCALHOST']) {
    const { res, nextCalled } = runGuard(host);
    assert.strictEqual(nextCalled, true, `Host: ${host}`);
    assert.strictEqual(res.statusCode, 200, `Host: ${host}`);
  }
});

test('hostGuard answers 403 text/plain to every other host, an empty host and a missing host', () => {
  const hosts = ['evil.example', 'localhost.evil.com', '127.0.0.1.evil.com', '[::2]:3600', '', undefined];
  for (const host of hosts) {
    const { res, nextCalled } = runGuard(host);
    assert.strictEqual(nextCalled, false, `Host: ${JSON.stringify(host)}`);
    assert.strictEqual(res.statusCode, 403, `Host: ${JSON.stringify(host)}`);
    assert.strictEqual(res.headers['content-type'], 'text/plain', `Host: ${JSON.stringify(host)}`);
    assert.match(res.body, /^403 Forbidden/);
  }
});

test('securityHeaders sets the four headers and calls next', () => {
  const res = fakeRes();
  let nextCalled = false;
  securityHeaders({}, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
  assert.strictEqual(res.headers['content-security-policy'], CSP);
});

// Node's fetch cannot set Host, so these requests use http.request.
function get(port, urlPath, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { host, connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('the real server answers 403 to a foreign Host on a page and on an API route', async (t) => {
  const { port } = await bootServer(t);
  for (const urlPath of ['/', '/api/summary?days=7']) {
    const res = await get(port, urlPath, 'evil.example');
    assert.strictEqual(res.status, 403, urlPath);
    assert.match(res.body, /^403 Forbidden/, urlPath);
  }
});

test('the real server serves index.html to Host: localhost with the four security headers', async (t) => {
  const { port } = await bootServer(t);
  const res = await get(port, '/index.html', 'localhost');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
  assert.strictEqual(res.headers['content-security-policy'], CSP);
});
