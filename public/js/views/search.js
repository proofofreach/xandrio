import { API_BASE, apiGet, apiSend } from '../api.js';
import { formatApiDetails, escapeHTML, safeAttr, encodeState, decodeState } from '../util/format.js';
import { loadLibrary } from './library.js';
import { onActivate } from '../ui/keys.js';
import { trapFocus } from '../ui/focus-trap.js';
import { getDefaultSearchSources } from '../client-settings.js';

let deps = {};
let searchInput = null;
let searchBtn = null;
let searchResults = null;
let downloadError = null;
let languageFilter = null;
let uploadBtn = null;
let dropZone = null;
let fileInput = null;
let uploadProgress = null;
let uploadFilename = null;
let uploadStatus = null;
let uploadProgressFill = null;
let sourceControls = null;
let sourceReset = null;
let sourceMessage = null;
let searchClearBtn = null;
let filterToggle = null;
let filterPanel = null;
let filterScrim = null;
let filterCloseBtn = null;
let filterApplyBtn = null;
let releaseFilterFocus = null;
let filterCount = null;
let resultsCount = null;
let searchSort = null;
let searchSortWrap = null;
let lastSearchAlternatives = [];
let lastSearchWorks = [];
let lastSearchIntent = null;
let lastSearchCorrection = null;
let workById = new Map();
let editionAlternativesByHash = new Map();
let visibleWorkCount = 0;
let searchLoadObserver = null;
let searchLoadMore = null;
let lastImportReviewResultsHtml = '';
let dragDepth = 0;
let sourceAvailability = new Map();
let selectedSources = new Set();
let latestSourceStatus = {};
let sourceSelectionMessage = '';
let searchInProgress = false;
let searchRequestVersion = 0;
const SEARCH_COVER_RETRY_DELAY_MS = 3000;
const MOBILE_SEARCH_MEDIA = '(max-width: 759px)';

const SEARCH_SOURCES = [
  { id: 'standardebooks', label: 'Standard' },
  { id: 'gutenberg', label: 'Gutenberg' },
  { id: 'annas', label: "Anna's" },
  { id: 'zlibrary', label: 'Z-Lib' },
  { id: 'internetarchive', label: 'Archive' },
  { id: 'opds', label: 'OPDS' }
];

// Search Functions
// Helper: Convert quality score to star display
// Skeleton rows shown in the search view while a search request is in flight.
function skeletonResultsHTML() {
  const row = `
    <div class="result-card skeleton-result" aria-hidden="true">
      <div class="sk-block sk-result-cover"></div>
      <div class="skeleton-result-lines">
        <div class="sk-line w-70"></div>
        <div class="sk-line w-45"></div>
      </div>
    </div>
  `;
  return `<div class="search-results-list">${row.repeat(6)}</div>`;
}

const SEARCH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>';
const ERROR_ICON = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>';
const ADD_TO_LIBRARY_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

// Renders an .empty-state-modern block into the results area. When `retry` is
// true a Retry button is shown and wired to re-run the current search.
function renderSearchState({ icon, title, message, retry }) {
  const retryBtn = retry ? '<button class="btn-primary" data-search-retry>Retry</button>' : '';
  searchResults.innerHTML = `
    <div class="empty-state-modern">
      <div class="empty-icon">${icon}</div>
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(message)}</p>
      ${retryBtn}
    </div>`;
  if (retry) {
    searchResults.querySelector('[data-search-retry]')?.addEventListener('click', () => searchBooks());
  }
}

function isMobileSearchLayout() {
  return window.matchMedia(MOBILE_SEARCH_MEDIA).matches;
}

function setFilterPanelExpanded(expanded, options = {}) {
  if (!filterPanel || !filterToggle) return;
  const mobile = isMobileSearchLayout();
  filterPanel.hidden = !expanded;
  filterToggle.setAttribute('aria-expanded', String(expanded));
  if (filterScrim) filterScrim.hidden = !expanded || !mobile;
  document.body.classList.toggle('search-filters-open', expanded && mobile);

  if (mobile) {
    filterPanel.setAttribute('role', 'dialog');
    filterPanel.setAttribute('aria-modal', 'true');
    filterPanel.setAttribute('aria-labelledby', 'search-filter-title');
  } else {
    filterPanel.removeAttribute('role');
    filterPanel.removeAttribute('aria-modal');
    filterPanel.removeAttribute('aria-labelledby');
  }

  if (expanded && mobile && options.moveFocus !== false && !releaseFilterFocus) {
    requestAnimationFrame(() => {
      if (!filterPanel.hidden && isMobileSearchLayout() && !releaseFilterFocus) {
        releaseFilterFocus = trapFocus(filterPanel);
      }
    });
  } else if (!expanded || !mobile) {
    if (releaseFilterFocus) {
      const release = releaseFilterFocus;
      releaseFilterFocus = null;
      release();
    } else if (!expanded && options.restoreFocus) {
      filterToggle.focus();
    }
  }
}

function updateFilterSummary() {
  if (!filterCount) return;
  const languageCount = languageFilter?.value && languageFilter.value !== 'en' ? 1 : 0;
  const count = configuredSourceIds().length + languageCount;
  filterCount.textContent = String(count);
  filterToggle?.setAttribute('aria-label', `${count} active search ${count === 1 ? 'filter' : 'filters'}`);
}

function syncSearchClearButton() {
  if (searchClearBtn) searchClearBtn.hidden = !searchInput?.value;
}

function updateSearchUrl(query = '') {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set('q', query);
  else url.searchParams.delete('q');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function clearRenderedSearchResults() {
  searchRequestVersion += 1;
  searchInProgress = false;
  lastSearchAlternatives = [];
  lastSearchWorks = [];
  lastSearchIntent = null;
  lastSearchCorrection = null;
  workById = new Map();
  editionAlternativesByHash = new Map();
  visibleWorkCount = 0;
  searchLoadObserver?.disconnect();
  searchLoadObserver = null;
  searchLoadMore = null;
  if (searchResults) searchResults.innerHTML = '';
  if (resultsCount) resultsCount.hidden = true;
  if (searchSortWrap) searchSortWrap.hidden = true;
  if (searchBtn) searchBtn.disabled = false;
}

function safeResultCoverUrl(result) {
  if (!result?.coverUrl) return '';
  try {
    const url = new URL(result.coverUrl, window.location.origin);
    if (url.origin === window.location.origin && (url.protocol === 'http:' || url.protocol === 'https:')) {
      return url.href;
    }
  } catch {}
  return '';
}

function retrySearchCoverUrl(value) {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin ||
        !/^\/api\/search-cover\/[a-f0-9]{32}$/.test(url.pathname)) return '';
    url.searchParams.set('retry', '1');
    url.searchParams.set('cachebuster', String(Date.now()));
    return url.href;
  } catch {
    return '';
  }
}

