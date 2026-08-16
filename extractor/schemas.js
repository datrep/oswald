'use strict';
// extractor/schemas.js — Joi validation for the extraction endpoints.

const Joi = require('joi');

const importUrl = Joi.object({
  url: Joi.string().uri({ scheme: ['http', 'https'] }).max(4096),
  urls: Joi.array().items(Joi.string().uri({ scheme: ['http', 'https'] }).max(4096)).max(500),
})
  .or('url', 'urls')
  .required();

const pull = Joi.object({
  mode: Joi.string().valid('strip', 'original').default('strip'),
  setParams: Joi.object()
    .pattern(/^[A-Za-z0-9_.-]{1,32}$/, Joi.alternatives().try(Joi.string().max(50), Joi.number().integer().min(0).max(100000)))
    .optional(),
}).default({ mode: 'strip' });

module.exports = { importUrl, pull };
