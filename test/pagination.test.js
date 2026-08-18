'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePagination } = require('../shared/pagination');

test('returns undefined without a limit (backward compatible)', () => {
  assert.equal(parsePagination({}), undefined);
  assert.equal(parsePagination({ offset: '10' }), undefined);
});

test('parses limit and defaults offset to 0', () => {
  assert.deepEqual(parsePagination({ limit: '20' }), { limit: 20, offset: 0 });
  assert.deepEqual(parsePagination({ limit: '20', offset: '5' }), { limit: 20, offset: 5 });
});

test('ignores invalid or non-positive limit', () => {
  assert.equal(parsePagination({ limit: '0' }), undefined);
  assert.equal(parsePagination({ limit: 'abc' }), undefined);
});