function sortedSearchWorks() {
  const items = [...lastSearchWorks];
  const mode = searchSort?.value || 'relevance';
  const primary = work => work.bestEdition || work;
  const compareWithinGroup = (a, b, compare) => {
    // Never let a related/about title leap ahead of authored works during an
    // author search. Sorting still applies inside each meaningful section.
    const groupRank = group => group === 'authored' ? 0 : group === 'related' ? 1 : 0;
    return groupRank(a.searchGroup) - groupRank(b.searchGroup) || compare(a, b);
  };
  if (mode === 'title') return items.sort((a, b) => compareWithinGroup(a, b, (left, right) => String(left.title || '').localeCompare(String(right.title || ''))));
  if (mode === 'author') return items.sort((a, b) => compareWithinGroup(a, b, (left, right) => String(left.author || '').localeCompare(String(right.author || ''))));
  if (mode === 'year') return items.sort((a, b) => compareWithinGroup(a, b, (left, right) => (Number(primary(right)._year) || 0) - (Number(primary(left)._year) || 0)));
  if (mode === 'source') return items.sort((a, b) => compareWithinGroup(a, b, (left, right) => {
    const sourceKey = work => (Array.isArray(work.sources) && work.sources.length ? work.sources : [primary(work).source])
      .filter(Boolean)
      .map(getSourceLabel)
      .sort()
      .join('|');
    return sourceKey(left).localeCompare(sourceKey(right));
  }));
  return items.sort((a, b) => Number(a._searchOrder) - Number(b._searchOrder));
}

function buildResultCard(work, eagerCover = false) {
  const result = work.bestEdition || work;
  const isBest = Boolean(work.isBestMatch);
  const coverUrl = safeResultCoverUrl(result);
  const editions = Array.isArray(work.editions) && work.editions.length ? work.editions : [result];
  const sources = Array.isArray(work.sources) && work.sources.length
    ? work.sources
    : [...new Set(editions.map(edition => edition.source).filter(Boolean))];
  const versionQualifier = edition => {
    const title = String(edition.title || '');
    if (/\bunabridged\b/i.test(title)) return 'Unabridged';
    if (/\babridged\b/i.test(title)) return 'Abridged';
    if (/\b(?:adapted|adaptation|retold|retelling)\b/i.test(title)) return 'Adapted';
    if (/\boriginal (?:scroll|manuscript)\b/i.test(title)) return 'Original text';
    return '';
  };
  const editionInfo = editions.length > 1
    ? `<details class="edition-disclosure">
        <summary class="edition-count">${editions.length} versions · ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}</summary>
        <ul class="edition-list" aria-label="Available versions of ${safeAttr(work.title || result.title || 'this work')}">
          ${editions.map((edition, index) => {
            const heading = [index === 0 ? 'Recommended' : '', String(edition.format || 'Book').toUpperCase(), versionQualifier(edition)].filter(Boolean).join(' · ');
            const label = [edition._year || edition.publisher, getSourceLabel(edition.source), edition.size].filter(Boolean).join(' · ');
            const accessibleVersion = [heading, label || `version ${index + 1}`].filter(Boolean).join(', ');
            return `<li>
              <button type="button" class="edition-option${index === 0 ? ' is-default' : ''}" data-edition-choice="${index}" data-work-id="${safeAttr(work.id)}" aria-label="Add ${safeAttr(work.title || result.title || 'book')} to library, ${safeAttr(accessibleVersion)}">
                <span class="edition-option-copy"><strong>${escapeHTML(heading)}</strong><span>${escapeHTML(label || 'Available version')}</span></span>
                <span class="edition-choice-icon" aria-hidden="true">${ADD_TO_LIBRARY_ICON}</span>
              </button>
            </li>`;
          }).join('')}
        </ul>
      </details>`
    : '';
  const publisher = result.publisher && result._year
    ? String(result.publisher).replace(String(result._year), '').replace(/,\s*$/, '').trim()
    : result.publisher;
  const secondaryMeta = [result.size, result._year, publisher]
    .filter(Boolean)
    .map(value => escapeHTML(String(value)))
    .join(' · ');
  const editionMeta = [
    result.format ? String(result.format).toUpperCase() : '',
    result.source ? getSourceLabel(result.source) : ''
  ].filter(Boolean);
  const title = work.title || result.title || 'Untitled';
  const author = work.author || result.author || 'Unknown';
  const coverLoading = eagerCover ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const recommendedVersion = [
    result.format ? String(result.format).toUpperCase() : '',
    result.source ? `from ${getSourceLabel(result.source)}` : ''
  ].filter(Boolean).join(' ');
  const coverActionLabel = `Add ${title} to library${recommendedVersion ? `, recommended ${recommendedVersion}` : ''}`;

  return `
    <article class="result-card${isBest ? ' result-card-best' : ''}" data-work-id="${safeAttr(work.id)}">
      <button type="button" class="result-cover-shell result-cover-action" data-work-add data-work-id="${safeAttr(work.id)}" aria-label="${safeAttr(coverActionLabel)}">
        <span class="result-cover-fallback" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.4" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25A8.966 8.966 0 0118 3.75c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          <span>${escapeHTML(String(result.format || 'Book').toUpperCase())}</span>
        </span>
        ${coverUrl ? `<img class="result-cover" data-result-cover src="${safeAttr(coverUrl)}" alt="" width="200" height="300" ${coverLoading} decoding="async" referrerpolicy="no-referrer" />` : ''}
        ${isBest ? '<span class="best-match-badge">Best match</span>' : ''}
        <span class="result-cover-action-cue" aria-hidden="true"><span class="result-cover-action-icon">${ADD_TO_LIBRARY_ICON}</span><span>Add to library</span></span>
      </button>
      <div class="result-card-copy">
        <h3 class="result-card-title">${escapeHTML(title)}</h3>
        <p class="result-card-author">${escapeHTML(author)}</p>
        ${secondaryMeta ? `<p class="result-card-biblio">${secondaryMeta}</p>` : ''}
        ${editionInfo}
        ${editionMeta.length ? `<footer class="result-card-footer"><p class="result-card-edition-meta">${editionMeta.map(value => `<span>${escapeHTML(value)}</span>`).join('')}</p></footer>` : ''}
      </div>
    </article>`;
}

function workGroupLabel(group) {
  const author = lastSearchIntent?.kind === 'author' ? lastSearchIntent.author : '';
  if (group === 'authored') return author ? `Works by ${author}` : 'Works by this author';
  if (group === 'related') return author ? `Related to ${author}` : 'Related and about this author';
  return '';
}

function ensureResultGroup(group) {
  const key = group || 'results';
  let section = searchResults.querySelector(`[data-work-group="${key}"]`);
  if (section) return section.querySelector('.search-results-list');
  section = document.createElement('section');
  section.className = 'search-work-group';
  section.dataset.workGroup = key;
  const label = workGroupLabel(key);
  section.innerHTML = `${label ? `<h3 class="search-work-group-title">${escapeHTML(label)}</h3>` : ''}<div class="search-results-list"></div>`;
  searchResults.insertBefore(section, searchLoadMore || null);
  return section.querySelector('.search-results-list');
}

