'use strict';

// Keeps this server usable only from this machine.
//
// Binding 127.0.0.1 stops other devices on your network from connecting at all.
// It does NOT stop a malicious website you have open in a browser tab from
// pointing a request at http://localhost:<port>/... (your browser will happily
// send that). The Host-header check below is what stops that: it rejects any
// request whose Host header isn't localhost/127.0.0.1, which a same-origin
// browser request to this server will always have, but a page trying to trick
// your browser via DNS rebinding will not.
//
// There is no login/password. Anyone who can reach this port can read your
// Claude Code cost history. Keep BIND_HOST as 127.0.0.1 unless you specifically
// want to expose this on your LAN and understand that trade-off.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function hostnameFromHeader(hostHeader) {
  if (!hostHeader) return null;
  // Strip a trailing :port, being careful not to mangle an IPv6 literal like [::1]:3600.
  const bracket = hostHeader.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket) return bracket[1].toLowerCase();
  return hostHeader.split(':')[0].toLowerCase();
}

function hostGuard(req, res, next) {
  const hostname = hostnameFromHeader(req.headers.host);
  if (hostname && LOOPBACK_HOSTNAMES.has(hostname)) return next();
  res.status(403).type('text/plain').send(
    '403 Forbidden\n\n' +
    'This server only answers requests addressed to localhost. That protects you ' +
    'from a website re-pointing its own hostname at your machine to read this data.\n'
  );
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Everything this page needs is served by this same server - nothing is loaded from
  // a CDN - so the page stays locked to same-origin. 'unsafe-inline' is granted for
  // style only: the charts set per-element colours and bar widths through the style
  // attribute, and without it the browser drops them, which is what left the legend
  // swatches colourless and every cost bar the same length. Scripts are NOT granted
  // it, so the XSS surface that 'unsafe-inline' usually opens stays closed.
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  next();
}

module.exports = { hostGuard, securityHeaders };
