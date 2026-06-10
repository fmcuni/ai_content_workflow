-- Admin "revoke sessions" enforcement point.
--
-- GoTrue's admin sign-out (/admin/users/:id/logout) only revokes REFRESH
-- tokens; the target's live ACCESS token is stateless (JWKS-verified) and stays
-- valid until expiry (~1h). The Workers per-request gate (auth/authz.ts
-- loadRole) denies any token whose `iat` predates this timestamp, making
-- revocation effective on the target's next request. NULL = never revoked.
ALTER TABLE content_tool.app_user
  ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;
