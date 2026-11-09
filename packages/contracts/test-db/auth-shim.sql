do $$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end
$$;
create schema auth;
create schema extensions;
create table auth.users(id uuid primary key, is_anonymous boolean not null default false);
create function auth.uid() returns uuid language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
  nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
grant usage on schema auth to authenticated;
grant usage on schema extensions to authenticated, anon, service_role;
