-- Optimistic-concurrency version columns for human-editable artifacts.
--
-- Two reviewers editing the same render/outline at once would otherwise clobber
-- each other (last write wins, silently). An integer `version` lets the edit
-- endpoints do a conditional `UPDATE ... WHERE version = :expected` and return
-- 409 on a stale read, mirroring the prompt/source-policy editors' SHA256 guard.
-- Starts at 0 for every existing row; each persisted edit bumps it by 1.

ALTER TABLE "content_tool"."renders"
    ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 0 NOT NULL;

ALTER TABLE "content_tool"."outlines"
    ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 0 NOT NULL;
