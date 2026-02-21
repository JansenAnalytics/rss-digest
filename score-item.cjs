'use strict';

/**
 * Score an item for relevance against a list of keywords.
 * Body match = +1, title match = +1 additional (title worth 2x total).
 */
function scoreItem(item, keywords) {
  const text = (item.title + ' ' + item.description).toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const kwl = kw.toLowerCase();
    if (text.includes(kwl)) score += 1;
    if (item.title.toLowerCase().includes(kwl)) score += 1;
  }
  return score;
}

module.exports = { scoreItem };
