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
let hqVoicePrepHideTimer = null;
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
      engine: ['all', 'edge', 'kokoro', 'chatterbox'].includes(saved.engine) ? saved.engine : 'all',
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
  return String(voice?.provider || '').toLowerCase() === 'chatterbox' ||
    String(voice?.id || '').startsWith('chatterbox:');
}

function filterVoicesForSheet(list) {
  const query = voiceSheetQuery.trim().toLowerCase();
  return list.filter(voice => {
    if (voiceSheetFacets.tier === 'premium' && !voiceIsPremium(voice)) return false;
    if (voiceSheetFacets.tier === 'instant' && voiceIsPremium(voice)) return false;
    if (voiceSheetFacets.engine !== 'all' && String(voice.provider || '').toLowerCase() !== voiceSheetFacets.engine) return false;
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
  const engineChips = [['all', 'All'], ['edge', 'Edge'], ['kokoro', 'Kokoro'], ['chatterbox', 'Chatterbox']];
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

// Pinned "current voice" card at the top of the sheet: what's playing,
// whether it's ready, and a preview button — no select affordance needed.
function renderCurrentVoiceCard() {
  const voice = voices.find(v => v.id === currentVoice);
  if (!voice) return '';
  const cache = voiceCache[currentVoice];
  const readiness = getVoiceCacheLabel(cache) || 'Ready when you play';
  const playing = deps.getChunkPlayer?.()?.isPlaying;
  return `
    <div class="voice-card voice-card--current" aria-label="Current voice">
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
  return '<span class="voice-pill">Instant</span>';
}

export async function loadVoices() {
  try {
    const [data] = await Promise.all([apiGet('/api/voices'), loadEngineStatus()]);
    voices = data.voices;
    currentVoice = data.current;
    await loadVoiceCacheStatus();
    renderVoices();
    updatePlayerVoiceStatus();
  } catch {
    const html = `
      <div class="empty-state-modern">
        <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg></div>
        <h3>Couldn't load voices</h3>
        <p>Check your connection and try again.</p>
        <button class="btn-primary" data-retry-voices>Retry</button>
      </div>`;
    document.querySelectorAll('#voice-list, #player-voice-list').forEach(list => {
      list.innerHTML = html;
      list.querySelector('[data-retry-voices]')?.addEventListener('click', () => loadVoices());
    });
  }
}

async function loadEngineStatus() {
  try {
    engineStatus = await apiGet('/api/engines/status');
  } catch {
    engineStatus = null;
  }
}

function getVoiceName(voiceId) {
  const voice = voices.find(v => v.id === voiceId);
  return voice ? voice.name : voiceId;
}

async function loadVoiceCacheStatus() {
  voiceCache = {};
  if (!deps.getCurrentBook() || !deps.getChapters()[deps.getCurrentChapter()]) return;

  try {
    const data = await apiGet(`/api/voice-cache/${encodeURIComponent(deps.getCurrentBook().id)}/${deps.getCurrentChapter()}`);
    voiceCache = Object.fromEntries((data.voices || []).map(item => [item.voiceId, item]));
  } catch (err) {
    console.warn('Failed to load voice cache status:', err);
  }
}

function renderVoices() {
  renderVoiceSurface('voice-filter-bar', 'voice-list');
  renderVoiceSurface('player-voice-filter-bar', 'player-voice-list');
}

function renderVoiceSurface(filterBarId, listId) {
  const voiceList = document.getElementById(listId);
  if (!voiceList) return;

  // Player sheet has its own surface: pinned current voice + search +
  // tier segmented control, sections below.
  if (filterBarId === 'player-voice-filter-bar') {
    renderVoiceFacetChips(filterBarId);
    renderVoiceSheetSections(listId);
    return;
  }

  renderVoiceFilters(filterBarId);
  const filteredVoices = filterVoices(voices);
  const savedVoices = filteredVoices.filter(v => savedVoiceIds.includes(v.id));
  const savedSet = new Set(savedVoices.map(v => v.id));
  const topVoices = filteredVoices.filter(v => !savedSet.has(v.id) && (v.top || v.custom || v.id === currentVoice));
  const shownSet = new Set([...savedVoices, ...topVoices].map(v => v.id));
  const otherVoices = filteredVoices.filter(v => !shownSet.has(v.id));
  const voiceSections = [];

  if (savedVoices.length > 0) {
    voiceSections.push(renderVoiceSection('My voices', savedVoices));
  }

  if (topVoices.length > 0) {
    voiceSections.push(renderVoiceSection('Top voices', topVoices));
  }

  if (otherVoices.length > 0) {
    voiceSections.push(renderVoiceSection('All voices', otherVoices));
  }

  if (voiceSections.length === 0) {
    voiceSections.push('<p class="voice-empty">No voices match those filters.</p>');
  }

  // Settings is the management home: clone panel leads.
  voiceList.innerHTML = [renderCloneVoicePanel(), ...voiceSections].join('');
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
    <div class="voice-section">
      <div class="voice-section-title">Chatterbox</div>
      <form class="clone-voice-form${hasCustomVoices ? '' : ' clone-voice-form--cta'}">
        <div class="clone-voice-copy">
          ${hasCustomVoices ? '' : '<span class="clone-voice-badge" aria-hidden="true">✨ Voice cloning</span>'}
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
    </div>
  `;
}

function filterVoices(list) {
  return list.filter(voice =>
    matchesVoiceFilter(voice.provider, voiceFilters.provider) &&
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
    { key: 'provider', label: 'Source', values: getVoiceFilterValues('provider', ['chatterbox', 'kokoro', 'edge']) }
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
      .map(voice => String(voice[key] || '').toLowerCase())
      .filter(Boolean)
  );
  const preferred = preferredOrder.filter(value => values.has(value));
  const rest = Array.from(values).filter(value => !preferred.includes(value)).sort();
  return ['all', ...preferred, ...rest];
}

function voiceMatchesOtherFilters(voice, ignoredKey) {
  return Object.entries(voiceFilters).every(([key, value]) =>
    key === ignoredKey || matchesVoiceFilter(voice[key], value)
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
  const voice = voices.find(v => v.id === currentVoice);
  const cache = voiceCache[currentVoice];
  if (voice && isHighQualityVoice()) {
    // Premium voice: the status line speaks in tiers, not engines.
    const servedTier = deps.getServedTier ? deps.getServedTier() : null;
    playerVoiceName.textContent = servedTier === 'instant'
      ? `${voice.name} · Instant (premium preparing)`
      : `${voice.name} · Premium`;
  } else {
    playerVoiceName.textContent = voice ? `${voice.name} · ${voice.provider || voice.tier || 'Voice'}` : 'Voice not selected';
  }
  playerVoiceCache.textContent = getVoiceCacheLabel(cache) || 'Cache status unavailable';
  playerVoiceStatus.dataset.cache = getVoiceCacheClass(cache);
  updateHighQualityPrepPanel();
}

function isHighQualityVoice(voiceId = currentVoice) {
  const voice = voices.find(v => v.id === voiceId);
  return String(voiceId || '').startsWith('chatterbox:') ||
    String(voice?.provider || '').toLowerCase() === 'chatterbox';
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

// Book-level premium prep panel (progressive premium audio). The panel
// shows book-wide upgrade progress; playback always starts instantly on
// the paired instant voice while premium chapters render in the background.
function updateHighQualityPrepPanel() {
  if (!hqVoicePrep) return;
  const visible = Boolean(deps.getCurrentBook() && deps.getChapters()[deps.getCurrentChapter()] && isHighQualityVoice());
  if (!visible) {
    hqVoicePrep.hidden = true;
    stopHighQualityPrepPolling();
    return;
  }

  startHighQualityPrepPolling();

  const status = premiumBookStatus;
  const total = Number(status?.totalChapters) || 0;
  const ready = Number(status?.readyChapters) || 0;
  const percent = total > 0 ? Math.round((ready / total) * 100) : 0;
  const allReady = total > 0 && ready >= total;

  let state = 'idle';
  if (allReady) state = 'ready';
  else if (status?.status === 'error') state = 'error';
  else if (status?.status === 'paused' || status?.status === 'engineOffline') state = 'generating';
  else if (status?.status === 'generating') state = 'generating';

  // Auto-hide shortly after the whole book is premium-ready.
  if (state === 'ready') {
    if (!hqVoicePrepHideTimer) {
      hqVoicePrepHideTimer = setTimeout(() => {
        if (hqVoicePrep) hqVoicePrep.hidden = true;
      }, 4000);
    }
  } else if (hqVoicePrepHideTimer) {
    clearTimeout(hqVoicePrepHideTimer);
    hqVoicePrepHideTimer = null;
    hqVoicePrep.hidden = false;
  }
  if (state !== 'ready') hqVoicePrep.hidden = false;

  hqVoicePrep.dataset.state = state;
  if (hqVoicePrepTitle) hqVoicePrepTitle.textContent = 'Premium audio';
  if (hqVoicePrepDetail) {
    let detail;
    if (state === 'ready') detail = 'Premium audio ready';
    else if (state === 'error') detail = 'Premium generation failed — Retry';
    else if (status?.status === 'engineOffline') detail = 'Premium engine offline — instant voice continues';
    else if (status?.status === 'paused') detail = 'Paused while playing — resumes when idle';
    else if (status?.status === 'generating') detail = `Preparing premium audio — ${ready} of ${total} chapters`;
    else detail = 'Premium audio prepares in the background.';
    hqVoicePrepDetail.textContent = detail;
  }
  if (hqVoicePrepFill) hqVoicePrepFill.style.width = `${percent}%`;
  if (hqVoicePrepCount) hqVoicePrepCount.textContent = total > 0 ? `${ready}/${total}` : 'Not started';
  if (hqVoicePrepBtn) {
    hqVoicePrepBtn.disabled = state === 'ready' || state === 'generating';
    hqVoicePrepBtn.textContent = state === 'ready'
      ? 'Prepared'
      : (state === 'error' ? 'Retry' : (state === 'generating' ? 'Preparing...' : 'Prepare book'));
  }
}

async function refreshHighQualityPrepPanel() {
  await loadVoiceCacheStatus();
  renderVoices();
  updatePlayerVoiceStatus();
}

async function fetchHighQualityPrepStatus() {
  const book = deps.getCurrentBook();
  if (!book) return null;
  try {
    return await apiGet(`/api/premium-prep/${encodeURIComponent(book.id)}/status`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function prepareCurrentHighQualityChapter() {
  const book = deps.getCurrentBook();
  if (!book || !isHighQualityVoice()) return;
  const retry = premiumBookStatus?.status === 'error';
  try {
    await apiSend('POST', `/api/premium-prep/${encodeURIComponent(book.id)}/start`, {
      fromChapter: deps.getCurrentChapter() || 0,
      retry
    });
    premiumBookStatus = { ...(premiumBookStatus || {}), status: 'generating' };
    updateHighQualityPrepPanel();
  } catch (err) {
    console.error('Premium prep start failed:', err);
    showToast('Premium audio prep failed', 'error');
  }
}

function startHighQualityPrepPolling() {
  if (hqVoicePrepPolling) return;
  hqVoicePrepPolling = true;
  const generation = hqVoicePrepGeneration;

  const tick = async () => {
    if (generation !== hqVoicePrepGeneration) return;
    hqVoicePrepTimer = null;
    const book = deps.getCurrentBook();
    if (!book || !isHighQualityVoice()) {
      hqVoicePrepPolling = false;
      updateHighQualityPrepPanel();
      return;
    }

    try {
      const status = await fetchHighQualityPrepStatus();
      if (status && status.premiumActive) {
        premiumBookStatus = status;
        premiumChapterReadiness = Array.isArray(status.chapters) ? status.chapters : [];
        maybeAnnouncePremiumSwitchover();
      }
    } catch (err) {
      console.error('Premium prep polling failed:', err);
    }

    updateHighQualityPrepPanel();
    const allReady = premiumBookStatus &&
      premiumBookStatus.totalChapters > 0 &&
      premiumBookStatus.readyChapters >= premiumBookStatus.totalChapters;
    if (generation !== hqVoicePrepGeneration) return;
    if (!allReady) {
      hqVoicePrepTimer = setTimeout(tick, HIGH_QUALITY_PREP_POLL_MS);
    } else {
      hqVoicePrepPolling = false;
    }
  };

  hqVoicePrepTimer = setTimeout(tick, 700);
}

// One-time quiet toast per book, the first time the premium variant is
// ready to take over at the next chapter boundary while the instant voice
// is playing.
function maybeAnnouncePremiumSwitchover() {
  const book = deps.getCurrentBook();
  if (!book || premiumToastBooks.has(book.id)) return;
  const servedTier = deps.getServedTier ? deps.getServedTier() : null;
  if (servedTier !== 'instant') return;
  const nextChapter = (deps.getCurrentChapter() || 0) + 1;
  if (premiumChapterReadiness[nextChapter]) {
    premiumToastBooks.add(book.id);
    showToast('Premium voice starts next chapter');
  }
}

async function openVoiceSheet() {
  await loadVoices();
  if (!voiceSheet) return;
  voiceSheetController?.open();
}

export function closeVoiceSheetDirect() {
  voiceSheetController?.close();
}

function closeVoiceSheet() {
  voiceSheetController?.dismiss();
}

function renderVoiceSection(title, sectionVoices) {
  return `
    <div class="voice-section">
      <div class="voice-section-title">${escapeHTML(title)}</div>
      ${sectionVoices.map(renderVoiceCard).join('')}
    </div>
  `;
}

function renderVoiceCard(v) {
    const isActive = v.id === currentVoice;
    const isSaved = savedVoiceIds.includes(v.id);
    const provider = String(v.provider || '').toLowerCase();
    const status = engineStatus?.engines?.[provider];
    const isLocalEngine = provider === 'kokoro' || provider === 'chatterbox';
    const isStarting = status?.status === 'starting';
    const isEngineDown = isLocalEngine && status && !status.up && !isStarting;
    // Selection is the recovery path for local engines: /api/voice starts the provider.
    const selectionDisabled = !isLocalEngine && status && !status.up;
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
    const summaryTags = (v.tags && v.tags.length ? v.tags : [v.gender, v.accent, v.depth].filter(Boolean)).slice(0, 3);
    const tagSummary = summaryTags.map(t => escapeHTML(t)).join(' · ');
    const checkIcon = isActive
      ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="voice-card-check" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>'
      : '';

    return `
      <div class="voice-card ${isActive ? 'active' : ''} ${selectionDisabled ? 'voice-card--offline' : ''} ${isEngineDown ? 'voice-card--engine-down' : ''}" data-voice-id="${safeAttr(v.id)}" data-offline="${selectionDisabled ? '1' : '0'}" role="option" aria-selected="${isActive ? 'true' : 'false'}" aria-disabled="${selectionDisabled ? 'true' : 'false'}">
        <button class="voice-save-btn ${isSaved ? 'saved' : ''}" data-voice-action="save" data-save-voice-id="${safeAttr(v.id)}" aria-label="${isSaved ? 'Remove' : 'Save'} ${safeAttr(v.name)} ${isSaved ? 'from' : 'to'} My voices" aria-pressed="${isSaved ? 'true' : 'false'}">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${isSaved ? 'fill="currentColor"' : 'fill="none"'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
            <path d="M11.48 3.5a.6.6 0 011.04 0l2.35 4.76a.6.6 0 00.45.33l5.25.76a.6.6 0 01.33 1.02l-3.8 3.7a.6.6 0 00-.17.53l.9 5.22a.6.6 0 01-.87.63l-4.7-2.47a.6.6 0 00-.56 0L7 20.45a.6.6 0 01-.87-.63l.9-5.22a.6.6 0 00-.17-.53l-3.8-3.7a.6.6 0 01.33-1.02l5.25-.76a.6.6 0 00.45-.33l2.35-4.76z" />
          </svg>
        </button>
        <div class="voice-card-info" data-voice-action="select">
          <div class="voice-card-name-row">
            <div class="voice-card-name">${checkIcon}${escapeHTML(v.name)} ${voicePill(v)}</div>
            <span class="voice-readiness ${cacheClass}">${escapeHTML(cacheLabel)}</span>
          </div>
          <div class="voice-card-meta">${selectionDisabled ? 'Local engine offline' : (isEngineDown ? 'Starts when selected' : (isStarting ? 'Local engine starting' : (v.tier === 'chatterbox' ? `Instant start · premium upgrade${tagSummary ? ' · ' + tagSummary : ''}` : tagSummary)))}</div>
          ${partialPercent !== null ? `<div class="voice-progress" role="progressbar" aria-valuenow="${partialPercent}" aria-valuemin="0" aria-valuemax="100"><div style="width:${partialPercent}%"></div></div>` : ''}
        </div>
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

async function selectVoice(voiceId) {
  try {
    const previousVoice = currentVoice;
    const shouldSwitchPlayback = deps.getCurrentBook() && deps.getChunkPlayer() && deps.getChapters()[deps.getCurrentChapter()] && previousVoice !== voiceId;
    const position = shouldSwitchPlayback ? deps.getChunkPlayer().getPosition() : null;
    const wasPlaying = shouldSwitchPlayback ? deps.getChunkPlayer().isPlaying : false;

    const data = await apiSend('POST', '/api/voice', { voiceId });
    if (data.success) {
      currentVoice = voiceId;
      renderVoices();
      updatePlayerVoiceStatus();
      if (voiceSheet && voiceSheet.classList.contains('active')) {
        closeVoiceSheet();
      }
      if (shouldSwitchPlayback) {
        await switchCurrentChapterToVoice(voiceId, position, wasPlaying);
      }
    }
  } catch (err) {
    console.error('Failed to set voice:', err);
    deps.hideAudioLoading();
    // Timeout/failure leaves playback paused — offer a one-tap retry rather
    // than a passive dead-end toast.
    showToast('Voice change failed: ' + err.message, 'error', {
      actionLabel: 'Retry',
      onAction: () => selectVoice(voiceId)
    });
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
  if (voiceCard.dataset.offline === '1') return;
  selectVoice(voiceCard.dataset.voiceId);
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
  document.getElementById('voice-btn')?.addEventListener('click', openVoiceSheet);
  playerVoiceStatus?.addEventListener('click', openVoiceSheet);
}
