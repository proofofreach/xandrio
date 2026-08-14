'use strict';

const crypto = require('node:crypto');

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return text(value.text || value.content || value.label);
  return String(value).trim();
}

function sentence(label, value) {
  const content = text(value);
  return content ? `${label} ${content}` : '';
}

function section(id, title, parts, guideSectionId) {
  const body = parts.flat(Infinity).map(text).filter(Boolean).join('\n\n');
  return body ? { id, title, text: `${title}.\n\n${body}`, guideSectionId } : null;
}

function buildBookGuideNarration(artifact) {
  const guide = artifact?.guide || artifact || {};
  const result = [];
  const orientation = guide.overview || guide.orientation || {};
  const overview = section('overview', 'Book in brief', [
    sentence('Central argument.', orientation.thesis || guide.thesis),
    sentence('The question the book addresses.', orientation.problem || orientation.question),
    array(orientation.takeaways || guide.takeaways).map((item, index) =>
      sentence(`Takeaway ${index + 1}.`, item)
    ),
    sentence('Bottom line.', orientation.bottomLine || orientation.summary)
  ], 'guide-overview');
  if (overview) result.push(overview);

  array(guide.concepts || guide.coreIdeas).forEach((concept, index) => {
    const title = text(concept.title || concept.name) || `Core idea ${index + 1}`;
    const item = section(`concept-${index + 1}`, title, [
      text(concept.claim || concept.summary),
      sentence('How it works.', concept.mechanism || concept.howItWorks),
      sentence('Evidence.', concept.support || concept.evidence || concept.examples),
      sentence('Qualification.', concept.qualification || concept.qualifications || concept.limitations),
      sentence('Implication.', concept.implications || concept.implication || concept.application)
    ], 'guide-concepts');
    if (item) result.push(item);
  });

  array(guide.chapterMap || guide.chapters).forEach((chapter, index) => {
    if (chapter.skipped || chapter.status === 'skipped') return;
    const chapterNumber = Number.isInteger(chapter.chapterIndex) ? chapter.chapterIndex + 1 : index + 1;
    const chapterTitle = text(chapter.title) || `Chapter ${chapterNumber}`;
    const item = section(`chapter-${chapterNumber}`, `Chapter ${chapterNumber}: ${chapterTitle}`, [
      text(chapter.purpose || chapter.summary || chapter.contribution),
      array(chapter.contributions).map((value, contributionIndex) =>
        sentence(`Contribution ${contributionIndex + 1}.`, value)
      ),
      array(chapter.concepts || chapter.keyIdeas).map((value, conceptIndex) =>
        sentence(`Key idea ${conceptIndex + 1}.`, value)
      )
    ], 'guide-chapters');
    if (item) result.push(item);
  });

  const questions = array(guide.recallQuestions || guide.questions || guide.activeRecall || guide.review?.questions);
  const prompts = array(guide.review?.selfExplanationPrompts);
  const review = section('active-review', 'Active review', [
    questions.length ? 'Pause after each question if you want time to answer before hearing the response.' : '',
    questions.flatMap((question, index) => [
      sentence(`Question ${index + 1}.`, question.question || question.prompt),
      sentence('Answer.', question.answer || question.response)
    ]),
    prompts.map((prompt, index) => sentence(`Explain it yourself, prompt ${index + 1}.`, prompt))
  ], 'guide-recall');
  if (review) result.push(review);

  const passageNotes = array(guide.keyPassages || guide.passages || guide.quotes)
    .map((passage, index) => sentence(`Key passage ${index + 1}.`, passage.note || passage.explanation || passage.relevance))
    .filter(Boolean);
  const passages = section('key-passages', 'Key passages', passageNotes, 'guide-passages');
  if (passages) result.push(passages);

  return result;
}

function narrationBookPrefix(bookId) {
  const bookDigest = crypto.createHash('sha256').update(String(bookId)).digest('hex').slice(0, 12);
  return `guide_${bookDigest}_`;
}

function narrationArtifactId(bookId, artifact) {
  const artifactIdentity = JSON.stringify({
    createdAt: artifact?.createdAt || '',
    source: artifact?.source || {},
    recipe: artifact?.recipe || {},
    verification: artifact?.verification?.verifiedAt || '',
    guide: artifact?.guide || {}
  });
  const artifactDigest = crypto.createHash('sha256').update(artifactIdentity).digest('hex').slice(0, 12);
  return `${narrationBookPrefix(bookId)}${artifactDigest}`;
}

function publicNarrationManifest(bookId, artifact) {
  const sections = buildBookGuideNarration(artifact).map(({ id, title, guideSectionId }) => ({
    id,
    title,
    guideSectionId
  }));
  const version = narrationArtifactId(bookId, artifact).split('_').at(-1);
  return { available: sections.length > 0, version, sections };
}

module.exports = {
  buildBookGuideNarration,
  narrationArtifactId,
  narrationBookPrefix,
  publicNarrationManifest
};
