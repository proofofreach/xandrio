import { apiGet, apiSend, getCurrentUser } from '../api.js';
import { escapeHTML, safeAttr } from '../util/format.js';
import { showToast } from '../ui/toast.js';
import { confirmSheet } from '../ui/confirm.js';

let deps = {};
let guideView = null;
let guideBody = null;
let guideBookMeta = null;
let activeBookId = null;
let guideData = null;
let requestToken = 0;
let pollTimer = null;
let lastSectionKey = null;

const LAST_SECTION_PREFIX = 'xandrio_book_guide_section:';
const GENERATING_STATUSES = new Set(['queued', 'generating', 'processing', 'verifying']);

function currentBook() {
  return deps.getCurrentBook?.() || null;
}

function isAdmin() {
  const user = getCurrentUser();
  // Trusted-LAN instances can run without account sessions. In that mode the
  // server is the authority; a signed-in non-admin is always read-only here.
  return !user || user.role === 'admin';
}

function guidePath(bookId) {
  return `/api/book/${encodeURIComponent(bookId)}/guide`;
}

function statusLabel(status) {
  switch (status) {
    case 'ready': return 'Ready';
    case 'stale': return 'Needs refresh';
    case 'queued': return 'Queued';
    case 'generating': return 'Creating guide';
    case 'processing': return 'Creating guide';
    case 'verifying': return 'Checking evidence';
    case 'error': return 'Could not create guide';
    case 'unavailable': return 'Unavailable';
    default: return status ? String(status) : 'Not created';
  }
}

function isGenerating(data) {
  return GENERATING_STATUSES.has(String(data?.status || '').toLowerCase());
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.text || value.content || value.label || '';
  return String(value);
}

function anchorList(value) {
  const anchors = guideData?.artifact?.anchors || guideData?.anchors || {};
  const resolve = candidate => {
    if (typeof candidate === 'string') return anchors[candidate] || null;
    if (!candidate || typeof candidate !== 'object') return null;
    if (Array.isArray(candidate.anchorIds)) return candidate.anchorIds.map(resolve).filter(Boolean);
    if (candidate.anchorId) return { ...(anchors[candidate.anchorId] || {}), ...candidate };
    return candidate;
  };
  return normalizeList(value).flatMap(resolve).filter(anchor => anchor && typeof anchor === 'object');
}

function anchorButton(anchor, label = 'Go to source') {
  const id = anchor.id || anchor.anchorId || '';
  if (!id) return '';
  const chapter = Number.isInteger(anchor.chapterIndex) ? anchor.chapterIndex + 1 : null;
  const suffix = chapter ? ` · Chapter ${chapter}` : '';
  const invalid = normalizeList(guideData?.invalidAnchorIds).map(String).includes(String(id));
  return `<button class="guide-source-link" type="button" data-guide-anchor="${safeAttr(id)}" aria-label="${safeAttr(`${invalid ? 'Source unavailable' : label}${suffix}`)}"${invalid ? ' disabled' : ''}>${escapeHTML(invalid ? 'Source unavailable' : label)}${chapter ? `<span>Chapter ${chapter}</span>` : ''}</button>`;
}

function anchorButtons(value) {
  return anchorList(value).map(anchor => anchorButton(anchor)).join('');
}

function sectionHeading(id, title, body) {
  if (!body) return '';
  return `<section class="guide-section" id="${safeAttr(id)}" data-guide-section="${safeAttr(id)}">
    <h3>${escapeHTML(title)}</h3>${body}
  </section>`;
}

function overviewHTML(artifact) {
  const overview = artifact.overview || artifact.orientation || {};
  const thesis = text(overview.thesis || artifact.thesis);
  const problem = text(overview.problem || overview.question);
  const bottomLine = text(overview.bottomLine || overview.summary);
  const takeaways = normalizeList(overview.takeaways || artifact.takeaways).map(item => `<li>${escapeHTML(text(item))}${anchorButtons(item?.anchorIds || item?.anchorId)}</li>`).join('');
  if (!thesis && !problem && !bottomLine && !takeaways) return '';
  return sectionHeading('guide-overview', 'Quick orientation', `
    ${thesis ? `<p class="guide-thesis">${escapeHTML(thesis)}</p>${anchorButtons(overview.thesis?.anchorIds)}` : ''}
    ${problem ? `<p><strong>Question:</strong> ${escapeHTML(problem)}</p>${anchorButtons(overview.problem?.anchorIds)}` : ''}
    ${takeaways ? `<h4>Key takeaways</h4><ul class="guide-takeaways">${takeaways}</ul>` : ''}
    ${bottomLine ? `<p class="guide-bottom-line"><strong>Bottom line:</strong> ${escapeHTML(bottomLine)}</p>${anchorButtons(overview.bottomLine?.anchorIds)}` : ''}
  `);
}

