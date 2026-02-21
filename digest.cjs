'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const { fetchFeed } = require('./fetch-feed.cjs');
const { scoreItem } = require('./score-item.cjs');

const DIR = __dirname;
const FEEDS_FILE = path.join(DIR, 'feeds.json');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'digest.log');
const MAX_GUIDS = 500;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Telegram send ─────────────────────────────────────────────────────────────

function getBotToken() {
  // Try env first, then openclaw config
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const ocConfig = JSON.parse(fs.readFileSync('/home/ajans/.openclaw/openclaw.json', 'utf8'));
    return ocConfig.channels?.telegram?.botToken || null;
  } catch {
    return null;
  }
}

function sendTelegram(chatId, text) {
  return new Promise((resolve, reject) => {
    const token = getBotToken();
    if (!token) return reject(new Error('Telegram bot token not found'));

    // Telegram limit: 4096 chars
    const safeText = text.length > 4096 ? text.slice(0, 4090) + '\n…' : text;

    const body = JSON.stringify({ chat_id: chatId, text: safeText });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const parsed = JSON.parse(raw);
          if (parsed.ok) resolve(parsed);
          else reject(new Error(`Telegram error: ${raw}`));
        } catch {
          reject(new Error(`Telegram non-JSON response: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── ntfy send ─────────────────────────────────────────────────────────────────

function sendNtfy(server, topic, title, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${server}/${topic}`);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyBuf = Buffer.from(body, 'utf8');

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Title': title,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': bodyBuf.length,
      },
    };

    const req = lib.request(options, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`ntfy HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Digest format ─────────────────────────────────────────────────────────────

function formatDigest(topItems, stats) {
  const now = new Date();
  const dayName = now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/Oslo' });
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Oslo' });
  const header = `📰 Morning Digest — ${dayName} ${dateStr}`;

  const lines = [header, ''];

  for (const { item, feedName, score } of topItems) {
    const icon = score >= 4 ? '🔴' : score >= 3 ? '🔶' : '🔵';
    lines.push(`${icon} Score ${score} | ${feedName}`);
    lines.push(item.title);
    lines.push(item.link);
    lines.push('');
  }

  lines.push('─────────────────');
  lines.push(`${stats.feedsChecked} feeds checked | ${stats.newItems} new items | ${stats.relevant} relevant`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main({ ignoreSeenGuids = false, dryRun = false } = {}) {
  log('Starting digest run');

  const config = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }

  const enabledFeeds = config.feeds.filter((f) => f.enabled);
  const allScoredItems = [];
  let totalNew = 0;
  let feedsChecked = 0;
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const feed of enabledFeeds) {
    try {
      log(`Fetching ${feed.name} (${feed.url})`);
      const items = await fetchFeed(feed.url);

      const feedState = state[feed.id] || { last_check: null, seen_guids: [] };
      const seenSet = new Set(feedState.seen_guids || []);

      // Filter: not seen + within last 24h
      const newItems = items.filter((item) => {
        if (!ignoreSeenGuids && seenSet.has(item.guid)) return false;
        if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!isNaN(d.getTime()) && d < cutoff24h) return false;
        }
        return true;
      });

      totalNew += newItems.length;
      log(`  ${feed.name}: ${items.length} total, ${newItems.length} new`);

      // Score new items
      for (const item of newItems) {
        const score = scoreItem(item, feed.keywords || []);
        if (score >= config.digest.min_score) {
          allScoredItems.push({ item, feedName: feed.name, feedId: feed.id, score });
        }
      }

      // Update state: add ALL fetched guids (even old ones, for dedup)
      const allGuids = items.map((i) => i.guid).filter(Boolean);
      const combined = [...new Set([...feedState.seen_guids, ...allGuids])];
      // Trim to last MAX_GUIDS
      const trimmed = combined.slice(-MAX_GUIDS);
      state[feed.id] = {
        last_check: now.toISOString(),
        seen_guids: trimmed,
      };

      feedsChecked++;
    } catch (err) {
      log(`  ERROR fetching ${feed.name}: ${err.message}`);
    }
  }

  // Sort by score descending, take top N
  allScoredItems.sort((a, b) => b.score - a.score);
  const topItems = allScoredItems.slice(0, config.digest.max_items);

  log(`Total new: ${totalNew}, relevant: ${allScoredItems.length}, top: ${topItems.length}`);

  if (topItems.length === 0 && !config.digest.send_even_if_empty) {
    log('No relevant items today — skipping send');
    if (!ignoreSeenGuids) {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
    return { sent: false, message: 'No relevant items' };
  }

  const digestText = formatDigest(topItems, {
    feedsChecked,
    newItems: totalNew,
    relevant: allScoredItems.length,
  });

  if (dryRun) {
    console.log('=== DRY RUN ===');
    console.log(digestText);
    log('Dry run complete — not sent');
    return { sent: false, dryRun: true, message: digestText };
  }

  // Send Telegram
  try {
    await sendTelegram(config.telegram.chatId, digestText);
    log('Telegram sent OK');
  } catch (err) {
    log(`Telegram ERROR: ${err.message}`);
  }

  // Send ntfy
  try {
    const ntfyTitle = 'Morning Digest';
    await sendNtfy(config.ntfy.server, config.ntfy.topic, ntfyTitle, digestText);
    log('ntfy sent OK');
  } catch (err) {
    log(`ntfy ERROR: ${err.message}`);
  }

  // Save state
  if (!ignoreSeenGuids) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    log('State saved');
  }

  log('Digest run complete');
  return { sent: true, itemCount: topItems.length };
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