function updateSearchLoadMore(sorted) {
  if (!searchLoadMore) return;
  const remaining = sorted.length - visibleWorkCount;
  searchLoadMore.hidden = remaining <= 0;
  if (remaining > 0) {
    const button = searchLoadMore.querySelector('[data-search-load-more]');
    const status = searchLoadMore.querySelector('[data-search-load-status]');
    button.hidden = false;
    status.textContent = `${visibleWorkCount} of ${sorted.length} works shown`;
  }
}

function appendSearchResultBatch() {
  if (!searchResults) return;
  const sorted = sortedSearchWorks();
  if (visibleWorkCount >= sorted.length) return;
  const batch = sorted.slice(visibleWorkCount, visibleWorkCount + 20);
  let eagerCover = visibleWorkCount === 0;
  for (const work of batch) {
    const grid = ensureResultGroup(work.searchGroup);
    grid.insertAdjacentHTML('beforeend', buildResultCard(work, eagerCover));
    eagerCover = false;
  }
  visibleWorkCount += batch.length;
  searchResults.querySelectorAll('[data-result-cover]').forEach(image => {
    if (image.dataset.coverBound) return;
    image.dataset.coverBound = 'true';
    image.addEventListener('load', () => { image.hidden = false; });
    image.addEventListener('error', () => {
      image.hidden = true;
      if (image.dataset.coverRetryAttempted) return;
      image.dataset.coverRetryAttempted = 'true';
      window.setTimeout(() => {
        if (!image.isConnected) return;
        const retryUrl = retrySearchCoverUrl(image.currentSrc || image.src);
        if (retryUrl) image.src = retryUrl;
      }, SEARCH_COVER_RETRY_DELAY_MS);
    });
  });
  updateSearchLoadMore(sorted);
}

function observeSearchLoadMore() {
  searchLoadObserver?.disconnect();
  if (!searchLoadMore || !('IntersectionObserver' in window)) return;
  searchLoadObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) appendSearchResultBatch();
  }, { rootMargin: '700px 0px' });
  searchLoadObserver.observe(searchLoadMore);
}

function renderSearchResults() {
  if (!searchResults || !lastSearchWorks.length) return;
  searchLoadObserver?.disconnect();
  visibleWorkCount = 0;
  const correctionNotice = lastSearchCorrection?.correctedQuery
    ? `<p class="search-correction" role="status">Showing results for <strong>${escapeHTML(lastSearchCorrection.correctedQuery)}</strong></p>`
    : '';
  searchResults.innerHTML = `${correctionNotice}<div class="search-load-more" data-search-load-more-wrap hidden>
    <button type="button" class="btn-secondary search-load-more-btn" data-search-load-more>Show more works</button>
    <span data-search-load-status aria-live="polite"></span>
  </div>`;
  searchLoadMore = searchResults.querySelector('[data-search-load-more-wrap]');
  appendSearchResultBatch();
  observeSearchLoadMore();
  if (resultsCount) {
    const versionCount = lastSearchWorks.reduce((total, work) => total + (Number(work.versionCount) || Number(work.editionCount) || 0), 0);
    resultsCount.textContent = `${lastSearchWorks.length} ${lastSearchWorks.length === 1 ? 'work' : 'works'} · ${versionCount} ${versionCount === 1 ? 'version' : 'versions'}`;
    resultsCount.hidden = false;
  }
  if (searchSortWrap) searchSortWrap.hidden = false;
}

function sameSources(a, b) {
  return a.length === b.length && a.every(id => b.includes(id));
}

function sourceSearchAvailable(id) {
  const availability = sourceAvailability.get(id);
  if (availability?.enabled === false) return false;
  if ((availability?.requiresAcknowledgement || availability?.requiresOperatorAcknowledgement) && availability?.acknowledged === false) return false;
  if (typeof availability?.searchAvailable === 'boolean') return availability.searchAvailable;
  // Z-Library supports anonymous search; account configuration controls downloads only.
  if (id === 'zlibrary') return true;
  return availability?.configured !== false;
}

function configuredSourceIds(ids = [...selectedSources]) {
  return ids.filter(sourceSearchAvailable);
}

function effectiveDefaultSources() {
  const defaults = configuredSourceIds(getDefaultSearchSources());
  if (defaults.length) return defaults;
  const firstAvailable = SEARCH_SOURCES.find(source => sourceSearchAvailable(source.id));
  return firstAvailable ? [firstAvailable.id] : [];
}

function sourceValue(source, selected, configured) {
  if (!configured) {
    return '<span class="source-status-dot is-unavailable" aria-hidden="true"></span><span class="sr-only">Unavailable</span>';
  }
  if (searchInProgress && selected) {
    return '<span class="source-spinner" aria-hidden="true"></span><span class="sr-only">Searching</span>';
  }
  const status = latestSourceStatus[source.id];
  if (!selected || !status) return '';
  if (status.ok) return escapeHTML(String(status.count || 0));
  return '<span class="source-status-dot is-issue" aria-hidden="true"></span><span class="sr-only">Source issue</span>';
}

function sourceIssueLabel(status = {}) {
  const code = status.errorCode || status.code;
  if (code === 'ZLIB_AUTH_EXPIRED') return 'Reconnect required';
  if (code === 'ZLIB_TIMEOUT') return 'Timed out';
  if (code === 'ZLIB_UNAVAILABLE') return 'Temporarily unavailable';
  if (code === 'ZLIB_RATE_LIMITED') return 'Rate limited';
  return status.message || status.error || 'Unavailable';
}

function sourceStatusMessage() {
  const issues = configuredSourceIds()
    .map(id => ({ source: SEARCH_SOURCES.find(source => source.id === id), status: latestSourceStatus[id] }))
    .filter(({ status }) => status && status.ok === false)
    .map(({ source, status }) => `${source?.label || 'Selected source'}: ${sourceIssueLabel(status)}`);
  return issues.join(' · ');
}

function renderSourceMessage() {
  if (!sourceMessage) return;
  const statusMessage = sourceStatusMessage();
  sourceMessage.textContent = sourceSelectionMessage || statusMessage;
  sourceMessage.classList.toggle('has-issue', !sourceSelectionMessage && Boolean(statusMessage));
}

function soleSourceFailure(sourceIds) {
  if (!sourceIds.length) return null;
  const failed = sourceIds
    .map(id => ({ id, status: latestSourceStatus[id] }))
    .filter(({ status }) => status && status.ok === false);
  return failed.length === sourceIds.length ? failed[0] : null;
}

function renderSourceFailure(sourceIds) {
  const failure = soleSourceFailure(sourceIds);
  if (!failure) return false;
  const source = SEARCH_SOURCES.find(item => item.id === failure.id);
  const label = sourceIssueLabel(failure.status);
  const sourceLabel = failure.status.label || source?.label || 'Selected source';
  renderSearchState({
    icon: ERROR_ICON,
    title: `${sourceLabel}: ${label}`,
    message: 'Reconnect it or choose another source, then try again.',
    retry: true
  });
  return true;
}

