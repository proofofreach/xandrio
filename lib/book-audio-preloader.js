function chapterOrder(chapterCount, preferredIndex) {
  const start = Math.max(0, Math.min(chapterCount - 1, Number(preferredIndex) || 0));
  const order = [];
  for (let index = start; index < chapterCount; index += 1) order.push(index);
  for (let index = 0; index < start; index += 1) order.push(index);
  return order;
}

function booksNeedingAudioBackfill(books, isDeleted = () => false) {
  return Object.values(books || {})
    .filter(book =>
      book?.id &&
      book?.path &&
      book.audioGenerationState !== 'ready' &&
      !isDeleted(book.id)
    )
    .sort((left, right) => {
      const leftAdded = Date.parse(left.addedAt || '') || 0;
      const rightAdded = Date.parse(right.addedAt || '') || 0;
      return rightAdded - leftAdded;
    });
}

function createBookAudioPreloader({
  getChapters,
  preferredStartIndex = () => 0,
  generateChapter,
  onProgress = async () => undefined
} = {}) {
  if (typeof getChapters !== 'function' || typeof generateChapter !== 'function') {
    throw new Error('Book audio preloader requires chapter loading and generation');
  }

  async function generate({ bookId, bookPath, language = 'en', voice } = {}) {
    if (!bookId || !bookPath) throw new Error('Book audio preloader requires a book');
    const chapters = await getChapters(bookPath);
    const totalChapters = chapters.length;
    const order = chapterOrder(totalChapters, preferredStartIndex(chapters));
    let generatedChapters = 0;

    await onProgress({
      bookId,
      state: 'generating',
      generatedChapters,
      totalChapters
    });

    try {
      for (const chapterIndex of order) {
        const chapter = chapters[chapterIndex];
        if (!String(chapter?.text || '').trim()) continue;
        await generateChapter({
          bookId,
          chapterIndex,
          chapter,
          language,
          voice,
          priority: generatedChapters < 2 ? 'immediate' : 'background'
        });
        generatedChapters += 1;
        await onProgress({
          bookId,
          state: 'generating',
          generatedChapters,
          totalChapters
        });
      }
    } catch (error) {
      await onProgress({
        bookId,
        state: 'error',
        generatedChapters,
        totalChapters,
        error: error.message
      });
      throw error;
    }

    const result = {
      bookId,
      state: 'ready',
      generatedChapters,
      totalChapters
    };
    await onProgress(result);
    return result;
  }

  return { generate };
}

module.exports = {
  booksNeedingAudioBackfill,
  chapterOrder,
  createBookAudioPreloader
};