function conceptHTML(concept, index) {
  const title = text(concept.title || concept.name || `Idea ${index + 1}`);
  const claim = text(concept.claim || concept.summary);
  const mechanism = text(concept.mechanism || concept.howItWorks);
  const evidence = text(concept.support || concept.evidence || concept.examples);
  const qualification = text(concept.qualification || concept.qualifications || concept.limitations);
  const implication = text(concept.implications || concept.implication || concept.application);
  return `<article class="guide-concept-card">
    <h4>${escapeHTML(title)}</h4>
    ${claim ? `<p class="guide-concept-claim">${escapeHTML(claim)}</p>` : ''}
    ${mechanism ? `<p><strong>How it works:</strong> ${escapeHTML(mechanism)}</p>` : ''}
    ${evidence ? `<p><strong>Evidence:</strong> ${escapeHTML(evidence)}</p>` : ''}
    ${qualification ? `<p><strong>Qualification:</strong> ${escapeHTML(qualification)}</p>` : ''}
    ${implication ? `<p><strong>Implication:</strong> ${escapeHTML(implication)}</p>` : ''}
    <div class="guide-source-links">${anchorButtons(concept.anchorIds || concept.anchorId || concept.anchors || concept.sources)}</div>
  </article>`;
}

function conceptsHTML(artifact) {
  const concepts = normalizeList(artifact.concepts || artifact.coreIdeas);
  if (!concepts.length) return '';
  return sectionHeading('guide-concepts', 'Core ideas', `<div class="guide-concepts">${concepts.map(conceptHTML).join('')}</div>`);
}

