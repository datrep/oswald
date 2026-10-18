/* 2026-10-03 — NewsItems: storage for the news aggregator, S1 (open-work §4.19 / TRD-NEW-1).
 *
 * S1 IS WRITE-ONLY ON PURPOSE. Items are fetched from SearXNG and stored here; NOTHING reads them
 * into a chair bundle — that is S3 (envelope + prompt-version bump), deliberately unbuilt. So a row
 * in this table can never have influenced a trading decision.
 *
 * DEGRADATION DISCIPLINE (news-aggregator brief §10, the F1 defect class): a dead feed must not
 * render as a quiet one. The fetch loop records `news_digest` events through TradingEvents with an
 * explicit reason (`searxng_unreachable` / `no_items`), so "no news" and "no fetch" are separable.
 *
 * Apply (DDL needs owner rights — the app login has none):
 *   sqlcmd -S localhost\SQLEXPRESS -E -d DB_Oswald -i trading\sql\2026-10-03-news.sql
 */
IF OBJECT_ID('dbo.NewsItems', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.NewsItems (
    id          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId      INT NOT NULL CONSTRAINT FK_NewsItems_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    symbol      NVARCHAR(64)  NOT NULL,              -- desk display name the query was composed for
    title       NVARCHAR(512) NOT NULL,
    url         NVARCHAR(1024) NOT NULL,
    source      NVARCHAR(128) NULL,                  -- engine-reported source / domain
    engine      NVARCHAR(64)  NULL,                  -- which searxng engine returned it
    publishedAt DATETIME2     NULL,                  -- engine-reported publication time (NULL = not given)
    score       FLOAT         NULL,                  -- engine rank score
    snippet     NVARCHAR(MAX) NULL,                  -- engine content excerpt (detail stays HERE, not in digests)
    query       NVARCHAR(256) NOT NULL,              -- the composed query that produced this item
    itemHash    CHAR(64)      NOT NULL,              -- sha256(symbol|url|title) — the dedupe key
    createdAt   DATETIME2     NOT NULL CONSTRAINT DF_NewsItems_createdAt DEFAULT GETUTCDATE()
  );
  CREATE UNIQUE INDEX UX_NewsItems_user_hash   ON dbo.NewsItems(userId, itemHash);
  CREATE INDEX        IX_NewsItems_user_symbol ON dbo.NewsItems(userId, symbol, createdAt DESC);
END
GO
