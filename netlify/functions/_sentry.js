// ============================================================================
// _sentry.js — zero-dependency Sentry shim.
//
// We avoid pulling @sentry/node into every Netlify function deploy (it's a
// large dependency and only one of many monitoring options). Instead we
// post error events directly to Sentry's HTTP "envelope" API using https.
//
// Usage:
//   const { reportError, wrap } = require('./_sentry');
//   exports.handler = wrap('my-function', async (event) => { ... });
//
// Or for explicit error reporting:
//   try { ... } catch (e) { await reportError(e, { fn: 'my-function', ctx: {...} }); throw e; }
//
// Activation: set SENTRY_DSN in Netlify env vars to a project DSN that looks
// like https://<key>@<host>/<projectId>. Without it, this module is a no-op
// — code runs identically, no network calls, no extra latency.
//
// The underscore prefix excludes this file from being deployed as its own
// Netlify Function endpoint.
// ============================================================================
const https = require('https');
const url   = require('url');

const DSN     = process.env.SENTRY_DSN || '';
const RELEASE = process.env.COMMIT_REF || process.env.HEAD || 'unknown';
const ENV     = process.env.CONTEXT || 'production';

// Parse the DSN once at module load
let parsed = null;
if (DSN) {
  try {
    const u = new url.URL(DSN);
    parsed = {
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      protocol: u.protocol,
      projectId: u.pathname.replace(/^\//, ''),
      publicKey: u.username,
    };
  } catch (e) {
    console.warn('[sentry] invalid SENTRY_DSN — disabling:', e.message);
  }
}

function isEnabled() { return parsed !== null; }

function ingestUrl() {
  return `${parsed.protocol}//${parsed.host}:${parsed.port}/api/${parsed.projectId}/envelope/`;
}

function authHeader() {
  return `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=quarry-shim/1.0`;
}

// Send a single error event using the Sentry envelope format
async function reportError(err, context) {
  if (!isEnabled()) return false;
  try {
    const eventId = require('crypto').randomBytes(16).toString('hex');
    const now = new Date().toISOString();

    const event = {
      event_id: eventId,
      timestamp: now,
      level: 'error',
      platform: 'node',
      environment: ENV,
      release: RELEASE,
      logger: (context && context.fn) || 'unknown',
      tags: { fn: (context && context.fn) || 'unknown' },
      extra: (context && context.ctx) || {},
      exception: {
        values: [{
          type: (err && err.name) || 'Error',
          value: (err && err.message) || String(err),
          stacktrace: err && err.stack ? {
            frames: parseStack(err.stack),
          } : undefined,
        }],
      },
    };

    const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: now });
    const itemHeader     = JSON.stringify({ type: 'event' });
    const itemPayload    = JSON.stringify(event);
    const body = envelopeHeader + '\n' + itemHeader + '\n' + itemPayload;

    await new Promise((resolve) => {
      const req = https.request({
        hostname: parsed.host,
        port: parsed.port,
        path: `/api/${parsed.projectId}/envelope/`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'Content-Length': Buffer.byteLength(body),
          'X-Sentry-Auth': authHeader(),
        },
      }, (res) => {
        // Drain the response; we don't care about the body
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', (e) => { console.warn('[sentry] send failed:', e.message); resolve(); });
      req.setTimeout(3000, () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
    return true;
  } catch (e) {
    // Never let monitoring break the request
    console.warn('[sentry] internal error:', e && e.message);
    return false;
  }
}

function parseStack(stackStr) {
  return String(stackStr || '').split('\n').slice(1).map((line) => {
    const m = line.match(/at\s+(?:(\S+)\s+\()?(.+?):(\d+):(\d+)\)?/);
    if (!m) return { function: line.trim() };
    return {
      function: m[1] || '<anonymous>',
      filename: m[2],
      lineno: parseInt(m[3], 10),
      colno: parseInt(m[4], 10),
    };
  });
}

// Convenience wrapper: any thrown error inside the handler is reported and re-thrown
function wrap(fnName, handler) {
  return async (event, ctx) => {
    try {
      return await handler(event, ctx);
    } catch (e) {
      // Best-effort report; never block the response on this
      reportError(e, {
        fn: fnName,
        ctx: {
          method: event && event.httpMethod,
          path: event && event.path,
        },
      }).catch(() => {});
      throw e;
    }
  };
}

module.exports = { reportError, wrap, isEnabled };