function chapterHTML(chapter, index) {
  const chapterNumber = Number.isInteger(chapter.chapterIndex) ? chapter.chapterIndex + 1 : index + 1;
  const title = text(chapter.title || `Chapter ${chapterNumber}`);
  const purpose = text(chapter.purpose || chapter.summary || chapter.contribution);
  const concepts = normalizeList(chapter.concepts || chapter.keyIdeas).map(item => text(item)).filter(Boolean);
  const contributions = normalizeList(chapter.contributions).map(item => text(item)).filter(Boolean);
  const skipped = Boolean(chapter.skipped || chapter.status === 'skipped');
  const skipReason = text(chapter.skipReason || chapter.reason);
  return `<article class="guide-chapter-card${skipped ? ' guide-chapter-card--skipped' : ''}">
    <div class="guide-chapter-title"><span>Chapter ${chapterNumber}</span><h4>${escapeHTML(title)}</h4></div>
    ${skipped ? `<p>${escapeHTML(skipReason || 'This section is not part of the study guide.')}</p>` : ''}
    ${!skipped && purpose ? `<p>${escapeHTML(purpose)}</p>` : ''}
    ${!skipped && contributions.length ? `<ul>${contributions.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>` : ''}
    ${!skipped && concepts.length ? `<ul>${concepts.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>` : ''}
    <div class="guide-source-links">${anchorButtons(chapter.anchorIds || chapter.anchorId || chapter.anchors || chapter.sources)}</div>
  </article>`;
}

function chaptersHTML(artifact) {
  const chapters = normalizeList(artifact.chapterMap || artifact.chapters);
  if (!chapters.length) return '';
  return sectionHeading('guide-chapters', 'Chapter map', `<div class="guide-chapters">${chapters.map(chapterHTML).join('')}</div>`);
}

function recallHTML(question, index) {
  const prompt = text(question.question || question.prompt || `Question ${index + 1}`);
  const answer = text(question.answer || question.response);
  return `<article class="guide-recall-card">
    <h4>${escapeHTML(prompt)}</h4>
    ${answer ? `<details><summary>Reveal answer</summary><p>${escapeHTML(answer)}</p><div class="guide-source-links">${anchorButtons(question.anchorIds || question.anchorId || question.anchors || question.sources)}</div></details>` : ''}
  </article>`;
}

function recallHTMLSection(artifact) {
  const questions = normalizeList(artifact.recallQuestions || artifact.questions || artifact.activeRecall || artifact.review?.questions);
  if (!questions.length) return '';
  const explanations = normalizeList(artifact.review?.selfExplanationPrompts)
    .map(item => `<li>${escapeHTML(text(item))}</li>`).join('');
  return sectionHeading('guide-recall', 'Active review', `<p class="guide-section-intro">Try each prompt before revealing the answer.</p><div class="guide-recall">${questions.map(recallHTML).join('')}</div>${explanations ? `<h4>Explain it yourself</h4><ul>${explanations}</ul>` : ''}`);
}

function generationAttestation(data) {
  return `${generationDisclosure(data)}<p id="guide-action-error" class="settings-error" hidden></p>`;
}

function passagesHTML(artifact) {
  const passages = normalizeList(artifact.keyPassages || artifact.passages || artifact.quotes);
  if (!passages.length) return '';
  const cards = passages.map((passage, index) => {
    const excerpt = text(passage.excerpt || passage.quote || passage.text);
    const note = text(passage.note || passage.explanation || passage.relevance);
    return `<article class="guide-passage-card">
      ${excerpt ? `<blockquote>${escapeHTML(excerpt)}</blockquote>` : `<h4>Passage ${index + 1}</h4>`}
      ${note ? `<p>${escapeHTML(note)}</p>` : ''}
      <div class="guide-source-links">${anchorButtons(passage.anchorIds || passage.anchorId || passage.anchors || passage.sources)}</div>
    </article>`;
  }).join('');
  return sectionHeading('guide-passages', 'Key passages', `<div class="guide-passages">${cards}</div>`);
}

function renderSourceContext() {
  const context = guideData?.sourceContext;
  if (!context) return '';
  const title = text(context.chapterTitle || context.title || 'Source context');
  const snippet = text(context.snippet || context.context || context.text);
  if (!snippet) return '';
  return `<aside class="guide-source-context" aria-live="polite"><strong>${escapeHTML(title)}</strong><p>${escapeHTML(snippet)}</p></aside>`;
}

function renderGuide(artifact) {
  const guide = artifact?.guide || artifact;
  return `${overviewHTML(guide)}${conceptsHTML(guide)}${chaptersHTML(guide)}${recallHTMLSection(guide)}${passagesHTML(guide)}${renderSourceContext()}`;
}

function generationDisclosure(data) {
  const destination = text(data?.localDestination || data?.generation?.destination);
  const generator = text(data?.generatorModel || data?.generation?.generatorModel);
  const verifier = text(data?.verifierModel || data?.generation?.verifierModel);
  const duration = text(data?.estimatedDuration || data?.generation?.estimatedDuration);
  const cost = text(data?.estimatedCost || data?.generation?.estimatedCost);
  const uncertified = data?.generation && data.generation.certified === false;
  const details = [
    uncertified && 'Uncertified evaluation run',
    destination && `External destination: ${destination}`,
    generator && `Generator: ${generator}`,
    verifier && `Verifier: ${verifier}`,
    duration && `Estimated time: ${duration}`,
    cost && `Estimated cost: ${cost}`
  ].filter(Boolean);
  return details.length ? `<p class="guide-generation-disclosure">${escapeHTML(details.join(' · '))}</p>` : '';
}

function guideManagementActions(data) {
  if (!isAdmin() || data?.canManage === false) return '';
  return '<div class="guide-admin-actions"><button class="btn-ghost btn-sm btn-ghost-danger" type="button" data-guide-delete>Delete guide</button></div>';
}

function statusHTML(data) {
  const status = String(data?.status || 'unavailable').toLowerCase();
  const message = text(data?.message || data?.error || data?.reason);
  const canGenerate = Boolean(data?.canGenerate) && isAdmin();
  if (data?.artifact && !data?.featureEnabled) {
    return `<section class="guide-stale" aria-live="polite"><strong>Guide generation is disabled.</strong><span>This previously verified guide remains available.</span></section>${renderGuide(data.artifact)}${guideManagementActions(data)}`;
  }
  if (!data?.featureEnabled || status === 'disabled' || status === 'unavailable') {
    return `<section class="guide-state" data-state="unavailable"><h3>Study guides are unavailable</h3><p>${escapeHTML(message || 'This instance has not enabled Book Guides.')}</p></section>`;
  }
  if (isGenerating(data)) {
    const progress = Number(data?.progress?.percent ?? data?.progressPercent);
    const detail = text(data?.progress?.detail || data?.progress?.stage || message || 'Extracting ideas and checking them against the book.');
    return `<section class="guide-state" data-state="generating" aria-live="polite">
      <span class="guide-spinner" aria-hidden="true"></span><h3>${escapeHTML(statusLabel(status))}</h3><p>${escapeHTML(detail)}</p>
      ${Number.isFinite(progress) ? `<div class="guide-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, Math.min(100, progress))}"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>` : ''}
      ${canGenerate ? '<button class="btn-ghost btn-sm" type="button" data-guide-cancel>Cancel generation</button>' : ''}
    </section>`;
  }
  if (status === 'error') {
    return `<section class="guide-state" data-state="error"><h3>Could not create the guide</h3><p>${escapeHTML(message || 'No replacement guide was published. You can try again when the issue is resolved.')}</p>${canGenerate ? `${generationAttestation(data)}<button class="btn-primary" type="button" data-guide-generate>Try again</button>` : ''}</section>${data?.artifact ? renderGuide(data.artifact) + guideManagementActions(data) : ''}`;
  }
  if (status === 'stale' && data?.artifact) {
    return `<section class="guide-stale" aria-live="polite"><strong>Guide may be out of date.</strong><span>${escapeHTML(message || 'The book changed after this guide was generated.')}</span>${canGenerate ? `${generationAttestation(data)}<button class="btn-ghost btn-sm" type="button" data-guide-generate>Refresh guide</button>` : ''}</section>${renderGuide(data.artifact)}${guideManagementActions(data)}`;
  }
  if (data?.artifact) return `${renderGuide(data.artifact)}${guideManagementActions(data)}`;
  if (!canGenerate) {
    return `<section class="guide-state" data-state="unavailable"><h3>No study guide yet</h3><p>${escapeHTML(message || 'An administrator can create a guide for this book.')}</p></section>`;
  }
  return `<section class="guide-state" data-state="empty">
    <h3>Create a study guide</h3>
    <p>Guides organize the book’s claims, chapter map, and active-review prompts with source links.</p>
    ${generationAttestation(data)}
    <button class="btn-primary" type="button" data-guide-generate>Create study guide</button>
  </section>`;
}

function setLastSection(sectionId) {
  if (!activeBookId || !sectionId) return;
  lastSectionKey = sectionId;
  try { localStorage.setItem(`${LAST_SECTION_PREFIX}${activeBookId}`, sectionId); } catch {}
}

function restoreLastSection() {
  if (!activeBookId) return;
  let sectionId = '';
  try { sectionId = localStorage.getItem(`${LAST_SECTION_PREFIX}${activeBookId}`) || ''; } catch {}
  if (!sectionId) return;
  requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: 'start' }));
}