function renderSourceShelf() {
  if (!sourceControls) return;
  const orderedSources = SEARCH_SOURCES
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const rank = item => {
        const configured = sourceSearchAvailable(item.source.id);
        if (!configured) return 2;
        return selectedSources.has(item.source.id) ? 0 : 1;
      };
      return rank(a) - rank(b) || a.index - b.index;
    })
    .map(item => item.source);

  sourceControls.innerHTML = orderedSources.map(source => {
    const availability = sourceAvailability.get(source.id);
    const configured = sourceSearchAvailable(source.id);
    const selected = configured && selectedSources.has(source.id);
    const status = latestSourceStatus[source.id];
    const value = sourceValue(source, selected, configured);
    const classes = [
      'search-source-pill',
      selected ? 'is-selected' : '',
      !configured ? 'is-off' : '',
      status && selected && !status.ok ? 'is-issue' : '',
      searchInProgress && selected ? 'is-searching' : ''
    ].filter(Boolean).join(' ');
    const title = !configured
      ? `${availability?.label || source.label} requires configuration or acknowledgement on this instance`
      : (status && !status.ok
        ? sourceIssueLabel(status)
        : `${selected ? 'Exclude' : 'Include'} ${availability?.label || source.label}`);
    return `
      <button type="button" class="${classes}" data-search-source="${source.id}"
        aria-pressed="${selected}" ${configured ? '' : 'disabled'} title="${safeAttr(title)}">
        <span>${escapeHTML(source.label)}</span>
        ${value ? `<span class="search-source-value">${value}</span>` : ''}
      </button>`;
  }).join('');

  const defaults = effectiveDefaultSources();
  const current = configuredSourceIds();
  if (sourceReset) sourceReset.hidden = sameSources(current, defaults);
  renderSourceMessage();
  updateFilterSummary();
}

function resetSourceShelf() {
  selectedSources = new Set(effectiveDefaultSources());
  latestSourceStatus = {};
  sourceSelectionMessage = '';
  renderSourceShelf();
}

function resetSearchWorkspace() {
  clearRenderedSearchResults();
  lastImportReviewResultsHtml = '';
  if (searchInput) searchInput.value = '';
  updateSearchUrl('');
  if (searchSort) searchSort.value = 'relevance';
  if (downloadError) {
    downloadError.innerHTML = '';
    downloadError.style.display = 'none';
  }
  syncSearchClearButton();
  setFilterPanelExpanded(false, { moveFocus: false });
  resetSourceShelf();
}

async function loadSearchSources() {
  try {
    const data = await apiGet('/api/search/sources');
    sourceAvailability = new Map((data.sources || []).map(source => [source.id, source]));
  } catch (err) {
    console.warn('Search source availability unavailable:', err);
  }
  resetSourceShelf();
}

async function searchBooks() {
  const query = searchInput.value.trim();
  if (!query) return;

  const selectedLanguage = languageFilter.value;
  const sources = configuredSourceIds();
  if (!sources.length) {
    sourceSelectionMessage = 'Choose at least one available source.';
    renderSourceShelf();
    return;
  }
  const requestVersion = ++searchRequestVersion;

  // Clear any previous download errors
  downloadError.style.display = 'none';
  searchResults.innerHTML = skeletonResultsHTML();
  if (resultsCount) resultsCount.hidden = true;
  if (searchSortWrap) searchSortWrap.hidden = true;
  sourceSelectionMessage = '';
  latestSourceStatus = {};
  lastSearchAlternatives = [];
  lastSearchWorks = [];
  lastSearchIntent = null;
  lastSearchCorrection = null;
  workById = new Map();
  editionAlternativesByHash = new Map();
  searchLoadObserver?.disconnect();
  searchLoadObserver = null;
  searchLoadMore = null;
  searchInProgress = true;
  searchBtn.disabled = true;
  renderSourceShelf();

  try {
    const data = await apiSend('POST', '/api/search', { query, language: selectedLanguage, sources });
    if (requestVersion !== searchRequestVersion) return;
    latestSourceStatus = data.sourceStatus || {};

    if (data.error === 'No results found') {
      if (renderSourceFailure(sources)) return;
      renderSearchState({ icon: SEARCH_ICON, title: 'No results found', message: 'Try a different title, author, or spelling.' });
      return;
    }

    if (data.error === 'No quality versions found, try different search') {
      searchResults.innerHTML = `
        <div class="error-box">
          <h3>Warning: No Quality Versions Found</h3>
          <p>All available versions failed quality checks. Try a different search term.</p>
        </div>
      `;
      return;
    }

    if (!Array.isArray(data.works) || data.works.length === 0) {
      if (renderSourceFailure(sources)) return;
      renderSearchState({ icon: SEARCH_ICON, title: 'No results found', message: 'Try a different title, author, or spelling.' });
      return;
    }

    lastSearchWorks = data.works.map((work, index) => {
      const editions = Array.isArray(work.editions) && work.editions.length
        ? work.editions
        : work.bestEdition ? [work.bestEdition] : [];
      const bestEdition = work.bestEdition || editions[0];
      return {
        ...work,
        id: work.id || work.workIdentity || `search-work-${index}`,
        title: work.title || bestEdition?.title || 'Untitled',
        author: work.author || bestEdition?.author || 'Unknown',
        bestEdition,
        editions,
        editionCount: Number(work.editionCount) || editions.length,
        versionCount: Number(work.versionCount) || Number(work.editionCount) || editions.length,
        sources: Array.isArray(work.sources) && work.sources.length
          ? work.sources
          : [...new Set(editions.map(edition => edition.source).filter(Boolean))],
        sourceCount: Number(work.sourceCount) || new Set(editions.map(edition => edition.source).filter(Boolean)).size,
        _searchOrder: index
      };
    });
    lastSearchIntent = data.searchIntent || null;
    lastSearchCorrection = data.searchCorrection || null;
    workById = new Map(lastSearchWorks.map(work => [work.id, work]));
    editionAlternativesByHash = new Map();
    for (const work of lastSearchWorks) {
      for (const edition of work.editions) {
        if (!edition?.hash) continue;
        editionAlternativesByHash.set(edition.hash, work.editions.filter(other =>
          other !== edition && other.hash !== edition.hash &&
          edition.fallbackGroupId && other.fallbackGroupId === edition.fallbackGroupId
        ));
      }
    }
    updateSearchUrl(query);
    if (searchSort) searchSort.value = 'relevance';
    renderSearchResults();
    if (isMobileSearchLayout()) setFilterPanelExpanded(false);
  } catch (err) {
    if (requestVersion !== searchRequestVersion) return;
    console.error('Search failed:', err);
    latestSourceStatus = Object.fromEntries(sources.map(id => [id, { id, ok: false, error: err.message }]));
    renderSearchState({ icon: ERROR_ICON, title: 'Search failed', message: 'Check your connection and try again.', retry: true });
  } finally {
    if (requestVersion === searchRequestVersion) {
      searchInProgress = false;
      searchBtn.disabled = false;
      renderSourceShelf();
    }
  }
}

