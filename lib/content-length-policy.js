const SHORT_BOOK_WARNING_CHARS = 50_000;
const SUBSTANTIAL_SECTION_CHARS = 500;

function formatCharacterCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

function assessReadableContentLength({ totalChars, substantialSections }) {
  const readableChars = Math.max(0, Number(totalChars) || 0);
  if (readableChars < 1) {
    return {
      valid: false,
      error: 'No readable text was extracted'
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
