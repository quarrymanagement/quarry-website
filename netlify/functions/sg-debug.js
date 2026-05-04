// Diagnostic helper: proxy specific SendGrid API calls so we can debug
// upsert/list/singlesend state from outside Netlify.
// Accepts ?action=... and returns the raw SendGrid response.
const fetch = require('node-fetch');

const SG_KEY = process.env.SENDGRID_API_KEY;
const LIST_SUB = process.env.SENDGRID_LIST_SUBSCRIBED;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const respond = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (!SG_KEY) return respond(500, { error: 'SENDGRID_API_KEY missing' });

    const params = event.queryStringParameters || {};
    const action = params.action || '';

    try {
        if (action === 'list-count') {
            const id = params.listId;
            if (!id) return respond(400, { error: 'listId required' });
            const r = await fetch(`https://api.sendgrid.com/v3/marketing/lists/${id}/contacts/count`, {
                headers: { 'Authorization': `Bearer ${SG_KEY}` }
            });
            const data = await r.json();
            return respond(200, { status: r.status, data });
        }

        if (action === 'list-info') {
            const id = params.listId;
            if (!id) return respond(400, { error: 'listId required' });
            const r = await fetch(`https://api.sendgrid.com/v3/marketing/lists/${id}?contact_sample=true`, {
                headers: { 'Authorization': `Bearer ${SG_KEY}` }
            });
            const data = await r.json();
            return respond(200, { status: r.status, data });
        }

        if (action === 'cancel-singlesend') {
            const id = params.id;
            if (!id) return respond(400, { error: 'id required' });
            // First unschedule, then delete
            const u = await fetch(`https://api.sendgrid.com/v3/marketing/singlesends/${id}/schedule`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${SG_KEY}` }
            });
            const ub = u.status >= 200 && u.status < 300 ? 'unscheduled' : await u.text();
            const d = await fetch(`https://api.sendgrid.com/v3/marketing/singlesends/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${SG_KEY}` }
            });
            const db = d.status >= 200 && d.status < 300 ? 'deleted' : await d.text();
            return respond(200, { unscheduleStatus: u.status, unscheduleBody: ub, deleteStatus: d.status, deleteBody: db });
        }

        if (action === 'singlesend-info') {
            const id = params.id;
            if (!id) return respond(400, { error: 'id required' });
            const r = await fetch(`https://api.sendgrid.com/v3/marketing/singlesends/${id}`, {
                headers: { 'Authorization': `Bearer ${SG_KEY}` }
            });
            const data = await r.json();
            return respond(200, { status: r.status, data });
        }

        if (action === 'upsert-test') {
            // Test upsert ONE email and return the full response.
            // POST /sg-debug?action=upsert-test  body: {"email":"x@y.z","listId":"..."}
            let body = {};
            try { body = JSON.parse(event.body || '{}'); } catch (_) {}
            const email = body.email || params.email;
            const listId = body.listId || params.listId || LIST_SUB;
            if (!email) return respond(400, { error: 'email required' });
            const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ list_ids: [listId], contacts: [{ email }] })
            });
            const text = await r.text();
            let data; try { data = JSON.parse(text); } catch { data = text; }
            return respond(200, { status: r.status, data, listId, email });
        }

        if (action === 'lookup') {
            const email = params.email;
            if (!email) return respond(400, { error: 'email required' });
            const r = await fetch('https://api.sendgrid.com/v3/marketing/contacts/search/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails: [email] })
            });
            const text = await r.text();
            let data; try { data = JSON.parse(text); } catch { data = text; }
            return respond(200, { status: r.status, data });
        }

        if (action === 'job-status') {
            // GET status of a contacts upsert job
            const jobId = params.jobId;
            if (!jobId) return respond(400, { error: 'jobId required' });
            const r = await fetch(`https://api.sendgrid.com/v3/marketing/contacts/imports/${jobId}`, {
                headers: { 'Authorization': `Bearer ${SG_KEY}` }
            });
            const text = await r.text();
            let data; try { data = JSON.parse(text); } catch { data = text; }
            return respond(200, { status: r.status, data });
        }

        return respond(400, { error: 'unknown action', actions: ['list-count', 'list-info', 'cancel-singlesend', 'singlesend-info', 'upsert-test', 'lookup', 'job-status'] });
    } catch (err) {
        return respond(500, { error: err.message });
    }
};
