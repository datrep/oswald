'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isAllowedExtension, isAllowedMime, uniqueFilename } = require('../shared/upload');

test('isAllowedExtension accepts docs/images, rejects executables/web', () => {
  assert.equal(isAllowedExtension('photo.png'), true);
  assert.equal(isAllowedExtension('report.PDF'), true);
  assert.equal(isAllowedExtension('page.html'), false);
  assert.equal(isAllowedExtension('evil.exe'), false);
});

test('isAllowedMime accepts images/documents, rejects HTML', () => {
  assert.equal(isAllowedMime('image/png'), true);
  assert.equal(isAllowedMime('application/pdf'), true);
  assert.equal(isAllowedMime('text/html'), false);
});

test('uniqueFilename neutralizes path separators', () => {
  const name = uniqueFilename({ originalname: '..\\evil.txt' });
  assert.ok(!name.includes('\\'));
  assert.ok(name.endsWith('evil.txt'));
});
