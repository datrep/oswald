'use strict';
// trading/store/constraints.js — the SQL side of the external constraint ledger (migration 052).
//
// ⚠ THE SQL LIVES HERE AND NOWHERE ELSE. `agent/constraints.js` is the pure reader and validator; this file is the
// only place that touches `ConstraintVersions`. The same rule `test/venue-cost-basis.test.js` enforces for
// `agent/instruments.js` — a second place that queries a table is a second place that can forget the filter.
//
// ★★ THE OVERLAP REFUSAL IS THE REASON THIS MODULE EXISTS. Migration 052 cannot express "two versions of one key may
// not describe the same instant" as a SQL constraint, so it is enforced here, inside a transaction, with the key's
// rows locked (`UPDLOCK, HOLDLOCK`). Without the lock, two concurrent appends can each read "no overlap" and both
// insert — which is precisely how a resolver ends up with two answers for one instant and no way to choose.
// `vw_ConstraintOverlaps` is the audit of this guard and must always return zero rows.
//
// ⚠ APPEND-ONLY. There is no update path and no delete path, deliberately. A correction is a new row with
// `supersedesId`; retracting a version without replacing it closes it with `effectiveTo` plus
// `verificationState = 'disputed'`. Nothing in this file mutates a stored row.
const { getPool, sql } = require('../db');
const constraints = require('../agent/constraints');

const COLUMNS = [
  'constraintVersionId', 'constraintKey', 'subjectKind', 'venue', 'venueInstrumentId', 'constraintType',
  'valueNumeric', 'valueUnit', 'valueEnum', 'valueMinutesUtc',
  'effectiveFrom', 'effectiveFromNotBefore', 'effectiveFromNotAfter', 'effectiveTo', 'recordedAt', 'supersedesId',
  'verificationState', 'issuer', 'recordedBy', 'confirmedAt',
  'evidenceExcerpt', 'evidenceArtifactRef', 'evidenceDigest', 'sourceUrl', 'note',
];

// Every version that could bind this subject. Deliberately returns venue-wide rows (venueInstrumentId IS NULL) as
// well as the instrument's own, because a venue-wide prohibition applies to every instrument at that venue.
async function subjectVersions(userId, { venue = null, venueInstrumentId = null } = {}) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('instrument', sql.NVarChar(64), venueInstrumentId)
    .query(`SELECT ${COLUMNS.join(', ')}
              FROM dbo.ConstraintVersions
             WHERE userId = @userId
               AND (@venue IS NULL OR venue IS NULL OR venue = @venue)
               AND (@instrument IS NULL OR venueInstrumentId IS NULL OR venueInstrumentId = @instrument)`);
  return r.recordset;
}

async function versionsFor(userId, constraintKey) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('key', sql.NVarChar(160), constraintKey)
    .query(`SELECT ${COLUMNS.join(', ')} FROM dbo.ConstraintVersions WHERE userId = @userId AND constraintKey = @key`);
  return r.recordset;
}

// The integrity read. MUST return zero rows; a non-zero result means the write guard was bypassed by something.
async function overlaps(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(
    'SELECT * FROM dbo.vw_ConstraintOverlaps WHERE userId = @userId');
  return r.recordset;
}

const fail = (message, extra = {}) => Object.assign(new Error(message), { constraintErrors: [message] }, extra);

