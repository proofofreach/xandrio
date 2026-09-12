function createBookRouteHelpers({ loadJSON, booksFile, isSafeBookId, userIdFromRequest }) {
  const { badRequest, notFound } = require('../http-error');

  function userIdFor(req) {
    return userIdFromRequest(req);
  }

  async function requireBook(req, res) {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      badRequest(res, 'Invalid book identifier');
      return null;
    }
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) {
      notFound(res, 'Book not found');
      return null;
    }
    return { bookId, book, books };
  }

  return { userIdFor, requireBook };
}

module.exports = { createBookRouteHelpers };
