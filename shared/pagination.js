// shared/pagination.js — parse optional ?limit= / ?offset= query params.
// Returns undefined when no limit is given, so callers stay backward compatible
// (no pagination -> all rows, as before).

function parsePagination(query) {
  const limit = Number.parseInt(query.limit, 10);
  const offset = Number.parseInt(query.offset, 10);
  if (Number.isInteger(limit) && limit > 0) {
    return { limit, offset: Number.isInteger(offset) && offset >= 0 ? offset : 0 };
  }
  return undefined;
}

module.exports = { parsePagination };
