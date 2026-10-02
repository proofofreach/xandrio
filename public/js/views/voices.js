import { API_BASE, apiGet, apiSend } from '../api.js';
import { escapeHTML, safeAttr } from '../util/format.js';
import { showToast } from '../ui/toast.js';
import { registerSheet } from '../ui/sheets.js';
import { confirmSheet } from '../ui/confirm.js';
import { readJSON, writeJSON } from '../util/storage.js';

const SAVED_VOICES_KEY = 'xandrio_saved_voices';

let deps = {};
let playerVoiceStatus = null;
let playerVoiceName = null;
let playerVoiceCache = null;
let voiceSheet = null;
let voiceSheetBackdrop = null;
let voiceSheetClose = null;
let voiceSheetController = null;
let hqVoicePrep = null;
let hqVoicePrepBtn = null;
let hqVoicePrepTitle = null;
let hqVoicePrepDetail = null;
let hqVoicePrepFill = null;
let hqVoicePrepCount = null;

/**
 * Per-chapter premium readiness (booleans) from the last premium-prep poll.
 * Used by the chapter sheet for "Premium audio ready" dots.
 */
export function getPremiumChapterReadiness() {
  return premiumChapterReadiness;
}

export function isPremiumVoiceSelected() {
  return isHighQualityVoice();
}

// --- Voice selection (moved from modal) ---
let voices = [];
let currentVoice = '';
let defaultVoice = '';
let bookNarration = null;
let narrationLoadGeneration = 0;
let voiceSelectionPending = false;
let preparationStale = false;
let unavailableCurrent = null;
let voiceCache = {};
let engineStatus = null;
let sampleAudio = null;
let preSampleVolume = null; // main-playback volume to restore after a sample duck
let hqVoicePrepTimer = null;
// True while a polling chain is live (timer pending OR a tick's await is in
// flight). The timer handle alone can't guard re-entry: a tick nulls it at
// entry, so any updateHighQualityPrepPanel() during the await would start a
// second chain — chains then double every tick until the browser runs out
// of network resources.
let hqVoicePrepPolling = false;
let hqVoicePrepGeneration = 0;
let premiumBookStatus = null;
let premiumChapterReadiness = [];
const premiumToastBooks = new Set();
let savedVoiceIds = [];
let voiceFilters = {
  gender: 'all',
  accent: 'all',
  depth: 'all',
  provider: 'all'
};
const HIGH_QUALITY_PREP_POLL_MS = 2500;

// --- Voice sheet controls (player sheet only; settings page keeps its dropdown filters) ---
// Primary facet is the user-facing tier (Instant plays immediately, Premium
// renders in the background); engine/gender are demoted to "More filters".
const VOICE_FACETS_KEY = 'xandrio_voice_facets';
function loadVoiceSheetFacets() {
  const saved = readJSON(VOICE_FACETS_KEY, null);
  if (saved && typeof saved === 'object') {
    return {
      tier: ['all', 'instant', 'premium'].includes(saved.tier) ? saved.tier : 'all',
      engine: ['all', 'edge', 'kokoro', 'chatterbox', 'moss-nano'].includes(saved.engine) ? saved.engine : 'all',
      gender: ['all', 'male', 'female'].includes(saved.gender) ? saved.gender : 'all'
    };
  }
  return { tier: 'all', engine: 'all', gender: 'all' };
}
let voiceSheetFacets = { tier: 'all', engine: 'all', gender: 'all' };
let voiceSheetQuery = '';       // not persisted — a search is a moment, not a preference
let voiceSheetMoreOpen = false; // "More filters" disclosure
function saveVoiceSheetFacets() {
  writeJSON(VOICE_FACETS_KEY, voiceSheetFacets);
}

function voiceIsPremium(voice) {
  return voice?.tier === 'premium' || voice?.tier === 'chatterbox' || providerId(voice) === 'chatterbox' ||
    String(voice?.id || '').startsWith('chatterbox:');
}

function providerId(voice) { return String(voice?.providerId || voice?.provider || '').toLowerCase(); }
function voiceFilterValue(voice, key) { return key === 'provider' ? providerId(voice) : voice[key]; }

