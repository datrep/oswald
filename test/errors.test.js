'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AppError, NotFoundError, ForbiddenError, asyncHandler } = require('../utils/errors');

test('AppError carries message + statusCode', () => {
  const e = new AppError('boom', 418);
  assert.equal(e.message, 'boom');
  assert.equal(e.statusCode, 418);
});

test('NotFoundError defaults to 404', () => {
  assert.equal(new NotFoundError().statusCode, 404);
  assert.equal(new NotFoundError('gone').message, 'gone');
});

test('ForbiddenError defaults to 403', () => {
  assert.equal(new ForbiddenError().statusCode, 403);
});

test('asyncHandler forwards rejections to next', async () => {
  const boom = new Error('nope');
  let forwarded = null;
  await asyncHandler(async () => {
    throw boom;
  })({}, {}, (err) => {
    forwarded = err;
  });
  assert.equal(forwarded, boom);
});

test('asyncHandler lets resolved handlers run normally', async () => {
  const res = {};
  await asyncHandler(async (req, res2) => {
    res2.body = req.x + 1;
  })({ x: 41 }, res, () => {});
  assert.equal(res.body, 42);
});
