'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const USER_AGENT = 'Mozilla/5.0 (compatible; Kite-RSS/1.0)';
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

// ── XML helpers ──────────────────────────────────────────────────────────────

function extractTag(xml, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`,
    'i'
  );
  const m = xml.match(re);
  if (!m) return '';
  return (m[1] || m[2] || '').trim();
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── HTTP fetch with redirect support ─────────────────────────────────────────

function fetchUrl(urlStr, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(
      urlStr,
      {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) {
            return reject(new Error('Too many redirects'));
          }
          const location = res.headers['location'];
          if (!location) return reject(new Error('Redirect with no Location header'));
          // Resolve relative redirects
          const nextUrl = new URL(location, urlStr).href;
          res.resume(); // drain
          return resolve(fetchUrl(nextUrl, redirectsLeft - 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${urlStr}`));
    });

    req.on('error', reject);
  });
}

// ── Feed parsing ─────────────────────────────────────────────────────────────

function splitItems(xml) {
  // Try RSS <item> first, then Atom <entry>
  const itemBlocks = [];
  const rssRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const atomRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let m;
  while ((m = rssRe.exec(xml)) !== null) itemBlocks.push({ type: 'rss', block: m[1] });
  if (itemBlocks.length === 0) {
    while ((m = atomRe.exec(xml)) !== null) itemBlocks.push({ type: 'atom', block: m[1] });
  }
  return itemBlocks;
}

function parseItem(block, type) {
  let title = extractTag(block, 'title');
  title = stripHtml(title);

  let link = '';
  if (type === 'atom') {
    // Atom: prefer <link rel="alternate" href="..."/> or <link href="..."/>
    link = extractAttr(block, 'link', 'href');
    if (!link) link = extractTag(block, 'link');
  } else {
    link = extractTag(block, 'link');
    if (!link) link = extractAttr(block, 'link', 'href');
  }
  link = link.trim();

  // Description: try description, then summary, then content
  let description = extractTag(block, 'description') ||
                    extractTag(block, 'summary') ||
                    extractTag(block, 'content');
  description = stripHtml(description);
  // Trim to 500 chars for scoring/display
  if (description.length > 500) description = description.slice(0, 500) + '…';

  // pubDate: RSS = pubDate, Atom = published || updated
  let pubDateStr = extractTag(block, 'pubDate') ||
                   extractTag(block, 'published') ||
                   extractTag(block, 'updated') ||
                   extractTag(block, 'dc:date');
  let pubDate = null;
  if (pubDateStr) {
    const d = new Date(pubDateStr.trim());
    if (!isNaN(d.getTime())) pubDate = d.toISOString();
  }

  // guid / id
  let guid = extractTag(block, 'guid') || extractTag(block, 'id') || link || title;

  return { guid, title, link, description, pubDate };
}

// ── Main export / CLI ─────────────────────────────────────────────────────────

async function fetchFeed(url) {
  const xml = await fetchUrl(url);
  const blocks = splitItems(xml);
  const items = blocks.map(({ type, block }) => parseItem(block, type));

  // Sort newest-first (items without pubDate go to end)
  items.sort((a, b) => {
    if (!a.pubDate && !b.pubDate) return 0;
    if (!a.pubDate) return 1;
    if (!b.pubDate) return -1;
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  return items;
}

module.exports = { fetchFeed };

// CLI usage: node fetch-feed.cjs <url>
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node fetch-feed.cjs <url>');
    process.exit(1);
  }
  fetchFeed(url)
    .then((items) => console.log(JSON.stringify(items, null, 2)))
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
