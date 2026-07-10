-- Newer Supabase projects no longer auto-expose tables/grants to Data API roles
-- (including service_role) without explicit GRANTs — see config.toml's
-- `auto_expose_new_tables` note. service_role is meant to be a fully-trusted
-- role (it already bypasses RLS), so grant it full access to everything in
-- public, including tables created by future migrations.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant all privileges on functions to service_role;