function attachInteractions() {
  guideBody?.querySelector('[data-guide-generate]')?.addEventListener('click', generateGuide);
  guideBody?.querySelector('[data-guide-cancel]')?.addEventListener('click', cancelGuide);
  guideBody?.querySelector('[data-guide-delete]')?.addEventListener('click', deleteGuide);
  guideBody?.querySelectorAll('[data-guide-anchor]').forEach(button => {
    button.addEventListener('click', () => jumpToAnchor(button.dataset.guideAnchor, button));
  });
  guideBody?.querySelectorAll('[data-guide-section]').forEach(section => {
    section.addEventListener('focusin', () => setLastSection(section.id));
  });
}

function render(data) {
  guideData = data || {};
  const showEntry = Boolean(guideData.featureEnabled || guideData.artifact);
  document.getElementById('guide-btn')?.toggleAttribute('hidden', !showEntry);
  document.getElementById('utility-guide-btn')?.toggleAttribute('hidden', !showEntry);
  if (!guideBody) return;
  const book = currentBook();
  if (guideBookMeta) guideBookMeta.textContent = [book?.title, book?.author ? `by ${book.author}` : ''].filter(Boolean).join(' · ');
  guideBody.setAttribute('aria-busy', isGenerating(guideData) ? 'true' : 'false');
  guideBody.innerHTML = statusHTML(guideData);
  attachInteractions();
  if (isGenerating(guideData)) startPolling();
  else stopPolling();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => refreshGuideState(), 3000);
}

function errorText(message) {
  const target = guideBody?.querySelector('#guide-action-error');
  if (!target) return;
  target.textContent = message;
  target.hidden = !message;
}

export async function refreshGuideState(requestedBookId = null) {
  const book = currentBook();
  const bookId = requestedBookId || activeBookId || book?.id;
  if (!bookId) return;
  const token = ++requestToken;
  try {
    const data = await apiGet(guidePath(bookId));
    if (token !== requestToken || String(bookId) !== String(activeBookId || bookId)) return;
    render(data);
  } catch (error) {
    if (token !== requestToken) return;
    render({ featureEnabled: true, status: 'error', message: navigator.onLine === false ? 'Study guides need a connection.' : error.message });
  }
}

export async function openBookGuide(bookId = currentBook()?.id) {
  if (!bookId) return;
  activeBookId = String(bookId);
  guideView?.classList.add('active');
  if (guideBody) guideBody.focus({ preventScroll: true });
  await refreshGuideState();
  restoreLastSection();
}

