'use strict';

const { createPpqBookGuideProvider } = require('./book-guide-provider');
const { createOpenAiBookGuideProvider } = require('./book-guide-openai-provider');

function createConfiguredBookGuideProvider({ env = process.env, store, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  // Legacy opt-in selects the replacement, never the removed agent runner.
  const id = env.XANDRIO_BOOK_GUIDE_PROVIDER || (env.XANDRIO_PRIVATE_CODEX_GUIDES === '1' ? 'openai-api' : 'ppq-ai');
  if (!['ppq-ai', 'openai-api'].includes(id)) throw new TypeError('XANDRIO_BOOK_GUIDE_PROVIDER must be ppq-ai or openai-api');
  if (!store?.loadCredentials) throw new TypeError('Book guide credential store is required');
  const getApiKey = async () => {
    const stored = await store.loadCredentials();
    // Untagged credentials predate provider selection and belong to PPQ only.
    const storedProvider = stored.provider || 'ppq-ai';
    return (storedProvider === id ? stored.apiKey : '') || (id === 'openai-api' ? env.OPENAI_API_KEY : env.PPQ_API_KEY) || '';
  };
  return (id === 'openai-api' ? createOpenAiBookGuideProvider : createPpqBookGuideProvider)({ getApiKey, fetchImpl, timeoutMs });
}
module.exports = { createConfiguredBookGuideProvider };
