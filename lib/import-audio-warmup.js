function chapterOrder(chapterCount, preferredIndex) {
  const start = Math.max(0, Math.min(chapterCount - 1, Number(preferredIndex) || 0));
  const order = [];
  for (let index = start; index < chapterCount; index += 1) order.push(index);
  for (let index = 0; index < start; index += 1) order.push(index);
  return order;
}

function createImportAudioWarmup({
  getChapters,
  preferredStartIndex = () => 0,
  generateChapter,
  onProgress = async () => undefined
} = {}) {
  if (typeof getChapters !== 'function' || typeof generateChapter !== 'function') {
    throw new Error('Import audio warm-up requires chapter loading and generation');
  }

  async function generate({ bookId, bookPath, language = 'en', voice } = {}) {
    if (!bookId || !bookPath) throw new Error('Import audio warm-up requires a book');
    const chapters = await getChapters(bookPath);
    const totalChapters = chapters.length;
    const order = chapterOrder(totalChapters, preferredStartIndex(chapters));
    let generatedChapters = 0;
    let warmedChapterIndex = null;

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
          priority: 'background'
        });
        generatedChapters += 1;
        warmedChapterIndex = chapterIndex;
        await onProgress({
          bookId,
          state: 'generating',
          generatedChapters,
          totalChapters,
          warmedChapterIndex
        });
        break;
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
      state: 'partial',
      generatedChapters,
      totalChapters,
      warmedChapterIndex
    };
    await onProgress(result);
    return result;
  }

  return { generate };
}

module.exports = {
  chapterOrder,
  createImportAudioWarmup
};
