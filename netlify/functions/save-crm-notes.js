// ============================================================================
// save-crm-notes.js — Replaces the missing endpoint the existing CRM tab calls.
//
// Persists notes + tags per contact email to marketing_crm.json (in repo via
// data-store). Two routes:
//
//   GET   /.netlify/functions/save-crm-notes
//         → { ok, contacts: { "email@x.com": { notes: [...], tags: [...] } } }
//
//   POST  /.netlify/functions/save-crm-notes
//         body: { email, action: 'addNote', note: 'string' }
//         body: { email, action: 'addTag', tag: 'string' }
//         body: { email, action: 'removeTag', tag: 'string' }
//         body: { email, action: 'setTags', tags: ['string'] }
//         body: { email, action: 'deleteNote', ts: 'iso' }
// ============================================================================

const fetch = require('node-fetch');
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://thequarrystl.com';
const FILE = 'marketing_crm.json';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-quarry-key',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function loadCrm() {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${FILE}`);
    if (r.status === 404 || r.status === 400) {
        return { data: { contacts: {} }, sha: null };
    }
    if (!r.ok) throw new Error(`load ${FILE}: ${r.status}`);
    const d = await r.json();
    const decoded = (d.decoded && typeof d.decoded === 'object') ? d.decoded : {};
    return { data: { contacts: decoded.contacts || {} }, sha: d.sha };
}

async function saveCrm(json, sha, message) {
    const r = await fetch(`${SITE_URL}/.netlify/functions/data-store?file=${FILE}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json, sha, message })
    });
    if (!r.ok) throw new Error(`save ${FILE}: ${r.status}`);
    return await r.json();
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    if (event.httpMethod === 'GET') {
        try {
            const { data } = await loadCrm();
            return respond(200, { ok: true, contacts: data.contacts || {} });
        } catch (err) { return respond(500, { ok: false, error: err.message }); }
    }

    if (event.httpMethod !== 'POST') return respond(405, { error: 'GET or POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return respond(400, { error: 'Invalid JSON' }); }

    const { email, action } = body;
    if (!email || !action) return respond(400, { error: 'email and action required' });

    try {
        const { data, sha } = await loadCrm();
        const contacts = data.contacts || {};
        const key = String(email).toLowerCase();
        if (!contacts[key]) contacts[key] = { notes: [], tags: [] };
        const c = contacts[key];

        switch (action) {
            case 'addNote': {
                const note = (body.note || '').trim();
                if (!note) return respond(400, { error: 'note required' });
                c.notes.push({ ts: new Date().toISOString(), text: note });
                break;
            }
            case 'addTag': {
                const tag = (body.tag || '').trim();
                if (!tag) return respond(400, { error: 'tag required' });
                if (!c.tags.includes(tag)) c.tags.push(tag);
                break;
            }
            case 'removeTag': {
                c.tags = c.tags.filter((t) => t !== body.tag);
                break;
            }
            case 'setTags': {
                if (!Array.isArray(body.tags)) return respond(400, { error: 'tags array required' });
                c.tags = body.tags.map((t) => String(t).trim()).filter(Boolean);
                break;
            }
            case 'deleteNote': {
                c.notes = (c.notes || []).filter((n) => n.ts !== body.ts);
                break;
            }
            default:
                return respond(400, { error: 'unknown action: ' + action });
        }

        contacts[key] = c;
        const fileObj = { version: 1, updatedAt: new Date().toISOString(), contacts };
        await saveCrm(fileObj, sha, `crm: ${action} ${key}`);
        return respond(200, { ok: true, contact: c });
    } catch (err) {
        return respond(500, { ok: false, error: err.message });
    }
};
