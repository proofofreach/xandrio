function createBookRouteHelpers({ loadJSON, booksFile, isSafeBookId, userIdFromRequest }) {
  function userIdFor(req) {
    return userIdFromRequest(req);
  }

  async function requireBook(req, res) {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      res.status(400).json({ error: 'Invalid book identifier' });
      return null;
    }
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) {
      res.status(404).json({ error: 'Book not found' });
      return null;
    }
    return { bookId, book, books };
  }

  return { userIdFor, requireBook };
}

module.exports = { createBookRouteHelpers };
