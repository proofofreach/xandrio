const SHORT_BOOK_WARNING_CHARS = 50_000;
const SUBSTANTIAL_SECTION_CHARS = 500;

function formatCharacterCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

function assessReadableContentLength({ totalChars, substantialSections }) {
  const readableChars = Math.max(0, Number(totalChars) || 0);
  const readableSections = Math.max(0, Number(substantialSections) || 0);

  if (readableSections < 1) {
    return {
      valid: false,
      error: `Insufficient content for audiobook: only ${formatCharacterCount(readableChars)} chars total; no substantial readable sections found`
    };
  }

  return {
    valid: true,
    warning: readableChars < SHORT_BOOK_WARNING_CHARS
      ? `Short book: ${formatCharacterCount(readableChars)} chars total; verify this edition is complete`
      : null
  };
}

module.exports = {
  SHORT_BOOK_WARNING_CHARS,
  SUBSTANTIAL_SECTION_CHARS,
  assessReadableContentLength
};