function downloadBookFromEncodedResult(encodedResult) {
  try {
    downloadBook(decodeState(encodedResult));
  } catch (err) {
    console.error('Failed to parse retry result:', err);
  }
}

function renderDownloadRetryButtons(alternatives) {
  const retryOptions = Array.isArray(alternatives) && alternatives.length > 0
    ? alternatives
    : lastSearchAlternatives.slice(0, 4);
  const buttons = retryOptions
    .filter(alt => alt && alt.hash)
    .slice(0, 4)
    .map((alt, index) => {
      const label = `${alt.format || 'Book'} · ${alt.title || 'Alternative version'}`;
      const safeResult = encodeState(alt);
      return `<button class="btn-secondary download-retry-btn" style="margin-top:8px;margin-right:8px" data-download-action="retry" data-result="${safeAttr(safeResult)}">${escapeHTML(label)}</button>`;
    })
    .join('');
  return buttons ? `<div class="download-retry-actions">${buttons}</div>` : '';
}

function focusDownloadError() {
  const errorBox = downloadError?.querySelector('.error-box');
  if (!errorBox) return;
  errorBox.setAttribute('role', 'alert');
  errorBox.tabIndex = -1;
  downloadError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  errorBox.focus({ preventScroll: true });
}

const DOWNLOAD_STEPS = [
  'Preparing source',
  'Downloading file',
  'Checking file format',
  'Reading book metadata',
  'Validating chapters',
  'Finding cover',
  'Adding to library'
];

function formatElapsedTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

function estimatedDownloadStep(elapsedMs) {
  if (elapsedMs < 1200) return 1;
  if (elapsedMs < 5000) return 2;
  if (elapsedMs < 9000) return 3;
  if (elapsedMs < 14000) return 4;
  if (elapsedMs < 24000) return 5;
  return 6;
}

const DOWNLOAD_STEP_CHECK_ICON = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 10.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function downloadStepListHTML(currentStep) {
  const items = DOWNLOAD_STEPS.map((label, i) => {
    const stepNum = i + 1;
    const state = stepNum < currentStep ? 'is-done' : stepNum === currentStep ? 'is-current' : 'is-pending';
    const marker = state === 'is-done' ? DOWNLOAD_STEP_CHECK_ICON : '';
    return `
      <li class="download-step ${state}">
        <span class="download-step-marker">${marker}</span>
        <span class="download-step-label">${escapeHTML(label)}</span>
      </li>
    `;
  }).join('');
  return `<ol class="download-step-list">${items}</ol>`;
}

function downloadProgressView(result, state) {
  const totalSteps = DOWNLOAD_STEPS.length;
  const step = Math.max(1, Math.min(state.step || 1, totalSteps));
  const label = state.label || DOWNLOAD_STEPS[step - 1];
  const sourceLabel = getSourceLabel(result.source || 'annas');
  const retryCount = lastSearchAlternatives.filter(a => a.hash !== result.hash).length;
  return {
    totalSteps,
    step,
    label,
    sourceLabel,
    elapsedLabel: `Elapsed ${formatElapsedTime(state.elapsedMs || 0)}`,
    detail: state.detail || '',
    retryLabel: retryCount > 0 && step >= 5
      ? `May try up to ${retryCount} alternative ${retryCount === 1 ? 'version' : 'versions'}`
      : '',
    fillWidth: `${Math.round((step / totalSteps) * 100)}%`
  };
}

function renderDownloadProgress(result, state) {
  const view = downloadProgressView(result, state);

  return `
    <div class="download-progress-panel" role="status" aria-live="polite" aria-atomic="false" aria-label="Book import progress" tabindex="-1" data-progress-step="${view.step}">
      <div class="download-progress-header">
        <div>
          <p class="download-progress-eyebrow">Adding book</p>
          <h3>${escapeHTML(view.label)}</h3>
        </div>
        <span class="download-progress-count">Step ${view.step} of ${view.totalSteps}</span>
      </div>
      <div class="download-progress-track" aria-hidden="true">
        <div class="download-progress-fill" style="width:${view.fillWidth}"></div>
      </div>
      ${downloadStepListHTML(view.step)}
      <div class="download-progress-meta">
        <span data-progress-source>${escapeHTML(view.sourceLabel)}</span>
        <span data-progress-elapsed aria-hidden="true">${escapeHTML(view.elapsedLabel)}</span>
        <span data-progress-detail${view.detail ? '' : ' hidden'}>${escapeHTML(view.detail)}</span>
        <span data-progress-retry${view.retryLabel ? '' : ' hidden'}>${escapeHTML(view.retryLabel)}</span>
      </div>
    </div>
  `;
}

function updateDownloadProgress(panel, result, state) {
  const view = downloadProgressView(result, state);
  const label = panel.querySelector('.download-progress-header h3');
  const count = panel.querySelector('.download-progress-count');
  const fill = panel.querySelector('.download-progress-fill');
  const source = panel.querySelector('[data-progress-source]');
  const elapsed = panel.querySelector('[data-progress-elapsed]');
  const detail = panel.querySelector('[data-progress-detail]');
  const retry = panel.querySelector('[data-progress-retry]');

  if (label && label.textContent !== view.label) label.textContent = view.label;
  const countLabel = `Step ${view.step} of ${view.totalSteps}`;
  if (count && count.textContent !== countLabel) count.textContent = countLabel;
  if (fill && fill.style.width !== view.fillWidth) fill.style.width = view.fillWidth;
  if (source && source.textContent !== view.sourceLabel) source.textContent = view.sourceLabel;
  if (elapsed && elapsed.textContent !== view.elapsedLabel) elapsed.textContent = view.elapsedLabel;
  if (detail) {
    if (detail.textContent !== view.detail) detail.textContent = view.detail;
    const detailHidden = !view.detail;
    if (detail.hidden !== detailHidden) detail.hidden = detailHidden;
  }
  if (retry) {
    if (retry.textContent !== view.retryLabel) retry.textContent = view.retryLabel;
    const retryHidden = !view.retryLabel;
    if (retry.hidden !== retryHidden) retry.hidden = retryHidden;
  }
  if (panel.dataset.progressStep !== String(view.step)) {
    panel.querySelector('.download-step-list')?.remove();
    panel.querySelector('.download-progress-meta')?.insertAdjacentHTML('beforebegin', downloadStepListHTML(view.step));
    panel.dataset.progressStep = String(view.step);
  }
}

function getImportWarnings(data) {
  const warnings = [
    ...(data?.book?.validationWarnings || []),
    ...(data?.validation?.warnings || [])
  ].filter(Boolean);
  return [...new Set(warnings)];
}

