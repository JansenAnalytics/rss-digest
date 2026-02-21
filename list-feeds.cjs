'use strict';

const fs = require('fs');
const path = require('path');

const FEEDS_FILE = path.join(__dirname, 'feeds.json');
const STATE_FILE = path.join(__dirname, 'state.json');

function padEnd(str, len) {
  return String(str).padEnd(len, ' ');
}

function main() {
  const config = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* ignore */ }

  const header = [
    padEnd('ID', 20),
    padEnd('Name', 20),
    padEnd('Status', 10),
    padEnd('Last Check', 22),
    padEnd('Keywords', 40),
  ].join('  ');

  console.log(header);
  console.log('─'.repeat(header.length));

  for (const feed of config.feeds) {
    const feedState = state[feed.id];
    const lastCheck = feedState && feedState.last_check
      ? new Date(feedState.last_check).toLocaleString('sv-SE', { timeZone: 'Europe/Oslo' }).slice(0, 16).replace('T', ' ')
      : 'never';
    const status = feed.enabled ? 'enabled' : 'disabled';
    const keywords = (feed.keywords || []).join(', ').slice(0, 38);

    console.log([
      padEnd(feed.id, 20),
      padEnd(feed.name, 20),
      padEnd(status, 10),
      padEnd(lastCheck, 22),
      keywords,
    ].join('  '));
  }

  console.log('');
  console.log(`Total: ${config.feeds.length} feeds (${config.feeds.filter((f) => f.enabled).length} enabled)`);
}

main();
