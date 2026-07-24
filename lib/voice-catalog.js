// Per-instance voice-provider allowlist.
//
// One codebase serves instances with very different narration hardware (see
// docs/DEPLOYMENT_TOPOLOGY.md). XANDRIO_VOICE_PROVIDERS declares which voice
// providers this instance actually offers, e.g. "edge,kokoro" on a web host
// without the Chatterbox model runtime. Unset (or empty) means all providers,
// preserving historical behavior for local all-in-one installs.

function parseVoiceProviders(envValue) {
  const raw = String(envValue || '').trim();
  if (!raw) return null;
  const providers = new Set(
    raw.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
  );
  return providers.size > 0 ? providers : null;
}

function filterVoicesByProvider(voices, allowedProviders) {
  if (!allowedProviders) return voices;
  return voices.filter(voice => allowedProviders.has(String(voice.provider || '').toLowerCase()));
}

module.exports = { parseVoiceProviders, filterVoicesByProvider };
