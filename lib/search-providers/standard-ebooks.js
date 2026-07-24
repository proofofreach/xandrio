const { createOpdsProvider } = require('./opds');

function createStandardEbooksProvider(options = {}) {
  return createOpdsProvider({
    id: 'standardebooks',
    label: 'Standard Ebooks',
    feedUrl: options.feedUrl || process.env.STANDARD_EBOOKS_OPDS_URL || 'https://standardebooks.org/feeds/opds',
    username: options.username || process.env.STANDARD_EBOOKS_OPDS_USER || '',
    password: options.password || process.env.STANDARD_EBOOKS_OPDS_PASSWORD || '',
    requiresAuth: options.requiresAuth === true,
    timeoutMs: options.timeoutMs || process.env.STANDARD_EBOOKS_OPDS_TIMEOUT_MS || 12000
  });
}

module.exports = { createStandardEbooksProvider };
