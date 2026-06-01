-- Collapse the four-role model into three: viewer < editor < admin.
--
-- Original (20260601000006) was viewer/author/reviewer/admin with hard 4-eyes
-- segregation of duties. Per updated requirements, publishing no longer needs a
-- second pair of eyes: an `editor` (the merged author+reviewer) creates, edits,
-- reviews BOTH HITL gates, and publishes to WordPress — including their own
-- articles. `admin` keeps config (prompts/personas/source-policy), deletes, and
-- user-role management. SoD is removed entirely at the app layer.
--
-- 20260601000006 is already applied to prod, so this is a forward migration that
-- remaps existing rows (author/reviewer -> editor) and swaps the CHECK. The
-- column default stays 'viewer' (least privilege). Bootstrap admins remain
-- driven by BOOTSTRAP_ADMIN_EMAILS, independent of the stored role.

ALTER TABLE content_tool."user" DROP CONSTRAINT IF EXISTS user_role_check;

UPDATE content_tool."user"
    SET role = 'editor'
    WHERE role IN ('author', 'reviewer');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_role_check'
    ) THEN
        ALTER TABLE content_tool."user"
            ADD CONSTRAINT user_role_check
            CHECK (role IN ('viewer', 'editor', 'admin'));
    END IF;
END $$;
