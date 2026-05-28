-- Revoke all privileges on the public schema from Supabase's shipped anon and
-- authenticated roles. The app never uses PostgREST or these roles; this removes
-- the implicit grants Supabase adds at project creation time.

REVOKE ALL ON SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