function renderImportReview(data, previousResultsHtml = '') {
  const book = data?.book || {};
  const warnings = getImportWarnings(data).slice(0, 5);
  lastImportReviewResultsHtml = previousResultsHtml || '';
  const warningList = warnings.length
    ? `<ul>${warnings.map(warning => `<li>${escapeHTML(warning)}</li>`).join('')}</ul>`
    : '<p>No specific warning details were returned.</p>';
  const restoreButton = previousResultsHtml
    ? '<button class="btn-secondary" data-import-action="restore-results">Back to results</button>'
    : '';

  return `
    <div class="import-review-panel" role="status" aria-live="polite">
      <div>
        <p class="import-review-eyebrow">Review import</p>
        <h3>${escapeHTML(book.title || 'Imported book')}</h3>
        <p class="import-review-author">by ${escapeHTML(book.author || 'Unknown')}</p>
      </div>
      <div class="import-review-warnings">
        ${warningList}
      </div>
      <div class="import-review-actions">
        <button class="btn-primary" data-import-action="open-book" data-book-id="${safeAttr(data.bookId || book.id || '')}">Open book</button>
        ${restoreButton}
      </div>
    </div>
  `;
}

async function finishSuccessfulImport(data, options = {}) {
  const { previousResultsHtml = '', downloadProgress = null } = options;
  downloadProgress?.complete?.('Adding to library');
  downloadError.style.display = 'none';

  const warnings = getImportWarnings(data);
  const needsReview = Boolean(data?.book?.needsReview) || warnings.length > 0;

  await loadLibrary();
  if (needsReview) {
    downloadProgress?.stop?.();
    searchResults.innerHTML = renderImportReview(data, previousResultsHtml);
    return;
  }

  searchResults.innerHTML = '';
  deps.navigateTo?.('library');
  deps.openBook?.(data.bookId);
  downloadProgress?.stop?.();
}

function startDownloadProgress(result) {
  const startedAt = Date.now();
  let stopped = false;
  let progressPanel = null;
  // Time-based estimates only run until the server reports a real step;
  // after that the interval tick just refreshes the elapsed time, so the
  // checklist can't flip between the guess and the reported step.
  let serverDriven = false;
  let current = { step: 1, label: DOWNLOAD_STEPS[0], detail: '' };

  const render = (override = {}) => {
    if (stopped) return;
    const elapsedMs = Date.now() - startedAt;
    if (override.step) {
      serverDriven = true;
      // Equal steps still update the label (e.g. retry attempt counts);
      // lower steps from late or replayed events never move it backward.
      if (override.step >= current.step) {
        current = {
          step: override.step,
          label: override.label || DOWNLOAD_STEPS[override.step - 1],
          detail: override.detail || ''
        };
      }
    } else if (!serverDriven) {
      const estimated = estimatedDownloadStep(elapsedMs);
      if (estimated > current.step) {
        current = { step: estimated, label: DOWNLOAD_STEPS[estimated - 1], detail: '' };
      }
    }
    const state = { ...current, elapsedMs };
    if (!progressPanel?.isConnected) {
      searchResults.innerHTML = renderDownloadProgress(result, state);
      progressPanel = searchResults.querySelector('.download-progress-panel');
      progressPanel?.focus({ preventScroll: true });
    } else {
      updateDownloadProgress(progressPanel, result, state);
    }
  };

  render();
  const interval = window.setInterval(render, 1000);
  return {
    complete(label = 'Adding to library') {
      if (stopped) return;
      render({ step: DOWNLOAD_STEPS.length, label });
    },
    render,
    stop() {
      stopped = true;
      window.clearInterval(interval);
    }
  };
}

async function waitForImportJob(jobId, result, downloadProgress) {
  const applyStatus = (status) => {
    if (!status) return;
    if (status.step) {
      downloadProgress.render?.({
        step: status.step,
        label: status.label || DOWNLOAD_STEPS[status.step - 1],
        detail: status.detail || ''
      });
    }
  };

  const poll = async () => {
    while (true) {
      const status = await apiGet(`/api/download/${encodeURIComponent(jobId)}/status`);
      applyStatus(status);
      if (status.status === 'complete') return status.result;
      if (status.status === 'failed') throw status.error || { error: 'Download failed' };
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  };

  if (!window.EventSource) return poll();

  return new Promise((resolve, reject) => {
    let settled = false;
    const events = new EventSource(`${API_BASE}/api/download/${encodeURIComponent(jobId)}/events`);
    const fallbackTimer = window.setTimeout(() => {
      if (settled) return;
      events.close();
      poll().then(resolve, reject);
    }, 5000);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallbackTimer);
      events.close();
      fn(value);
    };
    const connected = () => window.clearTimeout(fallbackTimer);

    events.addEventListener('snapshot', (event) => {
      connected();
      applyStatus(JSON.parse(event.data));
    });
    events.addEventListener('progress', (event) => {
      connected();
      applyStatus(JSON.parse(event.data));
    });
    events.addEventListener('complete', (event) => {
      connected();
      const payload = JSON.parse(event.data);
      finish(resolve, payload.result);
    });
    events.addEventListener('failed', (event) => {
      connected();
      const payload = JSON.parse(event.data);
      finish(reject, payload.error || { error: 'Download failed' });
    });
    events.onerror = () => {
      if (settled) return;
      events.close();
      poll().then(value => finish(resolve, value), error => finish(reject, error));
    };
  });
}

function isZLibraryConnectionRequired(error, result) {
  if (result?.source !== 'zlibrary') return false;
  if (error?.errorCode === 'ZLIB_NOT_CONFIGURED' || error?.code === 'ZLIB_NOT_CONFIGURED') return true;
  return /connect z-library|source requires configuration/i.test(String(error?.error || error?.message || ''));
}

function renderZLibraryConnectionRequired(error, previousResultsHtml) {
  downloadError.innerHTML = `
    <div class="error-box">
      <h3>Connect Z-Library to download</h3>
      <p>${escapeHTML(error?.error || error?.message || 'Z-Library search works without an account, but downloads require a connected account.')}</p>
      <p class="error-suggestion">Open Settings and connect Z-Library, then try this version again.</p>
      <button type="button" class="btn-primary" data-download-action="settings">Open Settings</button>
    </div>
  `;
  downloadError.style.display = 'block';
  searchResults.innerHTML = previousResultsHtml || '';
  focusDownloadError();
}

