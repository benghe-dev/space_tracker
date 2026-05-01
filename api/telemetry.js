import { kv } from '@vercel/kv';

const ALLOWED_GROUPS = ['stations', 'starlink', 'gps-ops', 'weather', 'iridium-NEXT'];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const group = req.query.group;
    if (!group || !ALLOWED_GROUPS.includes(group)) {
        return res.status(400).json({
            error: 'Invalid or missing "group" parameter',
            allowed: ALLOWED_GROUPS
        });
    }

    try {
        const data = await kv.get(`tle:${group}`);
        if (!data) {
            return res.status(404).json({
                error: `No cached data for group: ${group}`,
                hint: 'Cron may not have run yet. Trigger /api/cron manually or wait for the next schedule.'
            });
        }

        const updatedAt = await kv.get(`tle:${group}:updated`);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (updatedAt) res.setHeader('X-Updated-At', updatedAt);
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
        return res.status(200).send(data);
    } catch (err) {
        console.error('KV read error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
