import { kv } from '@vercel/kv';

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

            await kv.set(`tle:${group}`, text, { ex: 7200 });
            await kv.set(`tle:${group}:updated`, new Date().toISOString(), { ex: 7200 });

            const lineCount = text.split('\n').filter(l => l.trim().length > 0).length;
            results[group] = `ok (${Math.floor(lineCount / 3)} satellites)`;
        } catch (err) {
            results[group] = `error: ${err.message}`;
        }
    }

    return res.status(200).json({
        ok: true,
        timestamp: new Date().toISOString(),
        results
    });
}