async function downloadBook(result) {
  const workAlternatives = editionAlternativesByHash.get(result?.hash);
  if (workAlternatives) lastSearchAlternatives = workAlternatives;
  const previousResultsHtml = searchResults.innerHTML;
  const downloadProgress = startDownloadProgress(result);

  try {
    const filename = `${result.title.replace(/[^a-z0-9]/gi, '_')}.${result.format.toLowerCase()}`;

    const response = await fetch(`${API_BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hash: result.hash,
        filename,
        title: result.title,
        author: result.author,
        language: result.language || languageFilter.value || 'en',
        publisher: result.publisher || null,
        isbn: result.isbn || null,
        openLibraryWorkKey: result.openLibraryWorkKey || null,
        metadataConfidence: result.metadataConfidence || null,
        fallbackGroupId: result.fallbackGroupId || null,
        source: result.source || 'annas',
        url: result.url || null,
        rights: result.rights || result.reportedRights || null,
        license: result.license || result.licence || result.reportedLicense || null,
        zlibId: result.zlibId || null,
        gutenbergId: result.gutenbergId || null,
        iaIdentifier: result.iaIdentifier || null,
        iaFile: result.iaFile || null,
        downloadUrl: result.downloadUrl || null,
        description: result.description || null,
        filePath: result.filePath || null,
        alternatives: lastSearchAlternatives.filter(a => a.hash !== result.hash).map(a => ({
          hash: a.hash,
          title: a.title,
          author: a.author,
          language: a.language || null,
          publisher: a.publisher || null,
          isbn: a.isbn || null,
          openLibraryWorkKey: a.openLibraryWorkKey || null,
          metadataConfidence: a.metadataConfidence || null,
          fallbackGroupId: a.fallbackGroupId || null,
          format: a.format,
          size: a.size,
          source: a.source || 'annas',
          url: a.url || null,
          rights: a.rights || a.reportedRights || null,
          license: a.license || a.licence || a.reportedLicense || null,
          zlibId: a.zlibId || null,
          gutenbergId: a.gutenbergId || null,
          iaIdentifier: a.iaIdentifier || null,
          iaFile: a.iaFile || null,
          downloadUrl: a.downloadUrl || null,
          description: a.description || null,
          filePath: a.filePath || null
        }))
      })
    });

    const started = await response.json();
    let data = started;
    if (response.status === 202 && started.jobId) {
      data = await waitForImportJob(started.jobId, result, downloadProgress);
    }

    if (response.status === 429 || data.code === 'ZLIB_DAILY_LIMIT' || data.code === 'ZLIB_RATE_LIMITED') {
      downloadProgress.stop();
      // Zlibrary daily limit reached — find Anna's alternative for same book
      const annasAlt = lastSearchAlternatives.find(a =>
        a.source === 'annas' && a.format === 'EPUB'
      );

      const fallbackBtn = annasAlt
        ? `<button class="btn-primary" style="margin-top:12px" data-download-action="fallback" data-result="${safeAttr(encodeState(annasAlt))}">Download from Anna's Archive</button>`
        : '';

      downloadError.innerHTML = `
        <div class="error-box">
          <h3>Z-Library Daily Limit Reached</h3>
          <p>${escapeHTML(data.error || 'You\'ve used all your Z-Library downloads for today.')}</p>
          <p class="error-suggestion">${escapeHTML(annasAlt ? 'This book is also available from Anna\'s Archive:' : (data.suggestion || 'Try downloading from Anna\'s Archive instead.'))}</p>
          ${fallbackBtn}
        </div>
      `;
      downloadError.style.display = 'block';
      searchResults.innerHTML = previousResultsHtml || searchResults.innerHTML;
      focusDownloadError();
      return;
    }

    if (isZLibraryConnectionRequired(data, result)) {
      downloadProgress.stop();
      renderZLibraryConnectionRequired(data, previousResultsHtml);
      return;
    }

    if (data.success) {
      await finishSuccessfulImport(data, { previousResultsHtml, downloadProgress });
    } else if (data.error) {
      downloadProgress.stop();
      // Validation failed - show error but keep search results visible
      const errorMsg = formatApiDetails(data.details, data.error);
      const retryButtons = renderDownloadRetryButtons(data.retryAlternatives);

      downloadError.innerHTML = `
        <div class="error-box">
          <h3>Warning: Download Failed</h3>
          <p><strong>Issue:</strong> ${escapeHTML(errorMsg)}</p>
          <p class="error-suggestion">${escapeHTML(data.suggestion || 'Try downloading a different version from the search results below.')}</p>
          ${retryButtons}
        </div>
      `;
      downloadError.style.display = 'block';
      searchResults.innerHTML = previousResultsHtml || '';
      focusDownloadError();
    }
  } catch (err) {
    downloadProgress.stop();
    console.error('Download failed:', err);
    if (isZLibraryConnectionRequired(err, result)) {
      renderZLibraryConnectionRequired(err, previousResultsHtml);
      return;
    }
    const errorMsg = formatApiDetails(err.details, err.error || err.message || 'Download failed');
    const retryButtons = renderDownloadRetryButtons(err.retryAlternatives);
    downloadError.innerHTML = `
      <div class="error-box">
        <h3>Warning: Download Failed</h3>
        <p><strong>Issue:</strong> ${escapeHTML(errorMsg)}</p>
        <p class="error-suggestion">${escapeHTML(err.suggestion || 'Try downloading a different version from the search results below.')}</p>
        ${retryButtons}
      </div>
    `;
    downloadError.style.display = 'block';
    searchResults.innerHTML = previousResultsHtml || '';
    focusDownloadError();
  }
}


function getSourceLabel(source) {
  if (source === 'zlibrary') return 'Z-Library';
  if (source === 'annas') return 'Anna\'s Archive';
  if (source === 'gutenberg') return 'Project Gutenberg';
  if (source === 'internetarchive') return 'Internet Archive';
  if (source === 'standardebooks') return 'Standard Ebooks';
  if (source === 'opds') return 'OPDS catalog';
  return 'Book source';
}


// Upload handler
async function uploadBookFile(file) {
  if (!file) return;

  // Show upload UI
  uploadProgress.style.display = 'block';
  uploadFilename.textContent = file.name;
  uploadStatus.textContent = 'Uploading...';
  uploadProgressFill.style.width = '0%';

  const formData = new FormData();
  formData.append('epub', file);

  try {
    const response = await fetch(`${API_BASE}/api/upload`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.success) {
      uploadStatus.textContent = 'Success! Adding to library...';
      uploadProgressFill.style.width = '100%';

      // Clear download error if any
      if (downloadError) {
        downloadError.style.display = 'none';
      }

      await finishSuccessfulImport(data);

      // Hide upload progress after delay
      setTimeout(() => {
        uploadProgress.style.display = 'none';
        if (fileInput) fileInput.value = ''; // Reset file input
      }, 2000);
    } else if (data.error) {
      // Validation failed
      const errorMsg = formatApiDetails(data.details, data.error);

      uploadStatus.textContent = 'Upload failed';
      uploadProgress.style.display = 'none';

      // Show error
      downloadError.innerHTML = `
        <div class="error-box">
          <h3>Warning: Upload Failed</h3>
          <p><strong>Issue:</strong> ${escapeHTML(errorMsg)}</p>
          <p class="error-suggestion">${escapeHTML(data.suggestion || 'Please try a different supported book file.')}</p>
        </div>
      `;
      downloadError.style.display = 'block';
      focusDownloadError();

      if (fileInput) fileInput.value = ''; // Reset file input
    }
  } catch (err) {
    console.error('Upload failed:', err);
    uploadStatus.textContent = 'Upload failed';
    uploadProgress.style.display = 'none';

    downloadError.innerHTML = `
      <div class="error-box">
        <h3>Warning: Upload Failed</h3>
        <p>An unexpected error occurred. Please try again.</p>
      </div>
    `;
    downloadError.style.display = 'block';
    focusDownloadError();

    if (fileInput) fileInput.value = ''; // Reset file input
  }
}