// Append one version. Returns the inserted row.
//
// `patch` keys mirror the columns. `recordedAt` defaults to now — the DESK's learning time, which is a different
// fact from `effectiveFrom` and is why the caller may set it explicitly (a backfill of something captured earlier).
async function appendVersion(userId, patch = {}, { now = null } = {}) {
  const p = { ...patch };
  if (p.recordedBy == null) p.recordedBy = 'operator';
  const check = constraints.validateVersion(p);
  if (!check.ok) throw fail(`constraint version rejected: ${check.errors.join('; ')}`, { constraintErrors: check.errors });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const req = () => new sql.Request(tx);

    // LOCK THE KEY. Every version of this key, held to the end of the transaction, so a concurrent append cannot
    // read the same "no overlap" answer and insert alongside us.
    const existing = (await req()
      .input('userId', sql.Int, userId)
      .input('key', sql.NVarChar(160), p.constraintKey)
      .query(`SELECT constraintVersionId, constraintKey, effectiveFrom, effectiveTo
                FROM dbo.ConstraintVersions WITH (UPDLOCK, HOLDLOCK)
               WHERE userId = @userId AND constraintKey = @key`)).recordset;

    // A supersession must point at a version of the SAME key; a reference across keys would chain two unrelated
    // facts and make the current-row derivation meaningless.
    if (p.supersedesId != null) {
      const target = existing.find((r) => Number(r.constraintVersionId) === Number(p.supersedesId));
      if (!target) throw fail(`supersedesId ${p.supersedesId} is not a version of ${p.constraintKey}`);
    }

    const clash = constraints.findOverlap(p, existing);
    if (clash) {
      throw fail(
        `overlapping version: this window intersects version ${clash.constraintVersionId} of ${p.constraintKey}. `
        + 'A period with two answers is a mistake, not a fact — close the existing version with effectiveTo, or '
        + 'append a superseding version outside its window.',
        { conflictingVersionId: Number(clash.constraintVersionId) },
      );
    }

    const ins = await req()
      .input('userId', sql.Int, userId)
      .input('key', sql.NVarChar(160), p.constraintKey)
      .input('subjectKind', sql.NVarChar(24), p.subjectKind)
      .input('venue', sql.NVarChar(32), p.venue ?? null)
      .input('instrument', sql.NVarChar(64), p.venueInstrumentId ?? null)
      .input('type', sql.NVarChar(24), p.constraintType)
      .input('valueNumeric', sql.Decimal(28, 10), p.valueNumeric ?? null)
      .input('valueUnit', sql.NVarChar(32), p.valueUnit ?? null)
      .input('valueEnum', sql.NVarChar(64), p.valueEnum ?? null)
      .input('valueMinutesUtc', sql.SmallInt, p.valueMinutesUtc ?? null)
      .input('from', sql.DateTime2(3), p.effectiveFrom ? new Date(p.effectiveFrom) : null)
      // Bounded start (migration 053): the interval the true start lies inside, when only an observation bounds it.
      .input('fromNotBefore', sql.DateTime2(3), p.effectiveFromNotBefore ? new Date(p.effectiveFromNotBefore) : null)
      .input('fromNotAfter', sql.DateTime2(3), p.effectiveFromNotAfter ? new Date(p.effectiveFromNotAfter) : null)
      .input('to', sql.DateTime2(3), p.effectiveTo ? new Date(p.effectiveTo) : null)
      // ⚠ DEFAULTED SERVER-SIDE ONLY WHEN ABSENT. `new Date()` here would be the API process's clock; the column
      // default is SYSUTCDATETIME, which is the database's — and for a backfill the caller supplies it explicitly.
      .input('recordedAt', sql.DateTime2(3), p.recordedAt ? new Date(p.recordedAt) : (now ? new Date(now) : null))
      .input('supersedesId', sql.BigInt, p.supersedesId ?? null)
      .input('state', sql.NVarChar(16), p.verificationState)
      .input('issuer', sql.NVarChar(128), p.issuer ?? null)
      .input('recordedBy', sql.NVarChar(64), p.recordedBy)
      .input('confirmedAt', sql.DateTime2(3), p.confirmedAt ? new Date(p.confirmedAt) : null)
      .input('excerpt', sql.NVarChar(1000), p.evidenceExcerpt ?? null)
      .input('artifactRef', sql.NVarChar(260), p.evidenceArtifactRef ?? null)
      .input('digest', sql.Char(64), p.evidenceDigest ?? null)
      .input('sourceUrl', sql.NVarChar(500), p.sourceUrl ?? null)
      .input('note', sql.NVarChar(1000), p.note ?? null)
      .query(`INSERT INTO dbo.ConstraintVersions
                (userId, constraintKey, subjectKind, venue, venueInstrumentId, constraintType,
                 valueNumeric, valueUnit, valueEnum, valueMinutesUtc,
                 effectiveFrom, effectiveFromNotBefore, effectiveFromNotAfter, effectiveTo, recordedAt, supersedesId,
                 verificationState, issuer, recordedBy, confirmedAt,
                 evidenceExcerpt, evidenceArtifactRef, evidenceDigest, sourceUrl, note)
              OUTPUT ${COLUMNS.map((c) => `INSERTED.${c}`).join(', ')}
              VALUES (@userId, @key, @subjectKind, @venue, @instrument, @type,
                      @valueNumeric, @valueUnit, @valueEnum, @valueMinutesUtc,
                      @from, @fromNotBefore, @fromNotAfter, @to, COALESCE(@recordedAt, SYSUTCDATETIME()), @supersedesId,
                      @state, @issuer, @recordedBy, @confirmedAt,
                      @excerpt, @artifactRef, @digest, @sourceUrl, @note)`);

    await tx.commit();
    return ins.recordset[0];
  } catch (e) {
    // ⚠ ROLLBACK IS NOT BEST-EFFORT. A failed rollback leaves an open transaction holding locks on the key, which
    // would block every later append — so a rollback failure is reported with the original error attached.
    try { await tx.rollback(); } catch (re) { e.rollbackError = String(re.message || re); }
    throw e;
  }
}

module.exports = { COLUMNS, subjectVersions, versionsFor, overlaps, appendVersion };
