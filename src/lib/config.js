'use strict';
/* Reads the settings you type into Coolify (Environment variables). */
const https = require('https');

function list(v) { return String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }

function loadConfig(env) {
  const tenantId = String(env.TENANT_ID || '').trim();
  const clientId = String(env.API_CLIENT_ID || '').trim();
  let seedUsers = [];
  try { seedUsers = JSON.parse(env.SEED_USERS || '[]'); } catch (e) { seedUsers = []; }
  return {
    tenantId,
    audiences: list(env.API_AUDIENCE || (clientId ? 'api://' + clientId + ',' + clientId : '')),
    scope: env.API_SCOPE || 'access_as_user',
    allowedDomain: String(env.ALLOWED_DOMAIN || 'syayasan.edu.bn').toLowerCase(),
    adminEmails: list(env.ADMIN_EMAILS),
    seedUsers,
    legacyYear: parseInt(env.LEGACY_YEAR || '2026', 10)
  };
}

function fetchJwks(tenantId) {
  return () => new Promise((resolve, reject) => {
    const req = https.get('https://login.microsoftonline.com/' + encodeURIComponent(tenantId) + '/discovery/v2.0/keys', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Timed out asking Microsoft for signing keys')));
  });
}

module.exports = { loadConfig, fetchJwks };
