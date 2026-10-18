-- 045_instrument_unit_label.sql
-- The LABEL the venue prints beside the stat box's column-0 value, so the desk stops ASSERTING that
-- the number is a minimum trade size and starts RECORDING the venue's own word for it.
--
-- WHY. `Instruments.unitAmount` is read by COLUMN POSITION — `instrumentProbe.js:234`,
-- `sPick('sidebar.rates-and-values.column-0.value')` (column-1 is leverage, column-2 the dynamic
-- spread). The ONE field the desk enforces as a hard sizing VETO is therefore identified by where it
-- sits rather than by its own name, and its MEANING is asserted in the comment above that line
-- ("unitAmount is a MINIMUM trade size in venue units, NOT a contract multiplier"). The same file, a
-- few lines earlier, records the opposite discipline for every other field: "the LABEL comes with the
-- value instead of being assumed from column position".
--
-- WHAT SETTLED IT, AND WHAT DID NOT. The number's VALUE is no longer in doubt on behaviour: every
-- size the venue has been observed HOLDING, for every symbol that has a floor, is an exact integer
-- multiple of that floor — 6 symbols, 11 distinct sizes, zero counterexamples, no size ever held below
-- one (measured 2026-09-28; TRD-EXE-2 #1455, TRD-EXE-3 #1463). What remains is PROVENANCE, and it is
-- cheap to remove: the venue publishes a LABELLED definition/value list
-- (`plus500-list-data-item`, slot="definition-item"/"value-item") alongside the positional stat box, so
-- the venue's own word for the field is derivable by EXACT MATCH rather than by guessing a testid.
--
-- HOW IT IS POPULATED. `instrumentProbe.js` finds the labelled pair whose value is the same text as
-- the stat box's column-0 and stores that pair's label here. If no pair matches, the field is not one
-- the venue labels — which is itself the answer, and NULL says so. **NULL MEANS "NOT LABELLED BY THE
-- VENUE", NEVER "no minimum"** — the same three-valued discipline migrations 041 (fill price) and 044
-- (close time) imposed, one column over.
--
-- ⚠ NOTHING READS THIS YET, DELIBERATELY. Gating the veto on a label string is a POLICY choice with a
-- lower prize now that the value is corroborated 11 times over by the venue's own fills, and a label is
-- fragile across a localised deploy. Recording it first is the point: the question closes itself when
-- the next capture lands, and no behaviour depends on a column that is still empty.
--
-- SAFE TO APPLY LIVE: one NULLable additive column, no default, no data movement inside the migration.

IF COL_LENGTH('dbo.Instruments', 'unitAmountLabel') IS NULL
  ALTER TABLE dbo.Instruments ADD unitAmountLabel NVARCHAR(60) NULL;
GO
