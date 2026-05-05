// cosmo/src/news.js — fetch topical substrate for koan generation.
// Free sources only: RSS feeds + Reddit JSON. No auth, no quota.
// Used by character.js when planner picks 'koan' mode.

const SOURCES = [
  // Reddit JSON — top posts of the day from relevant subs
  { type: 'reddit', sub: 'CryptoCurrency', limit: 5, weight: 3 },
  { type: 'reddit', sub: 'solana',         limit: 5, weight: 2 },
  { type: 'reddit', sub: 'singularity',    limit: 5, weight: 2 },
  { type: 'reddit', sub: 'OpenAI',         limit: 5, weight: 1 },
  { type: 'reddit', sub: 'LocalLLaMA',     limit: 5, weight: 1 },

  // RSS — crypto + AI news outlets
  { type: 'rss', url: 'https://cointelegraph.com/rss',                       weight: 2 },
  { type: 'rss', url: 'https://decrypt.co/feed',                             weight: 2 },
  { type: 'rss', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',     weight: 2 },
  // Hacker News top stories
  { type: 'hn',  weight: 3 },
];

async function fetchReddit(sub, limit) {
  const url = `https://www.reddit.com/r/${sub}/top.json?t=day&limit=${limit}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'diodegenes-bot/0.1 (+https://byagentforagent.com)' },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data?.children || []).map((c) => ({
      title: c.data.title,
      score: c.data.score,
      url: 'https://reddit.com' + c.data.permalink,
      source: `r/${sub}`,
    }));
  } catch (e) {
    return [];
  }
}

async function fetchRss(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'diodegenes-bot/0.1' },
    });
    if (!r.ok) return [];
    const text = await r.text();
    // Crude RSS/Atom parser — extracts <title>...</title> + <link>...</link> per item.
    // Doesn't need to be robust; we just need topical headlines as substrate.
    const items = [];
    const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;
    let i = 0;
    while ((m = itemRe.exec(text)) !== null && i < 8) {
      const block = m[1];
      const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block);
      const linkMatch  = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(block);
      if (titleMatch) {
        items.push({
          title: titleMatch[1].trim(),
          url: linkMatch ? linkMatch[1].trim() : '',
          source: new URL(url).hostname,
        });
        i++;
      }
    }
    return items;
  } catch (e) {
    return [];
  }
}

async function fetchHN() {
  try {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!idsRes.ok) return [];
    const ids = (await idsRes.json()).slice(0, 8);
    const stories = await Promise.all(
      ids.map(async (id) => {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!r.ok) return null;
        const item = await r.json();
        return {
          title: item.title || '',
          score: item.score || 0,
          url: item.url || `https://news.ycombinator.com/item?id=${id}`,
          source: 'HN',
        };
      })
    );
    return stories.filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Returns one topical headline, weighted across sources.
async function fetchTopicalHeadline() {
  // Pick a source weighted
  const totalWeight = SOURCES.reduce((s, x) => s + x.weight, 0);
  let roll = Math.random() * totalWeight;
  let chosen = SOURCES[0];
  for (const s of SOURCES) {
    roll -= s.weight;
    if (roll <= 0) { chosen = s; break; }
  }

  let items = [];
  if (chosen.type === 'reddit') items = await fetchReddit(chosen.sub, chosen.limit);
  else if (chosen.type === 'rss')    items = await fetchRss(chosen.url);
  else if (chosen.type === 'hn')     items = await fetchHN();

  if (items.length === 0) return null;
  // Pick a random item from the top results (not always #1, for variety)
  const pick = items[Math.floor(Math.random() * Math.min(items.length, 5))];
  return pick;
}

module.exports = { fetchTopicalHeadline, SOURCES };
