'use strict';

const fs = require('fs');
const path = require('path');

const FEEDS_FILE = path.join(__dirname, 'feeds.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] || '';
      i++;
    }
  }
  return args;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.name || !args.url) {
    console.error('Usage: node add-feed.cjs --name "Feed Name" --url "https://..." --keywords "kw1,kw2"');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));

  // Generate unique ID
  let id = slugify(args.name);
  const existingIds = config.feeds.map((f) => f.id);
  if (existingIds.includes(id)) {
    let counter = 2;
    while (existingIds.includes(`${id}-${counter}`)) counter++;
    id = `${id}-${counter}`;
  }

  const keywords = args.keywords
    ? args.keywords.split(',').map((k) => k.trim()).filter(Boolean)
    : [];

  const feed = {
    id,
    name: args.name,
    url: args.url,
    keywords,
    enabled: true,
  };

  config.feeds.push(feed);
  fs.writeFileSync(FEEDS_FILE, JSON.stringify(config, null, 2));

  console.log(`Added feed: ${id}`);
  console.log(JSON.stringify(feed, null, 2));
}

main();