function filterVoicesForSheet(list) {
  const query = voiceSheetQuery.trim().toLowerCase();
  return list.filter(voice => {
    if (voiceSheetFacets.tier === 'premium' && !voiceIsPremium(voice)) return false;
    if (voiceSheetFacets.tier === 'instant' && voiceIsPremium(voice)) return false;
    if (voiceSheetFacets.engine !== 'all' && providerId(voice) !== voiceSheetFacets.engine) return false;
    if (voiceSheetFacets.gender !== 'all' && String(voice.gender || '').toLowerCase() !== voiceSheetFacets.gender) return false;
    if (query) {
      const haystack = [voice.name, voice.provider, voice.accent, voice.depth, ...(voice.tags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function renderVoiceFacetChips(filterBarId) {
  const bar = document.getElementById(filterBarId);
  if (!bar) return;
  const listId = filterBarId === 'player-voice-filter-bar' ? 'player-voice-list' : 'voice-list';

  const chip = (group, value, label, active) => `
    <button type="button" class="voice-facet-chip ${active ? 'active' : ''}" data-facet-group="${safeAttr(group)}" data-facet-value="${safeAttr(value)}" aria-pressed="${active ? 'true' : 'false'}">${escapeHTML(label)}</button>
  `;
  const tierChips = [['all', 'All'], ['instant', 'Instant'], ['premium', 'Premium']];
  const engineChips = [['all', 'All'], ...[['edge', 'Edge'], ['kokoro', 'Kokoro'], ['chatterbox', 'Chatterbox'], ['moss-nano', 'MOSS Nano']]
    .filter(([id]) => voices.some(voice => providerId(voice) === id))];
  const genderChips = [['all', 'All'], ['male', 'Male'], ['female', 'Female']];
  const moreActive = voiceSheetFacets.engine !== 'all' || voiceSheetFacets.gender !== 'all';

  bar.innerHTML = `
    ${renderCurrentVoiceCard()}
    <div class="voice-sheet-search">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"/></svg>
      <input type="search" id="voice-sheet-search-input" placeholder="Search voices" autocomplete="off" aria-label="Search voices" value="${safeAttr(voiceSheetQuery)}">
    </div>
    <div class="voice-tier-row">
      <div class="voice-facets voice-tier-seg" role="group" aria-label="Voice tier">
        ${tierChips.map(([value, label]) => chip('tier', value, label, voiceSheetFacets.tier === value)).join('')}
      </div>
      <button type="button" class="voice-more-toggle ${moreActive ? 'has-active' : ''}" aria-expanded="${voiceSheetMoreOpen ? 'true' : 'false'}" data-voice-more-toggle>
        More filters${moreActive ? ' ·' : ''}
      </button>
    </div>
    ${voiceSheetMoreOpen ? `
    <div class="voice-more-filters">
      <div class="voice-facets" role="group" aria-label="Engine">
        <span class="voice-facet-label">Engine</span>
        ${engineChips.map(([value, label]) => chip('engine', value, label, voiceSheetFacets.engine === value)).join('')}
      </div>
      <div class="voice-facets" role="group" aria-label="Voice type">
        <span class="voice-facet-label">Voice</span>
        ${genderChips.map(([value, label]) => chip('gender', value, label, voiceSheetFacets.gender === value)).join('')}
      </div>
    </div>` : ''}
  `;

  bar.querySelectorAll('[data-facet-group]').forEach(el => {
    el.addEventListener('click', () => {
      voiceSheetFacets[el.dataset.facetGroup] = el.dataset.facetValue;
      saveVoiceSheetFacets();
      renderVoiceFacetChips(filterBarId);
      renderVoiceSheetSections(listId);
    });
  });
  bar.querySelector('[data-voice-more-toggle]')?.addEventListener('click', () => {
    voiceSheetMoreOpen = !voiceSheetMoreOpen;
    renderVoiceFacetChips(filterBarId);
  });
  const searchInput = bar.querySelector('#voice-sheet-search-input');
  // Only the list re-renders on keystrokes, so the input keeps focus.
  searchInput?.addEventListener('input', () => {
    voiceSheetQuery = searchInput.value;
    renderVoiceSheetSections(listId);
  });
}

// Pinned book narrator at the top of the sheet: what's selected,
// whether it's ready, and a preview button — no select affordance needed.
function renderCurrentVoiceCard() {
  const voice = voices.find(v => v.id === currentVoice);
  const unavailableNotice = unavailableCurrent
    ? `<p class="settings-hint" role="status">${escapeHTML(unavailableVoiceMessage())}</p>` : '';
  if (!voice) return unavailableNotice;
  const cache = voiceCache[currentVoice];
  const readiness = getVoiceCacheLabel(cache) || (voiceIsPremium(voice)
    ? (voice.pairedInstantVoice ? 'Prepares in the background' : 'Prepare before listening') : 'Ready when you play');
  const playing = deps.getChunkPlayer?.()?.isPlaying && deps.getActualVoice?.() === currentVoice;
  return `
    ${unavailableNotice}
    <div class="voice-card voice-card--current" aria-label="Selected narrator for this book">
      <div class="voice-card-info">
        <div class="voice-card-name-row">
          <div class="voice-card-name">${escapeHTML(voice.name)} ${voicePill(voice)}</div>
        </div>
        <div class="voice-card-meta">${escapeHTML(readiness)}${playing ? ' · playing' : ''}</div>
      </div>
      <button class="voice-play-btn" data-voice-action="preview" data-sample-voice-id="${safeAttr(voice.id)}" aria-label="Preview ${safeAttr(voice.name)}">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px">
          <path fill-rule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clip-rule="evenodd" />
        </svg>
      </button>
    </div>
  `;
}

function voicePill(voice) {
  if (voice.custom) return '<span class="voice-pill voice-pill--cloned">Cloned</span>';
  if (voiceIsPremium(voice)) return '<span class="voice-pill voice-pill--premium">Premium</span>';
  return '';
}

async function loadBookNarration() {
  const bookId = deps.getCurrentBook()?.id;
  const generation = ++narrationLoadGeneration;
  if (bookNarration?.bookId !== bookId) {
    stopHighQualityPrepPolling();
    premiumBookStatus = null;
    premiumChapterReadiness = [];
    preparationStale = false;
    bookNarration = null;
  }
  if (!bookId) { currentVoice = defaultVoice; return; }
  const preference = await apiGet(`/api/narration/${encodeURIComponent(bookId)}`);
  if (generation !== narrationLoadGeneration || deps.getCurrentBook()?.id !== bookId) return;
  if (currentVoice !== preference.voiceId) {
    stopHighQualityPrepPolling();
    premiumBookStatus = null;
    premiumChapterReadiness = [];
  }
  bookNarration = preference;
  currentVoice = preference.voiceId;
}

export async function loadVoices() {
  try {
    const [data] = await Promise.all([apiGet('/api/voices'), loadEngineStatus()]);
    voices = data.voices;
    defaultVoice = data.current;
    unavailableCurrent = data.unavailableCurrent || null;
    await loadBookNarration();
    await loadVoiceCacheStatus();
    renderVoices();
    updatePlayerVoiceStatus();
  } catch {
    const html = `<div class="empty-state-modern"><h3>Couldn't load narrators</h3>
      <p>Check your connection and try again.</p><button class="btn-primary" data-retry-voices>Retry</button></div>`;
    document.querySelectorAll('#voice-list, #player-voice-list').forEach(list => {
      list.innerHTML = html;
      list.querySelector('[data-retry-voices]')?.addEventListener('click', () => loadVoices());
    });
  }
}

let engineStatusTimer = null;
async function loadEngineStatus(refresh = false) {
  try {
    engineStatus = await apiGet(`/api/engines/status${refresh ? '?refresh=1' : ''}`);
  } catch {
    engineStatus = null;
  }
}

function refreshStartingEngine() {
  clearTimeout(engineStatusTimer);
  if (!voices.some(v => providerId(v) === 'moss-nano') || engineStatus?.engines?.['moss-nano']?.up) return;
  engineStatusTimer = setTimeout(async () => {
    const visible = [...document.querySelectorAll('#voice-list, #player-voice-list')].some(list => list.offsetParent !== null);
    if (!visible || document.hidden) return;
    const previous = JSON.stringify(engineStatus);
    await loadEngineStatus(true);
    if (JSON.stringify(engineStatus) !== previous) {
      // Update cards without replacing the focused search/filter controls.
      renderVoiceSurface('voice-filter-bar', 'voice-list', false);
      renderVoiceSheetSections('player-voice-list');
      updatePlayerVoiceStatus();
    }
    refreshStartingEngine();
  }, 5000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshStartingEngine();
});

function getVoiceName(voiceId) {
  const voice = voices.find(v => v.id === voiceId);
  return voice?.name || (bookNarration?.voiceId === voiceId ? bookNarration.voiceName : null) || voiceId;
}

function unavailableVoiceMessage() {
  if (!unavailableCurrent) return '';
  const reason = unavailableCurrent.status === 'disabled' ? 'disabled' : 'unavailable';
  return `${unavailableCurrent.name} is ${reason}. ` + (unavailableCurrent.fallback
    ? `Using ${getVoiceName(unavailableCurrent.fallback)} until it is available.` : 'Choose another voice to listen.');
}

async function loadVoiceCacheStatus() {
  const bookId = deps.getCurrentBook()?.id;
  const chapterIndex = deps.getCurrentChapter();
  if (!bookId || !deps.getChapters()[chapterIndex]) { voiceCache = {}; return; }
  try {
    const data = await apiGet(`/api/voice-cache/${encodeURIComponent(bookId)}/${chapterIndex}`);
    if (deps.getCurrentBook()?.id !== bookId || deps.getCurrentChapter() !== chapterIndex) return;
    voiceCache = Object.fromEntries((data.voices || []).map(item => [item.voiceId, item]));
  } catch { /* Preparation status communicates a stale connection. */ }
}

function renderVoices() {
  const summary = document.getElementById('settings-voice-summary');
  if (summary) summary.textContent = getVoiceName(defaultVoice);
  const hint = document.getElementById('settings-voice-hint');
  if (hint) hint.textContent = 'Choose the default narrator. Books with their own narrator keep that choice.';
  renderVoiceSurface('voice-filter-bar', 'voice-list');
  renderVoiceSurface('player-voice-filter-bar', 'player-voice-list');
  refreshStartingEngine();
}

function renderVoiceSurface(filterBarId, listId, refreshFilters = true) {
  const voiceList = document.getElementById(listId);
  if (!voiceList) return;

  // Player sheet has its own surface: pinned current voice + search +
  // tier segmented control, sections below.
  if (filterBarId === 'player-voice-filter-bar') {
    renderVoiceFacetChips(filterBarId);
    renderVoiceSheetSections(listId);
    return;
  }

  if (refreshFilters) renderVoiceFilters(filterBarId);
  const filteredVoices = filterVoices(voices).filter(v => v.id !== defaultVoice);
  const savedVoices = filteredVoices.filter(v => savedVoiceIds.includes(v.id));
  const savedSet = new Set(savedVoices.map(v => v.id));
  const topVoices = filteredVoices.filter(v => !savedSet.has(v.id) && (v.top || v.custom));
  const shownSet = new Set([...savedVoices, ...topVoices].map(v => v.id));
  const otherVoices = filteredVoices.filter(v => !shownSet.has(v.id));
  const current = voices.find(v => v.id === defaultVoice);
  const voiceSections = current ? [renderVoiceSection('Default narrator', [current], defaultVoice)] : [];

  if (savedVoices.length > 0) {
    voiceSections.push(renderVoiceSection('My voices', savedVoices, defaultVoice));
  }

  if (topVoices.length > 0) {
    voiceSections.push(renderVoiceSection('Top voices', topVoices, defaultVoice));
  }

  if (otherVoices.length > 0) {
    voiceSections.push(renderVoiceSection('All voices', otherVoices, defaultVoice));
  }

  if (filteredVoices.length === 0) {
    voiceSections.push('<p class="voice-empty">No other voices match those filters.</p>');
  }

  voiceList.innerHTML = [...voiceSections, renderCloneVoicePanel()].join('');
}

// Player-sheet list: My voices / Recommended / Explore (or flat search
// results). The current voice is pinned in the controls area, not listed.
function renderVoiceSheetSections(listId) {
  const voiceList = document.getElementById(listId);
  if (!voiceList) return;

  const query = voiceSheetQuery.trim();
  const filtered = filterVoicesForSheet(voices).filter(v => v.id !== currentVoice);
  const sections = [];

  if (query) {
    if (filtered.length > 0) {
      sections.push(renderVoiceSection(`Results (${filtered.length})`, filtered));
    } else {
      sections.push('<div class="voice-empty">No voices match your search.</div>');
    }
  } else {
    const savedVoices = filtered.filter(v => savedVoiceIds.includes(v.id));
    const savedSet = new Set(savedVoices.map(v => v.id));
    const recommended = filtered.filter(v => !savedSet.has(v.id) && (v.top || v.custom));
    const shownSet = new Set([...savedVoices, ...recommended].map(v => v.id));
    const explore = filtered.filter(v => !shownSet.has(v.id));

    if (savedVoices.length > 0) sections.push(renderVoiceSection('My voices', savedVoices));
    if (recommended.length > 0) sections.push(renderVoiceSection('Recommended', recommended));
    if (explore.length > 0) sections.push(renderVoiceSection('Explore', explore));
    if (sections.length === 0) {
      sections.push('<div class="voice-empty">No voices match these filters. <button type="button" class="voice-clear-filters" data-voice-action="clear-filters">Clear filters</button></div>');
    }
  }

  // Picking a voice is the sheet's primary job: the clone CTA trails, and
  // hides when the user is explicitly browsing instant-only voices.
  const showClone = voiceSheetFacets.tier !== 'instant' &&
    (voiceSheetFacets.engine === 'all' || voiceSheetFacets.engine === 'chatterbox');
  voiceList.innerHTML = (showClone ? [...sections, renderCloneVoicePanel()] : sections).join('');
}

function renderCloneVoicePanel() {
  // No Chatterbox voices in this instance's catalog means the provider is
  // disabled here (XANDRIO_VOICE_PROVIDERS) — hide cloning entirely.
  if (!voices.some(v => String(v.provider).toLowerCase() === 'chatterbox')) return '';
  const chatterbox = engineStatus?.engines?.chatterbox;
  const engineDown = Boolean(chatterbox && !chatterbox.up && chatterbox.status !== 'starting');
  // First run (no cloned voices yet): lead with an inviting CTA so voice
  // cloning is discoverable. Once the user has custom voices, fall back to
  // the compact "Add your voice" form. Same <form> markup either way, so the
  // existing submit handler stays wired.
  const hasCustomVoices = voices.some(v => v.custom);
  const heading = hasCustomVoices ? 'Add your voice' : 'Clone a voice';
  const subcopy = hasCustomVoices
    ? '10-30 s of clean, single-speaker audio'
    : 'Narrate any book in a voice you love — upload a 10-30 s sample and it becomes a narrator.';
  return `
    <details class="voice-section voice-create">
      <summary>Create voice</summary>
      <form class="clone-voice-form${hasCustomVoices ? '' : ' clone-voice-form--cta'}">
        <div class="clone-voice-copy">
          ${hasCustomVoices ? '' : '<span class="clone-voice-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v18M8.5 7.5A3.5 3.5 0 0 1 12 4a3.5 3.5 0 0 1 3.5 3.5v5A3.5 3.5 0 0 1 12 16a3.5 3.5 0 0 1-3.5-3.5v-5Z"/><path stroke-linecap="round" d="M5.5 12.5A6.5 6.5 0 0 0 12 19a6.5 6.5 0 0 0 6.5-6.5"/></svg><span>Voice cloning</span></span>'}
          <strong>${heading}</strong>
          <span>${subcopy}</span>
          ${engineDown ? '<span class="clone-voice-offline">Local engine offline. Uploads still save; narration resumes when it is back.</span>' : ''}
        </div>
        <input type="text" name="name" maxlength="40" placeholder="voice-name" autocomplete="off" aria-label="Custom voice name" />
        <input type="file" name="audio" accept="audio/*" aria-label="Voice reference audio" />
        <label class="clone-voice-authority">
          <input type="checkbox" name="authorityConfirmed" value="true" required />
          <span>I have authority and any required consent to use this voice reference.</span>
        </label>
        <div class="clone-voice-actions">
          <button type="submit" class="btn-primary btn-sm">${hasCustomVoices ? 'Upload' : 'Upload a sample'}</button>
          <span class="clone-voice-status" aria-live="polite"></span>
        </div>
      </form>
    </details>
  `;
}

function filterVoices(list) {
  return list.filter(voice =>
    matchesVoiceFilter(providerId(voice), voiceFilters.provider) &&
    matchesVoiceFilter(voice.gender, voiceFilters.gender) &&
    matchesVoiceFilter(voice.accent, voiceFilters.accent) &&
    matchesVoiceFilter(voice.depth, voiceFilters.depth)
  );
}

function matchesVoiceFilter(value, filter) {
  return filter === 'all' || String(value || '').toLowerCase() === filter;
}

function renderVoiceFilters(filterBarId = 'voice-filter-bar') {
  const filterBar = document.getElementById(filterBarId);
  if (!filterBar) return;

  const groups = [
    { key: 'gender', label: 'Voice', values: getVoiceFilterValues('gender', ['male', 'female']) },
    { key: 'accent', label: 'Accent', values: getVoiceFilterValues('accent', ['us', 'uk']) },
    { key: 'depth', label: 'Tone', values: getVoiceFilterValues('depth', ['warm', 'clear', 'deep', 'expressive', 'lively', 'classic']) },
    { key: 'provider', label: 'Source', values: getVoiceFilterValues('provider', ['chatterbox', 'moss-nano', 'kokoro', 'edge']) }
  ];

  normalizeVoiceFilters(groups);

  filterBar.innerHTML = groups.map(group => `
    <label class="voice-filter">
      <span>${escapeHTML(group.label)}</span>
      <select data-voice-filter="${safeAttr(group.key)}" aria-label="${safeAttr(group.label)} filter">
        ${group.values.map(value => `
          <option value="${safeAttr(value)}" ${voiceFilters[group.key] === value ? 'selected' : ''}>${escapeHTML(formatVoiceFilterLabel(value))}</option>
        `).join('')}
      </select>
    </label>
  `).join('');

  filterBar.querySelectorAll('[data-voice-filter]').forEach(select => {
    select.addEventListener('change', () => {
      voiceFilters[select.dataset.voiceFilter] = select.value;
      renderVoices();
    });
  });
}

function getVoiceFilterValues(key, preferredOrder = []) {
  const values = new Set(
    voices
      .filter(voice => voiceMatchesOtherFilters(voice, key))
      .map(voice => String(voiceFilterValue(voice, key) || '').toLowerCase())
      .filter(Boolean)
  );
  const preferred = preferredOrder.filter(value => values.has(value));
  const rest = Array.from(values).filter(value => !preferred.includes(value)).sort();
  return ['all', ...preferred, ...rest];
}

function voiceMatchesOtherFilters(voice, ignoredKey) {
  return Object.entries(voiceFilters).every(([key, value]) =>
    key === ignoredKey || matchesVoiceFilter(voiceFilterValue(voice, key), value)
  );
}

function normalizeVoiceFilters(groups) {
  groups.forEach(group => {
    if (!group.values.includes(voiceFilters[group.key])) {
      voiceFilters[group.key] = 'all';
      group.values = getVoiceFilterValues(group.key);
    }
  });
}

function formatVoiceFilterLabel(value) {
  if (value === 'all') return 'All';
  if (value === 'us' || value === 'uk') return value.toUpperCase();
  if (value === 'chatterbox') return 'Chatterbox';
  if (value === 'moss-nano') return 'MOSS Nano';
  if (value === 'kokoro') return 'Local';
  if (value === 'edge') return 'Cloud';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function loadSavedVoiceIds() {
  const ids = readJSON(SAVED_VOICES_KEY, []);
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
}

function saveSavedVoiceIds() {
  const knownIds = new Set(voices.map(voice => voice.id));
  savedVoiceIds = savedVoiceIds.filter((id, index, list) =>
    knownIds.has(id) && list.indexOf(id) === index
  );
  writeJSON(SAVED_VOICES_KEY, savedVoiceIds);
}

function toggleSavedVoice(voiceId) {
  const voice = voices.find(v => v.id === voiceId);
  if (!voice) return;
  if (savedVoiceIds.includes(voiceId)) {
    savedVoiceIds = savedVoiceIds.filter(id => id !== voiceId);
    saveSavedVoiceIds();
    showToast(`${voice.name} removed from My voices`);
  } else {
    savedVoiceIds = [voiceId, ...savedVoiceIds].slice(0, 24);
    saveSavedVoiceIds();
    showToast(`${voice.name} saved to My voices`);
  }
  renderVoices();
}

function getVoiceCacheLabel(cache, compact = false) {
  if (!cache) return '';
  if (cache.status === 'ready') return 'Ready now';
  if (cache.status === 'partial') return `${cache.readyChunks}/${cache.totalChunks} ready`;
  return 'Generates on play';
}

function getVoiceCacheClass(cache) {
  if (!cache) return 'unknown';
  if (cache.status === 'ready') return 'ready';
  if (cache.status === 'partial') return 'partial';
  return 'uncached';
}

function updatePlayerVoiceStatus() {
  if (!playerVoiceName || !playerVoiceCache) return;
  const actualVoice = deps.getActualVoice?.();
  const chosenName = getVoiceName(currentVoice) || 'Choose narrator';
  const actualName = actualVoice ? getVoiceName(actualVoice) : chosenName;
  const differs = actualVoice && actualVoice !== currentVoice;
  const actualLabel = deps.getChunkPlayer()?.isPlaying ? 'Playing now' : 'Audio narrator';
  playerVoiceName.textContent = actualName;
  playerVoiceCache.textContent = differs
    ? `${actualLabel} · ${chosenName} selected for this book`
    : bookNarration?.inherited ? 'Library default · Change for this book' : 'Narrator for this book';
  playerVoiceStatus.dataset.cache = getVoiceCacheClass(voiceCache[actualVoice || currentVoice]);
  updateHighQualityPrepPanel();
}

function isHighQualityVoice(voiceId = currentVoice) {
  const voice = voices.find(v => v.id === voiceId);
  return voiceIsPremium(voice) || (bookNarration?.voiceId === voiceId && bookNarration.premiumActive === true);
}

function stopHighQualityPrepPolling() {
  // Bump the generation so a tick whose await is still in flight won't
  // reschedule after we stop (its timer handle is null at that point, so
  // clearTimeout alone can't cancel it).
  hqVoicePrepGeneration++;
  hqVoicePrepPolling = false;
  if (hqVoicePrepTimer) {
    clearTimeout(hqVoicePrepTimer);
    hqVoicePrepTimer = null;
  }
}

function listeningTime(seconds) {
  if (seconds <= 0) return 'No audio ready from here';
  if (seconds < 60) return 'Under 1 minute ready from here';
  return `${Math.floor(seconds / 60)} minutes ready from here`;
}

function updateHighQualityPrepPanel() {
  if (!hqVoicePrep) return;
  const visible = Boolean(deps.getCurrentBook() && deps.getChapters()[deps.getCurrentChapter()] && isHighQualityVoice());
  hqVoicePrep.hidden = !visible;
  if (!visible) { stopHighQualityPrepPolling(); return; }
  startHighQualityPrepPolling();
  const status = premiumBookStatus;
  const name = getVoiceName(currentVoice);
  const state = status?.status || 'loading';
  const total = Number(status?.totalChapters) || 0;
  const ready = Number(status?.readyChapters) || 0;
  const speed = Number(deps.getChunkPlayer()?.playbackRate) || 1;
  const position = deps.getChunkPlayer()?.getPosition?.();
  const samePosition = status?.chapterIndex === deps.getCurrentChapter();
  const moved = samePosition ? Math.max(0, Number(position?.currentTime) || 0) - status.offsetSeconds : 0;
  const seconds = samePosition ? Math.max(0, status.readyAudioSeconds - moved) / speed : 0;
  hqVoicePrep.dataset.state = state;
  hqVoicePrepTitle.textContent = status
    ? `${name} · ${status.durationEstimated ? 'About ' : ''}${listeningTime(seconds)}`
    : 'Checking preparation…';
  const labels = {
    loading: 'Checking audio for this book.',
    disabled: 'Background preparation is off in Settings.',
    userPaused: 'Preparation paused. Saved audio is kept.',
    paused: 'Waiting for active playback to finish. Preparation resumes automatically.',
    engineOffline: 'Narration service offline. Preparation resumes when it returns.',
    generating: 'Preparing this book in the background.',
    error: 'Preparation stopped. Retry to continue from saved audio.',
    ready: 'The full book is prepared.',
    idle: status?.enabled === false ? 'Background preparation is off in Settings.' : 'Prepare this book before listening.'
  };
  let detail = labels[state] || labels.idle;
  if (status && status.firstUnreadyChapter !== null && state !== 'loading') {
    detail += ` Chapter ${status.firstUnreadyChapter + 1} is next to prepare.`;
  }
  if (preparationStale) detail = `Reconnecting… Last checked: ${detail}`;
  hqVoicePrepDetail.textContent = detail;
  hqVoicePrepFill.style.width = `${total ? Math.round(ready / total * 100) : 0}%`;
  hqVoicePrepCount.textContent = status ? `${ready} of ${total} chapters · listening time at ${speed}×` : '';
  const canPause = ['generating', 'paused', 'engineOffline'].includes(state);
  hqVoicePrepBtn.disabled = state === 'loading' || state === 'ready' || status?.enabled === false || voiceSelectionPending;
  hqVoicePrepBtn.textContent = canPause ? 'Pause' : state === 'userPaused' ? 'Resume' : state === 'error' ? 'Retry' : state === 'ready' ? 'Prepared' : 'Prepare book';
  hqVoicePrepBtn.dataset.action = canPause ? 'pause' : state === 'userPaused' ? 'resume' : 'start';
  const fallback = document.getElementById('narration-fallback');
  const fallbackLabel = document.getElementById('narration-fallback-label');
  if (fallback) {
    fallback.hidden = !status?.instantVoice;
    if (fallbackLabel) fallbackLabel.hidden = !status?.instantVoice;
    fallback.disabled = !status || voiceSelectionPending;
    fallback.options[0].textContent = `Wait for ${name}`;
    fallback.options[1].textContent = `Use ${getVoiceName(status?.instantVoice)}`;
    fallback.value = bookNarration?.fallbackPolicy || 'wait';
  }
}

async function refreshHighQualityPrepPanel() {
  try {
    await loadBookNarration();
    await loadVoiceCacheStatus();
    renderVoices();
    updatePlayerVoiceStatus();
  } catch { preparationStale = true; updateHighQualityPrepPanel(); }
}

async function fetchHighQualityPrepStatus() {
  const book = deps.getCurrentBook();
  if (!book) return null;
  const player = deps.getChunkPlayer();
  const position = player?.getPosition?.();
  const query = new URLSearchParams({ chapterIndex: deps.getCurrentChapter() || 0,
    offsetSeconds: Math.max(0, Number(position?.currentTime) || 0), speed: Number(player?.playbackRate) || 1 });
  return apiGet(`/api/premium-prep/${encodeURIComponent(book.id)}/status?${query}`);
}

async function prepareCurrentHighQualityChapter() {
  const book = deps.getCurrentBook();
  if (!book || !isHighQualityVoice()) return;
  const action = hqVoicePrepBtn.dataset.action || 'start';
  hqVoicePrepBtn.disabled = true;
  try {
    await apiSend('POST', `/api/premium-prep/${encodeURIComponent(book.id)}/${action}`, {
      fromChapter: deps.getCurrentChapter() || 0, retry: premiumBookStatus?.status === 'error'
    });
    if (deps.getCurrentBook()?.id !== book.id) return;
    premiumBookStatus = await fetchHighQualityPrepStatus();
    preparationStale = false;
  } catch (err) { showToast(`Could not ${action} preparation: ${err.message}`, 'error'); }
  updateHighQualityPrepPanel();
}

async function changeFallbackPolicy(event) {
  const book = deps.getCurrentBook();
  if (!book || voiceSelectionPending) return;
  const value = event.target.value;
  event.target.disabled = true;
  try {
    const saved = await apiSend('POST', `/api/narration/${encodeURIComponent(book.id)}`, { fallbackPolicy: value });
    if (deps.getCurrentBook()?.id !== book.id) return;
    bookNarration = saved;
    showToast('Choice saved. It applies when audio next loads.');
  } catch (error) { showToast(`Could not save choice: ${error.message}`, 'error'); }
  updateHighQualityPrepPanel();
}

function startHighQualityPrepPolling() {
  if (hqVoicePrepPolling) return;
  hqVoicePrepPolling = true;
  const generation = hqVoicePrepGeneration;
  const tick = async () => {
    if (generation !== hqVoicePrepGeneration) return;
    hqVoicePrepTimer = null;
    const bookId = deps.getCurrentBook()?.id;
    const voiceId = currentVoice;
    if (!bookId || !isHighQualityVoice()) { stopHighQualityPrepPolling(); return; }
    try {
      const status = await fetchHighQualityPrepStatus();
      if (generation !== hqVoicePrepGeneration || deps.getCurrentBook()?.id !== bookId || currentVoice !== voiceId) return;
      premiumBookStatus = status;
      premiumChapterReadiness = Array.isArray(status?.chapters) ? status.chapters : [];
      preparationStale = false;
      const next = (deps.getCurrentChapter() || 0) + 1;
      if (deps.getServedTier?.() === 'instant' && premiumChapterReadiness[next] && !premiumToastBooks.has(bookId)) {
        premiumToastBooks.add(bookId);
        showToast(`${getVoiceName(currentVoice)} is ready for the next chapter.`);
      }
    } catch { if (generation === hqVoicePrepGeneration) preparationStale = true; }
    if (generation !== hqVoicePrepGeneration) return;
    updatePlayerVoiceStatus();
    hqVoicePrepTimer = setTimeout(tick, HIGH_QUALITY_PREP_POLL_MS);
  };
  hqVoicePrepTimer = setTimeout(tick, 0);
}

async function openVoiceSheet() {
  if (!voiceSheet) return;
  voiceSheetController?.open();
  voiceSheet.setAttribute('aria-busy', 'true');
  try { await loadVoices(); }
  finally { voiceSheet.removeAttribute('aria-busy'); }
}

export function closeVoiceSheetDirect() {
  voiceSheetController?.close();
}

function closeVoiceSheet() {
  voiceSheetController?.dismiss();
}

function renderVoiceSection(title, sectionVoices, selectedVoice = currentVoice) {
  return `
    <div class="voice-section">
      <div class="voice-section-title">${escapeHTML(title)}</div>
      ${sectionVoices.map(voice => renderVoiceCard(voice, selectedVoice)).join('')}
    </div>
  `;
}

function renderVoiceCard(v, selectedVoice = currentVoice) {
    const isActive = v.id === selectedVoice;
    const isSaved = savedVoiceIds.includes(v.id);
    const provider = providerId(v);
    const status = engineStatus?.engines?.[provider];
    const isLocalEngine = Boolean(v.local) || provider === 'kokoro' || provider === 'chatterbox';
    const isStarting = status?.status === 'starting';
    const isEngineDown = isLocalEngine && status && !status.up && !isStarting;
    // Selection is the recovery path for local engines: /api/voice starts the provider.
    const selectionDisabled = voiceSelectionPending || status?.status === 'models-uninstalled' || status?.status === 'disabled' ||
      (!isLocalEngine && status && !status.up);
    const cache = voiceCache[v.id];
    // Only surface readiness when it says something ("Ready now",
    // "12/60 ready") — "Generates on play" is the default for every voice
    // and repeating it on each row reads like an error list.
    const cacheLabel = cache && (cache.status === 'ready' || cache.status === 'partial')
      ? getVoiceCacheLabel(cache, true)
      : '';
    const cacheClass = getVoiceCacheClass(cache);
    const partialPercent = cache && cache.status === 'partial' && cache.totalChunks > 0
      ? Math.round((cache.readyChunks / cache.totalChunks) * 100)
      : null;
    const summaryTags = (v.tags && v.tags.length ? v.tags : [v.gender, v.accent, v.depth].filter(Boolean))
      .filter(tag => !['local', 'chatterbox', 'kokoro', 'edge'].includes(String(tag).toLowerCase())).slice(0, 3);
    const tagSummary = summaryTags.map(t => escapeHTML(t)).join(' · ');
    const availability = status?.status === 'models-uninstalled' ? 'Voice model not installed'
      : isEngineDown ? (provider === 'moss-nano' ? 'Narration service offline' : 'Starts when selected')
      : isStarting ? 'Narration service starting'
      : provider === 'moss-nano' ? `MOSS Nano · ${tagSummary}` : tagSummary;
    const checkIcon = isActive
      ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="voice-card-check" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>'
      : '';

    return `
      <div class="voice-card ${isActive ? 'active' : ''} ${selectionDisabled ? 'voice-card--offline' : ''} ${isEngineDown ? 'voice-card--engine-down' : ''}" data-voice-id="${safeAttr(v.id)}" data-offline="${selectionDisabled ? '1' : '0'}">
        <button class="voice-save-btn ${isSaved ? 'saved' : ''}" data-voice-action="save" data-save-voice-id="${safeAttr(v.id)}" aria-label="${isSaved ? 'Remove' : 'Save'} ${safeAttr(v.name)} ${isSaved ? 'from' : 'to'} My voices" aria-pressed="${isSaved ? 'true' : 'false'}">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${isSaved ? 'fill="currentColor"' : 'fill="none"'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
            <path d="M11.48 3.5a.6.6 0 011.04 0l2.35 4.76a.6.6 0 00.45.33l5.25.76a.6.6 0 01.33 1.02l-3.8 3.7a.6.6 0 00-.17.53l.9 5.22a.6.6 0 01-.87.63l-4.7-2.47a.6.6 0 00-.56 0L7 20.45a.6.6 0 01-.87-.63l.9-5.22a.6.6 0 00-.17-.53l-3.8-3.7a.6.6 0 01.33-1.02l5.25-.76a.6.6 0 00.45-.33l2.35-4.76z" />
          </svg>
        </button>
        <button type="button" class="voice-card-info voice-select-btn" data-voice-action="select" aria-label="Use ${safeAttr(v.name)}" aria-pressed="${isActive ? 'true' : 'false'}" ${selectionDisabled ? 'disabled' : ''}>
          <span class="voice-card-name-row">
            <span class="voice-card-name">${checkIcon}${escapeHTML(v.name)} ${voicePill(v)}</span>
            <span class="voice-readiness ${cacheClass}">${escapeHTML(cacheLabel)}</span>
          </span>
          <span class="voice-card-meta" title="${safeAttr(v.provider || '')}">${availability}</span>
          ${partialPercent !== null ? `<span class="voice-progress" aria-hidden="true"><span style="width:${partialPercent}%"></span></span>` : ''}
        </button>
        ${v.custom ? `<button class="voice-delete-btn" data-voice-action="delete" data-delete-voice-id="${safeAttr(v.id)}" aria-label="Delete ${safeAttr(v.name)}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:16px;height:16px"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>` : ''}
        ${isEngineDown || selectionDisabled ? '' : `<button class="voice-play-btn" data-voice-action="preview" data-sample-voice-id="${safeAttr(v.id)}" aria-label="Preview ${safeAttr(v.name)}">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px">
            <path fill-rule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clip-rule="evenodd" />
          </svg>
        </button>`}
      </div>
    `;
}

async function selectVoice(voiceId, scope = 'book') {
  if (voiceSelectionPending) return;
  const book = deps.getCurrentBook();
  const forBook = scope === 'book' && Boolean(book);
  const previousVoice = currentVoice;
  const shouldSwitchPlayback = book && deps.getChunkPlayer() && previousVoice !== voiceId && (forBook || bookNarration?.inherited);
  const position = shouldSwitchPlayback ? deps.getChunkPlayer().getPosition() : null;
  const wasPlaying = shouldSwitchPlayback ? deps.getChunkPlayer().isPlaying : false;
  voiceSelectionPending = true;
  renderVoices();
  updateHighQualityPrepPanel();
  try {
    if (forBook) {
      const saved = await apiSend('POST', `/api/narration/${encodeURIComponent(book.id)}`, { voiceId });
      if (deps.getCurrentBook()?.id !== book.id) return;
      bookNarration = saved;
      currentVoice = saved.voiceId;
    } else {
      await apiSend('POST', '/api/voice', { voiceId });
      defaultVoice = voiceId;
      if (!book || bookNarration?.inherited) currentVoice = voiceId;
    }
    stopHighQualityPrepPolling();
    premiumBookStatus = null;
    premiumChapterReadiness = [];
    unavailableCurrent = null;
    updatePlayerVoiceStatus();
    if (forBook) closeVoiceSheet();
    if (shouldSwitchPlayback && deps.getCurrentBook()?.id === book.id) {
      await switchCurrentChapterToVoice(voiceId, position, wasPlaying);
    }
  } catch (err) {
    deps.hideAudioLoading();
    showToast(`Narrator change failed: ${err.message}`, 'error', { actionLabel: 'Retry', onAction: () => selectVoice(voiceId, scope) });
  } finally {
    voiceSelectionPending = false;
    renderVoices();
    updatePlayerVoiceStatus();
  }
}

function handleVoiceListClick(e) {
  const saveBtn = e.target.closest('.voice-save-btn[data-save-voice-id]');
  if (saveBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleSavedVoice(saveBtn.dataset.saveVoiceId);
    return;
  }

  const previewBtn = e.target.closest('.voice-play-btn[data-sample-voice-id]');
  if (previewBtn) {
    e.preventDefault();
    e.stopPropagation();
    playSample(previewBtn.dataset.sampleVoiceId, previewBtn);
    return;
  }

  const clearBtn = e.target.closest('[data-voice-action="clear-filters"]');
  if (clearBtn) {
    e.preventDefault();
    voiceSheetFacets = { tier: 'all', engine: 'all', gender: 'all' };
    voiceSheetQuery = '';
    saveVoiceSheetFacets();
    renderVoiceFacetChips('player-voice-filter-bar');
    renderVoiceSheetSections('player-voice-list');
    return;
  }

  const deleteBtn = e.target.closest('.voice-delete-btn[data-delete-voice-id]');
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    deleteCustomVoice(deleteBtn.dataset.deleteVoiceId);
    return;
  }

  const voiceCard = e.target.closest('.voice-card[data-voice-id]');
  if (!voiceCard || !e.currentTarget.contains(voiceCard)) return;
  if (!e.target.closest('[data-voice-action="select"]')) return;
  if (voiceCard.dataset.offline === '1') return;
  selectVoice(voiceCard.dataset.voiceId, e.currentTarget.id === 'voice-list' ? 'default' : 'book');
}

async function deleteCustomVoice(voiceId) {
  const voice = voices.find(item => item.id === voiceId);
  if (!voice?.custom) return;
  const ok = await confirmSheet({
    title: 'Delete voice',
    message: `Delete "${voice.name}"? This cannot be undone.`,
    confirmLabel: 'Delete'
  });
  if (!ok) return;
  try {
    await apiSend('DELETE', `/api/voices/clone/${encodeURIComponent(voice.id.replace(/^chatterbox:/, ''))}`);
    savedVoiceIds = savedVoiceIds.filter(id => id !== voice.id);
    saveSavedVoiceIds();
    await loadVoices();
    showToast('Custom voice deleted');
  } catch (err) {
    showToast(err.message || 'Could not delete custom voice', 'error');
  }
}

async function handleCloneVoiceSubmit(e) {
  const form = e.target.closest('.clone-voice-form');
  if (!form) return;
  e.preventDefault();
  const status = form.querySelector('.clone-voice-status');
  const button = form.querySelector('button[type="submit"]');
  const name = form.elements.name?.value.trim();
  const file = form.elements.audio?.files?.[0];
  const authorityConfirmed = Boolean(form.elements.authorityConfirmed?.checked);
  if (!name || !file || !authorityConfirmed) {
    if (status) status.textContent = authorityConfirmed
      ? 'Name and audio required'
      : 'Confirm authority and consent';
    return;
  }
  const body = new FormData();
  body.append('name', name);
  body.append('audio', file);
  body.append('authorityConfirmed', 'true');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Uploading...';
  try {
    await apiSend('POST', '/api/voices/clone', body, { headers: {} });
    if (status) status.textContent = 'Added';
    form.reset();
    await loadVoices();
    showToast('Custom voice added');
  } catch (err) {
    if (status) status.textContent = err.message || 'Upload failed';
    showToast(err.message || 'Upload failed', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

let voiceSwitchToken = 0;

async function switchCurrentChapterToVoice(voiceId, position, wasPlaying) {
  // Latest-wins: picking another voice (or chapter) mid-switch abandons
  // this run instead of letting two polling loops fight over the player.
  const token = ++voiceSwitchToken;
  const chapterAtStart = deps.getCurrentChapter();
  const bookAtStart = deps.getCurrentBook()?.id;
  const isStale = () =>
    token !== voiceSwitchToken ||
    deps.getCurrentChapter() !== chapterAtStart ||
    deps.getCurrentBook()?.id !== bookAtStart;

  const voiceName = getVoiceName(voiceId);
  const targetChunk = Math.max(0, position?.chunk || 0);
  const seekTo = Math.max(0, position?.totalEstimatedTime || 0);

  deps.showAudioLoading(`Switching to ${voiceName}. Preparing this chapter in the new voice.`, {
    detail: 'Preparing the selected voice for this chapter.',
    percent: 0,
    status: 'generating'
  });

  let targetReady = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const data = await apiSend('POST', `/api/chunks/${encodeURIComponent(bookAtStart)}/${chapterAtStart}/prepare`, { targetChunk });
    if (isStale()) return;
    const ready = data.readyChunks ?? 0;
    const total = data.totalChunks ?? 0;
    const cache = total > 0 ? `Chapter cache: ${ready}/${total} ready.` : 'Preparing chapter cache.';
    const voiceStatus = data.targetStatus === 'ready' ? 'Ready to play' : 'Preparing audio';
    deps.showAudioLoading(`Switching to ${voiceName}. Preparing this chapter in the new voice.`, {
      detail: `${voiceStatus}. ${cache}`,
      percent: total > 0 ? Math.round((ready / total) * 100) : 0,
      status: data.targetStatus === 'ready' ? 'ready' : 'generating'
    });

    if (data.targetStatus === 'ready') {
      targetReady = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (isStale()) return;
  }

  if (!targetReady) {
    throw new Error(`Timed out preparing ${voiceName}`);
  }

  const stillPlaying = deps.getChunkPlayer().isPlaying;
  await deps.getChunkPlayer().loadChapter(bookAtStart, chapterAtStart);
  if (isStale()) return;
  if (seekTo) {
    await deps.getChunkPlayer().seek(seekTo);
    if (isStale()) return;
  }
  if (wasPlaying || stillPlaying) {
    await deps.getChunkPlayer().play();
    deps.updatePlaybackUI(true);
  } else {
    deps.updatePlaybackUI(false);
  }
  deps.checkpointPlayback();
  await loadVoiceCacheStatus();
  renderVoices();
  updatePlayerVoiceStatus();
}

function playSample(voiceId, btn) {
  if (sampleAudio && btn.classList.contains('playing')) {
    stopSample();
    return;
  }

  stopSample();
  btn.classList.add('playing');
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px"><path fill-rule="evenodd" d="M4.5 7.5a3 3 0 013-3h9a3 3 0 013 3v9a3 3 0 01-3 3h-9a3 3 0 01-3-3v-9z" clip-rule="evenodd" /></svg>';

  // Duck (rather than pause) main playback during a sample preview so
  // resuming doesn't require the user to hit play again.
  if (deps.getChunkPlayer() && deps.getChunkPlayer().isPlaying && typeof deps.getChunkPlayer().setVolume === 'function') {
    preSampleVolume = typeof deps.getChunkPlayer().getVolume === 'function' ? deps.getChunkPlayer().getVolume() : 1;
    deps.getChunkPlayer().setVolume(Math.min(preSampleVolume, 0.15));
  }

  const audio = new Audio(`${API_BASE}/api/voice-sample/${encodeURIComponent(voiceId)}`);
  sampleAudio = audio;
  audio.play().catch(err => {
    if (sampleAudio !== audio) return;
    console.warn('Voice preview failed:', err);
    stopSample();
    showToast('Voice preview failed', 'error');
  });
  audio.addEventListener('ended', () => {
    if (sampleAudio === audio) stopSample();
  });
  audio.addEventListener('error', () => {
    if (sampleAudio !== audio) return;
    stopSample();
    showToast('Voice preview failed', 'error');
  });
}

export function stopVoiceSample() {
  if (sampleAudio) {
    sampleAudio.pause();
    sampleAudio.src = '';
    sampleAudio = null;
  }
  if (preSampleVolume !== null && deps.getChunkPlayer() && typeof deps.getChunkPlayer().setVolume === 'function') {
    deps.getChunkPlayer().setVolume(preSampleVolume);
    preSampleVolume = null;
  }
  document.querySelectorAll('.voice-play-btn.playing').forEach(btn => {
    btn.classList.remove('playing');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px"><path fill-rule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clip-rule="evenodd" /></svg>';
  });
}
function stopSample() {
  stopVoiceSample();
}

export function refreshVoicePrepPanel() {
  return refreshHighQualityPrepPanel();
}

export function initVoices(options = {}) {
  deps = options;
  playerVoiceStatus = document.getElementById('player-voice-status');
  playerVoiceName = document.getElementById('player-voice-name');
  playerVoiceCache = document.getElementById('player-voice-cache');
  voiceSheet = document.getElementById('voice-sheet');
  voiceSheetBackdrop = document.getElementById('voice-sheet-backdrop');
  voiceSheetClose = document.getElementById('voice-sheet-close');
  hqVoicePrep = document.getElementById('hq-voice-prep');
  hqVoicePrepBtn = document.getElementById('hq-voice-prep-btn');
  hqVoicePrepTitle = document.getElementById('hq-voice-prep-title');
  hqVoicePrepDetail = document.getElementById('hq-voice-prep-detail');
  hqVoicePrepFill = document.getElementById('hq-voice-prep-fill');
  hqVoicePrepCount = document.getElementById('hq-voice-prep-count');
  voiceSheetController = registerSheet(voiceSheet, {
    onOpen: () => {},
    onClose: () => stopSample(),
    backdrop: voiceSheetBackdrop,
    closeBtn: voiceSheetClose,
    focusTarget: () => voiceSheet?.querySelector('.voice-sheet-panel') || voiceSheet
  });

  savedVoiceIds = loadSavedVoiceIds();
  voiceSheetFacets = loadVoiceSheetFacets();

  document.getElementById('voice-list')?.addEventListener('click', handleVoiceListClick);
  document.getElementById('player-voice-list')?.addEventListener('click', handleVoiceListClick);
  // Pinned current-voice card (preview button) lives in the filter bar.
  document.getElementById('player-voice-filter-bar')?.addEventListener('click', handleVoiceListClick);
  document.getElementById('voice-list')?.addEventListener('submit', handleCloneVoiceSubmit);
  document.getElementById('player-voice-list')?.addEventListener('submit', handleCloneVoiceSubmit);
  document.getElementById('hq-voice-prep-btn')?.addEventListener('click', prepareCurrentHighQualityChapter);
  document.getElementById('narration-fallback')?.addEventListener('change', changeFallbackPolicy);
  document.getElementById('voice-btn')?.addEventListener('click', openVoiceSheet);
  playerVoiceStatus?.addEventListener('click', openVoiceSheet);
}
