import { createClient } from 'redis';

const GROUPS = ['stations', 'starlink', 'gps-ops', 'weather', 'iridium-NEXT'];

const celestrakUrl = (group) =>
    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;

export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    const client = createClient({
        url: process.env.REDIS_URL
    });

    client.on('error', (err) => console.error('Redis Client Error', err));

    try {
        await client.connect();

        const results = {};

        for (const group of GROUPS) {
            try {
                const upstream = await fetch(celestrakUrl(group));
                if (!upstream.ok) {
                    results[group] = `error: HTTP ${upstream.status}`;
                    continue;
                }
                const text = await upstream.text();
                if (!text || text.length < 50) {
                    results[group] = 'error: empty or malformed response';
                    continue;
                }

                await client.set(`tle:${group}`, text, { EX: 7200 });
                await client.set(`tle:${group}:updated`, new Date().toISOString(), { EX: 7200 });

                const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
                results[group] = `ok (${Math.floor(lineCount / 3)} satellites)`;
            } catch (err) {
                results[group] = `error: ${err.message}`;
            }
        }

        res.status(200).json({
            ok: true,
            timestamp: new Date().toISOString(),
            results
        });
    } catch (error) {
        console.error('Serverless Function Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        if (client.isOpen) {
            await client.quit();
        }
    }
}