function handleFileSelect(event) {
  uploadBookFile(event.target.files?.[0]);
}

function setDropZoneActive(active) {
  dropZone?.classList.toggle('is-dragging', active);
}

function resetDropZoneDragState() {
  dragDepth = 0;
  setDropZoneActive(false);
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function handleDropZoneDragEnter(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  setDropZoneActive(true);
}

function handleDropZoneDragOver(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}

function handleDropZoneDragLeave(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropZoneActive(false);
}

function handleDropZoneDrop(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  resetDropZoneDragState();
  uploadBookFile(file);
}

export function initSearch(options = {}) {
  deps = options;
  searchInput = document.getElementById('search-input');
  searchBtn = document.getElementById('search-btn');
  searchResults = document.getElementById('search-results');
  downloadError = document.getElementById('download-error');
  languageFilter = document.getElementById('language-filter');
  uploadBtn = document.getElementById('upload-btn');
  dropZone = document.getElementById('book-drop-zone');
  fileInput = document.getElementById('file-input');
  uploadProgress = document.getElementById('upload-progress');
  uploadFilename = document.querySelector('.upload-filename');
  uploadStatus = document.querySelector('.upload-status');
  uploadProgressFill = document.querySelector('.upload-progress-fill');
  sourceControls = document.getElementById('search-source-controls');
  sourceReset = document.getElementById('search-source-reset');
  sourceMessage = document.getElementById('search-source-message');
  searchClearBtn = document.getElementById('search-clear-btn');
  filterToggle = document.getElementById('search-filter-toggle');
  filterPanel = document.getElementById('search-filter-panel');
  filterScrim = document.getElementById('search-filter-scrim');
  filterCloseBtn = document.getElementById('search-filter-close');
  filterApplyBtn = document.getElementById('search-filter-apply');
  filterCount = document.getElementById('search-filter-count');
  resultsCount = document.getElementById('search-results-count');
  searchSort = document.getElementById('search-sort');
  searchSortWrap = document.getElementById('search-sort-wrap');

  setFilterPanelExpanded(false, { moveFocus: false });

  loadSearchSources();

  searchBtn?.addEventListener('click', searchBooks);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchBooks();
  });
  searchInput?.addEventListener('input', syncSearchClearButton);
  searchClearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    clearRenderedSearchResults();
    updateSearchUrl('');
    if (downloadError) downloadError.style.display = 'none';
    syncSearchClearButton();
    setFilterPanelExpanded(false, { moveFocus: false });
    searchInput?.focus();
  });
  filterToggle?.addEventListener('click', () => {
    setFilterPanelExpanded(filterToggle.getAttribute('aria-expanded') !== 'true');
  });
  filterScrim?.addEventListener('click', () => setFilterPanelExpanded(false, { restoreFocus: true }));
  filterCloseBtn?.addEventListener('click', () => setFilterPanelExpanded(false, { restoreFocus: true }));
  filterApplyBtn?.addEventListener('click', () => {
    setFilterPanelExpanded(false);
    if (searchInput?.value.trim()) searchBooks();
    else searchInput?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && filterToggle?.getAttribute('aria-expanded') === 'true' && isMobileSearchLayout()) {
      event.preventDefault();
      setFilterPanelExpanded(false, { restoreFocus: true });
    }
  });
  const mobileSearchMedia = window.matchMedia(MOBILE_SEARCH_MEDIA);
  mobileSearchMedia.addEventListener?.('change', () => {
    setFilterPanelExpanded(false, { moveFocus: false });
  });
  languageFilter?.addEventListener('change', updateFilterSummary);
  searchSort?.addEventListener('change', renderSearchResults);
  sourceControls?.addEventListener('click', (e) => {
    const button = e.target.closest('[data-search-source]');
    if (!button || button.disabled || searchInProgress) return;
    const sourceId = button.dataset.searchSource;
    if (selectedSources.has(sourceId)) {
      if (configuredSourceIds().length === 1) {
        sourceSelectionMessage = 'Keep at least one source selected.';
        renderSourceShelf();
        return;
      }
      selectedSources.delete(sourceId);
    } else {
      selectedSources.add(sourceId);
    }
    sourceSelectionMessage = '';
    latestSourceStatus = {};
    renderSourceShelf();
  });
  sourceReset?.addEventListener('click', resetSourceShelf);
  document.addEventListener('xandrio:viewchange', (e) => {
    if (e.detail.view === 'search') resetSearchWorkspace();
    else setFilterPanelExpanded(false);
  });
  document.addEventListener('xandrio:client-settings', (e) => {
    if (e.detail.key === 'defaultSearchSources' || e.detail.key === '*') resetSourceShelf();
  });
  document.addEventListener('xandrio:search-sources-changed', loadSearchSources);
  document.addEventListener('click', (e) => {
    const importBtn = e.target.closest('[data-import-action]');
    if (importBtn && searchResults?.contains(importBtn)) {
      e.preventDefault();
      e.stopPropagation();
      if (importBtn.dataset.importAction === 'open-book' && importBtn.dataset.bookId) {
        deps.navigateTo?.('library');
        deps.openBook?.(importBtn.dataset.bookId);
      } else if (importBtn.dataset.importAction === 'restore-results') {
        searchResults.innerHTML = lastImportReviewResultsHtml || '';
      }
      return;
    }

    const loadMore = e.target.closest('[data-search-load-more]');
    if (loadMore && searchResults?.contains(loadMore)) {
      e.preventDefault();
      appendSearchResultBatch();
      return;
    }

    const workAction = e.target.closest('[data-work-add], [data-edition-choice]');
    if (workAction && searchResults?.contains(workAction)) {
      e.preventDefault();
      e.stopPropagation();
      const work = workById.get(workAction.dataset.workId);
      const editionIndex = Number(workAction.dataset.editionChoice || 0);
      const edition = work?.editions?.[editionIndex] || work?.bestEdition;
      if (edition) downloadBook(edition);
      return;
    }

    const downloadBtn = e.target.closest('[data-download-action]');
    if (downloadBtn && (searchResults?.contains(downloadBtn) || downloadError?.contains(downloadBtn))) {
      e.preventDefault();
      e.stopPropagation();
      if (downloadBtn.dataset.downloadAction === 'settings') {
        deps.navigateTo?.('settings');
        return;
      }
      if (downloadBtn.dataset.result) {
        downloadBookFromEncodedResult(downloadBtn.dataset.result);
      }
    }
  });
  uploadBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    fileInput?.click();
  });
  fileInput?.addEventListener('change', handleFileSelect);
  dropZone?.addEventListener('click', () => fileInput?.click());
  onActivate(dropZone, () => fileInput?.click());
  dropZone?.addEventListener('dragenter', handleDropZoneDragEnter);
  dropZone?.addEventListener('dragover', handleDropZoneDragOver);
  dropZone?.addEventListener('dragleave', handleDropZoneDragLeave);
  dropZone?.addEventListener('drop', handleDropZoneDrop);
  window.addEventListener('dragend', resetDropZoneDragState);
}
