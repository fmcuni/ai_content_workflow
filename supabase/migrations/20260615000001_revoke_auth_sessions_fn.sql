-- Refresh-token kill for admin "revoke sessions" / "disable".
--
-- GoTrue's admin REST API has NO per-user sign-out endpoint (the previously
-- called POST /admin/users/:id/logout does not exist — it always 404'd), so the
-- only way to cut a user's refresh path is to delete their auth.sessions /
-- auth.refresh_tokens rows directly. The app role must not get blanket DML on
-- the auth schema, so this is wrapped in a SECURITY DEFINER function (owned by
-- the migration role, which has auth-schema access on Supabase) with EXECUTE
-- granted to content_tool_app only.
--
-- Together with app_user.sessions_revoked_at (which cuts still-valid ACCESS
-- tokens at the Workers auth gate), this makes revocation complete: live tokens
-- are denied on the next request, and no new token can be minted by refresh.
CREATE OR REPLACE FUNCTION content_tool.revoke_auth_sessions(target_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- refresh_tokens.user_id is varchar in GoTrue's schema; sessions.user_id is uuid.
  DELETE FROM auth.refresh_tokens WHERE user_id = target_user::text;
  DELETE FROM auth.sessions WHERE user_id = target_user;
END;
$$;

REVOKE ALL ON FUNCTION content_tool.revoke_auth_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content_tool.revoke_auth_sessions(uuid) TO content_tool_app;
