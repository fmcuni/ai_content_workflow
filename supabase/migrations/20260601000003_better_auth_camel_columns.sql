-- Fix better-auth column casing.
--
-- The original better_auth migration (20260601000001) created snake_case
-- columns to match a `casing: "snake"` option in the Worker's better-auth
-- config. That option does NOT exist in better-auth 1.6.13 — it is silently
-- ignored, so better-auth issues queries against its DEFAULT camelCase column
-- names (e.g. `"emailVerified"`). Sign-up therefore failed with:
--   column "emailVerified" of relation "user" does not exist
--
-- This migration renames every multi-word column to the camelCase identifier
-- better-auth actually emits (verified against `getAuthTables` in
-- @better-auth/core/db). The auth tables are better-auth-managed, so they keep
-- better-auth's native camelCase rather than the repo's snake_case convention
-- (which governs the app's own SQLAlchemy-managed tables). RENAME preserves the
-- RLS policies, grants, FK constraints, and indexes created in 20260601000001.
--
-- Single-word columns (id, name, email, image, token, identifier, value, scope,
-- password) already match better-auth's defaults and are left untouched.

-- user
ALTER TABLE content_tool."user" RENAME COLUMN email_verified TO "emailVerified";
ALTER TABLE content_tool."user" RENAME COLUMN created_at     TO "createdAt";
ALTER TABLE content_tool."user" RENAME COLUMN updated_at     TO "updatedAt";

-- session
ALTER TABLE content_tool.session RENAME COLUMN expires_at TO "expiresAt";
ALTER TABLE content_tool.session RENAME COLUMN created_at TO "createdAt";
ALTER TABLE content_tool.session RENAME COLUMN updated_at TO "updatedAt";
ALTER TABLE content_tool.session RENAME COLUMN ip_address TO "ipAddress";
ALTER TABLE content_tool.session RENAME COLUMN user_agent TO "userAgent";
ALTER TABLE content_tool.session RENAME COLUMN user_id    TO "userId";

-- account
ALTER TABLE content_tool.account RENAME COLUMN account_id               TO "accountId";
ALTER TABLE content_tool.account RENAME COLUMN provider_id              TO "providerId";
ALTER TABLE content_tool.account RENAME COLUMN user_id                  TO "userId";
ALTER TABLE content_tool.account RENAME COLUMN access_token             TO "accessToken";
ALTER TABLE content_tool.account RENAME COLUMN refresh_token            TO "refreshToken";
ALTER TABLE content_tool.account RENAME COLUMN id_token                 TO "idToken";
ALTER TABLE content_tool.account RENAME COLUMN access_token_expires_at  TO "accessTokenExpiresAt";
ALTER TABLE content_tool.account RENAME COLUMN refresh_token_expires_at TO "refreshTokenExpiresAt";
ALTER TABLE content_tool.account RENAME COLUMN created_at               TO "createdAt";
ALTER TABLE content_tool.account RENAME COLUMN updated_at               TO "updatedAt";

-- verification
ALTER TABLE content_tool.verification RENAME COLUMN expires_at TO "expiresAt";
ALTER TABLE content_tool.verification RENAME COLUMN created_at TO "createdAt";
ALTER TABLE content_tool.verification RENAME COLUMN updated_at TO "updatedAt";
