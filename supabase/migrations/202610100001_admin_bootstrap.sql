begin;

-- Bootstrap can grant only the first administrator, through a service-role RPC.
-- Consumed state survives restarts, deleted users and later role changes.
create table public.admin_bootstrap_state (
  singleton boolean primary key default true check (singleton),
  completed_by uuid references public.profiles(id) on delete set null,
  completed_at timestamptz not null default now()
);
alter table public.admin_bootstrap_state enable row level security;
revoke all on table public.admin_bootstrap_state from public, anon, authenticated;

-- Existing installations must not reopen bootstrap if their admins are removed.
insert into public.admin_bootstrap_state (completed_by)
select id from public.profiles where role = 'admin' order by created_at, id limit 1;

create or replace function public.bootstrap_first_admin(p_user_id uuid)
returns text
language plpgsql
security definer set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(710202610100001::bigint);
  if exists (select 1 from public.admin_bootstrap_state)
     or exists (select 1 from public.profiles where role = 'admin') then
    return 'already_initialized';
  end if;

  update public.profiles set role = 'admin', updated_at = now() where id = p_user_id;
  if not found then
    return 'profile_not_found';
  end if;

  insert into public.admin_bootstrap_state (completed_by) values (p_user_id);
  insert into public.audit_logs (actor_id, action, entity_type, entity_id)
  values (p_user_id, 'admin.bootstrapped', 'profile', p_user_id);
  return 'created';
end;
$$;
revoke all on function public.bootstrap_first_admin(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_first_admin(uuid) to service_role;

commit;
