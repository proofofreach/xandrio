const { createOpdsProvider } = require('./opds');

function createStandardEbooksProvider(options = {}) {
  return createOpdsProvider({
    id: 'standardebooks',
    label: 'Standard Ebooks',
    feedUrl: options.feedUrl || process.env.STANDARD_EBOOKS_OPDS_URL || 'https://standardebooks.org/feeds/opds',
    username: options.username || process.env.STANDARD_EBOOKS_OPDS_USER || '',
    password: options.password || process.env.STANDARD_EBOOKS_OPDS_PASSWORD || '',
    // Standard Ebooks moved every OPDS feed behind a Patrons Circle account:
    // /feeds/opds, /feeds/opds/all and /feeds/opds/new-releases all answer 401
    // to an anonymous client. Without credentials the source can only ever fail,
    // so it reports itself unconfigured rather than erroring on every search.
    requiresAuth: options.requiresAuth !== false,
    timeoutMs: options.timeoutMs || process.env.STANDARD_EBOOKS_OPDS_TIMEOUT_MS || 12000
  });
}

module.exports = { createStandardEbooksProvider };
