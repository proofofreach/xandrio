import { apiGet, apiSend } from '../api.js';
import { showToast } from '../ui/toast.js';
import { registerSheet } from '../ui/sheets.js';

let deps = {};
let repairController = null;
let editingRule = null;

export function initPronunciationRepair(options = {}) {
  deps = options;
  const dialog = document.getElementById('pronunciation-repair-dialog');
  repairController = registerSheet(dialog, {
    closeBtn: document.getElementById('pronunciation-repair-cancel')
  });
  document.getElementById('pronunciation-repair-btn')?.addEventListener('click', openRepairDialog);
  document.getElementById('pronunciation-repair-form')?.addEventListener('submit', submitRepair);
  document.getElementById('pronunciation-existing-rules')?.addEventListener('click', handleRuleAction);
  const context = document.getElementById('pronunciation-repair-context');
  context?.addEventListener('pointerup', useSelectedContext);
  context?.addEventListener('keyup', useSelectedContext);
}

function currentContext() {
  const chapters = deps.getChapters?.() || [];
  const chapterIndex = deps.getCurrentChapter?.() || 0;
  const text = String(chapters[chapterIndex]?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const position = deps.getNarrationPosition?.() || {};
  const lengths = Array.isArray(position.textLengths) ? position.textLengths.map(value => Number(value) || 0) : [];
  let ratio = Math.max(0, Math.min(1, (Number(deps.getProgressPercent?.()) || 0) / 100));
  if (lengths.length && Number.isInteger(position.chunkIndex)) {
    const total = lengths.reduce((sum, value) => sum + value, 0);
    const before = lengths.slice(0, position.chunkIndex).reduce((sum, value) => sum + value, 0);
    const within = Number(position.chunkDuration) > 0
      ? Math.max(0, Math.min(1, Number(position.chunkTime) / Number(position.chunkDuration)))
      : 0;
    if (total > 0) ratio = (before + (lengths[position.chunkIndex] || 0) * within) / total;
  }
  const center = Math.floor(text.length * ratio);
  const start = Math.max(0, center - 100);
  const end = Math.min(text.length, center + 140);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function openRepairDialog() {
  const book = deps.getCurrentBook?.();
  const dialog = document.getElementById('pronunciation-repair-dialog');
  if (!book || !dialog) return;
  const context = document.getElementById('pronunciation-repair-context');
  if (context) context.textContent = currentContext() || 'Enter the word or phrase that sounded wrong.';
  const source = document.getElementById('pronunciation-source');
  const replacement = document.getElementById('pronunciation-replacement');
  editingRule = null;
  if (source) source.value = '';
  if (replacement) replacement.value = '';
  setSubmitLabel();
  repairController?.open();
  source?.focus();
  renderExistingRules(book.id);
}

function useSelectedContext() {
  const context = document.getElementById('pronunciation-repair-context');
  const selection = window.getSelection?.();
  if (!context || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!context.contains(range.commonAncestorContainer)) return;
  const phrase = selection.toString().replace(/\s+/g, ' ').trim();
  if (!phrase || phrase.length > 160) return;
  const source = document.getElementById('pronunciation-source');
  if (source) source.value = phrase;
}

function setSubmitLabel() {
  const submit = document.getElementById('pronunciation-repair-submit');
  if (submit) submit.textContent = editingRule ? 'Update and regenerate' : 'Save and regenerate';
  document.querySelectorAll('input[name="pronunciation-scope"]').forEach(input => {
    input.disabled = Boolean(editingRule);
  });
}

function closeRepairDialog() {
  repairController?.dismiss();
}

async function submitRepair(event) {
  event.preventDefault();
  const book = deps.getCurrentBook?.();
  if (!book) return;
  const source = document.getElementById('pronunciation-source')?.value?.trim();
  const replacement = document.getElementById('pronunciation-replacement')?.value?.trim();
  const scope = document.querySelector('input[name="pronunciation-scope"]:checked')?.value || 'book';
  if (!source || !replacement) {
    showToast('Enter both the original phrase and how it should be spoken', 'error');
    return;
  }

  const submit = document.getElementById('pronunciation-repair-submit');
  if (submit) submit.disabled = true;
  try {
    const payload = {
      scope,
      bookId: scope === 'book' ? book.id : undefined,
      source,
      replacement,
      wholeWord: true
    };
    const result = editingRule
      ? await apiSend('PUT', `/api/pronunciations/${encodeURIComponent(editingRule.id)}`, payload)
      : await apiSend('POST', '/api/pronunciations', payload);
    closeRepairDialog();
    const affected = Array.isArray(result.affected) ? result.affected.length : 0;
    showToast(`Pronunciation ${editingRule ? 'updated' : 'saved'}${affected ? ` · ${affected} chapter${affected === 1 ? '' : 's'} will regenerate` : ''}`);
    editingRule = null;
    await deps.reloadCurrentChapter?.();
  } catch (err) {
    showToast(err.message || 'Failed to save pronunciation', 'error');
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function renderExistingRules(bookId) {
  const container = document.getElementById('pronunciation-existing-rules');
  if (!container) return;
  container.textContent = 'Loading saved pronunciations…';
  try {
    const rules = await apiGet(`/api/pronunciations?bookId=${encodeURIComponent(bookId)}`);
    const entries = [
      ...(rules.book || []).map(rule => ({ ...rule, scope: 'book' })),
      ...(rules.global || []).map(rule => ({ ...rule, scope: 'global' }))
    ];
    container.replaceChildren();
    if (!entries.length) {
      container.textContent = 'No saved pronunciations for this book.';
      return;
    }
    for (const rule of entries) {
      const row = document.createElement('div');
      row.className = 'pronunciation-rule-row';
      const copy = document.createElement('span');
      copy.textContent = `${rule.source} → ${rule.replacement} · ${rule.scope === 'book' ? 'this book' : 'every book'}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-ghost btn-sm';
      remove.textContent = 'Remove';
      remove.dataset.pronunciationRuleId = rule.id;
      remove.dataset.scope = rule.scope;
      remove.dataset.bookId = bookId;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-ghost btn-sm';
      edit.textContent = 'Edit';
      edit.dataset.pronunciationEdit = rule.id;
      edit.dataset.scope = rule.scope;
      edit.dataset.bookId = bookId;
      edit.dataset.source = rule.source;
      edit.dataset.replacement = rule.replacement;
      const actions = document.createElement('span');
      actions.className = 'pronunciation-rule-actions';
      actions.append(edit, remove);
      row.append(copy, actions);
      container.append(row);
    }
  } catch (err) {
    container.textContent = err.message || 'Saved pronunciations are unavailable.';
  }
}

function handleRuleAction(event) {
  const edit = event.target.closest('[data-pronunciation-edit]');
  if (edit) {
    editingRule = { id: edit.dataset.pronunciationEdit };
    const source = document.getElementById('pronunciation-source');
    const replacement = document.getElementById('pronunciation-replacement');
    if (source) source.value = edit.dataset.source || '';
    if (replacement) replacement.value = edit.dataset.replacement || '';
    const scope = document.querySelector(`input[name="pronunciation-scope"][value="${edit.dataset.scope}"]`);
    if (scope) scope.checked = true;
    setSubmitLabel();
    source?.focus();
    return;
  }
  removeRule(event);
}

async function removeRule(event) {
  const button = event.target.closest('[data-pronunciation-rule-id]');
  if (!button) return;
  const query = new URLSearchParams({ scope: button.dataset.scope });
  if (button.dataset.scope === 'book') query.set('bookId', button.dataset.bookId);
  button.disabled = true;
  try {
    await apiSend('DELETE', `/api/pronunciations/${encodeURIComponent(button.dataset.pronunciationRuleId)}?${query}`);
    await renderExistingRules(button.dataset.bookId);
    showToast('Pronunciation removed');
    await deps.reloadCurrentChapter?.();
  } catch (err) {
    button.disabled = false;
    showToast(err.message || 'Failed to remove pronunciation', 'error');
  }
}