export function closeBookGuide() {
  stopPolling();
  requestToken += 1;
}

async function generateGuide() {
  if (!activeBookId || !isAdmin()) return;
  errorText('');
  try {
    await apiSend('POST', guidePath(activeBookId));
    await refreshGuideState();
  } catch (error) {
    errorText(error.message || 'Could not start guide generation.');
  }
}

async function cancelGuide() {
  if (!activeBookId || !isAdmin()) return;
  try {
    await apiSend('POST', `${guidePath(activeBookId)}/cancel`);
    showToast('Guide generation cancelled');
    await refreshGuideState();
  } catch (error) {
    showToast(error.message || 'Could not cancel guide generation', 'error');
  }
}

async function deleteGuide() {
  if (!activeBookId || !isAdmin()) return;
  const confirmed = await confirmSheet({
    title: 'Delete study guide?',
    message: 'This removes the shared guide. It does not change the book or playback.',
    confirmLabel: 'Delete guide'
  });
  if (!confirmed) return;
  try {
    await apiSend('DELETE', guidePath(activeBookId));
    showToast('Study guide deleted');
    await refreshGuideState();
  } catch (error) {
    showToast(error.message || 'Could not delete study guide', 'error');
  }
}

async function jumpToAnchor(anchorId, sourceButton = null) {
  const artifact = guideData?.artifact || {};
  const guide = artifact.guide || artifact;
  const allAnchors = [
    ...Object.values(artifact.anchors || {}),
    ...normalizeList(guide.concepts || guide.coreIdeas).flatMap(item => anchorList(item.anchorIds || item.anchorId || item.anchors || item.sources)),
    ...normalizeList(guide.chapterMap || guide.chapters).flatMap(item => anchorList(item.anchorIds || item.anchorId || item.anchors || item.sources)),
    ...normalizeList(guide.recallQuestions || guide.questions || guide.activeRecall || guide.review?.questions).flatMap(item => anchorList(item.anchorIds || item.anchorId || item.anchors || item.sources)),
    ...normalizeList(guide.keyPassages || guide.passages || guide.quotes).flatMap(item => anchorList(item.anchorIds || item.anchorId || item.anchors || item.sources))
  ];
  let anchor = artifact.anchors?.[anchorId] || allAnchors.find(item => String(item.id || item.anchorId) === String(anchorId));
  if (!anchor || !activeBookId) return;
  try {
    const context = await apiGet(`${guidePath(activeBookId)}/anchors/${encodeURIComponent(anchorId)}/context`);
    guideData = { ...guideData, sourceContext: context };
    anchor = { ...anchor, ...context, ...(context?.anchor || {}) };
  } catch (error) {
    if (sourceButton) {
      sourceButton.disabled = true;
      sourceButton.firstChild.textContent = 'Source unavailable';
    }
    showToast(error.message || 'Could not verify this source location', 'error');
    return;
  }
  if (!Number.isInteger(anchor.chapterIndex)) {
    showToast('This source location is unavailable.', 'error');
    return;
  }
  const options = { commitImmediately: true };
  // Only use a canonical audio offset. Character offsets are evidence anchors,
  // not playback positions.
  if (Number.isFinite(Number(anchor.audioSeconds)) && Number(anchor.audioSeconds) >= 0) {
    options.seekToSeconds = Number(anchor.audioSeconds);
  }
  try {
    await deps.selectChapter?.(anchor.chapterIndex, options);
    deps.navigateTo?.('player', activeBookId);
  } catch (error) {
    showToast(error.message || 'Could not open source chapter', 'error');
  }
}

export function initBookGuide(options = {}) {
  deps = options;
  guideView = document.getElementById('guide-view');
  guideBody = document.getElementById('guide-body');
  guideBookMeta = document.getElementById('guide-book-meta');
  document.getElementById('guide-back-btn')?.addEventListener('click', () => {
    const bookId = activeBookId || currentBook()?.id;
    if (bookId) deps.navigateTo?.('player', bookId);
  });
  document.getElementById('guide-btn')?.addEventListener('click', () => {
    const bookId = currentBook()?.id;
    if (bookId) deps.navigateTo?.('guide', bookId);
  });
  document.getElementById('utility-guide-btn')?.addEventListener('click', () => {
    const bookId = currentBook()?.id;
    if (bookId) deps.navigateTo?.('guide', bookId);
  });
  document.addEventListener('xandrio:viewchange', event => {
    if (event.detail?.view === 'guide') return;
    closeBookGuide();
  });
}
