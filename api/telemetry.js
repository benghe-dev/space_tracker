import { createClient } from 'redis';

const ALLOWED_GROUPS = ['stations', 'starlink', 'gps-ops', 'weather', 'iridium-NEXT'];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const group = req.query.group;
    if (!group || !ALLOWED_GROUPS.includes(group)) {
        return res.status(400).json({
            error: 'Invalid or missing "group" parameter',
            allowed: ALLOWED_GROUPS
        });
    }

    const client = createClient({
        url: process.env.REDIS_URL
    });

    client.on('error', (err) => console.error('Redis Client Error', err));

    try {
        await client.connect();

        const data = await client.get(`tle:${group}`);
        if (!data) {
            return res.status(404).json({
                error: `No cached data for group: ${group}`,
                hint: 'Cron may not have run yet. Trigger /api/cron manually.'
            });
        }

        const updatedAt = await client.get(`tle:${group}:updated`);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (updatedAt) res.setHeader('X-Updated-At', updatedAt);
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
        res.status(200).send(data);
    } catch (error) {
        console.error('Serverless Function Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        if (client.isOpen) {
            await client.quit();
        }
    }
}
