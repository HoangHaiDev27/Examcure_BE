begin;

create extension if not exists pgcrypto;

create type public.app_role as enum ('student', 'admin');
create type public.material_version_status as enum ('uploading', 'uploaded', 'processing', 'ready', 'failed', 'archived');
create type public.processing_job_status as enum ('queued', 'running', 'completed', 'failed');
create type public.generation_status as enum ('queued', 'retrieving', 'generating', 'completed', 'failed');
create type public.question_status as enum ('draft', 'approved', 'rejected', 'archived');
create type public.difficulty_level as enum ('basic', 'medium', 'advanced');
create type public.exam_status as enum ('draft', 'published', 'archived');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  school_id text,
  role public.app_role not null default 'student',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  school_code text not null,
  code text not null,
  name text not null,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (school_code, code)
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id) on delete cascade,
  title text not null,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.material_versions (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  status public.material_version_status not null default 'uploading',
  original_bucket text not null default 'material-originals',
  original_path text not null,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  preview_path text,
  slide_count integer not null default 0,
  embedding_model text,
  error_message text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (material_id, version_number)
);

create table public.slides (
  id uuid primary key default gen_random_uuid(),
  material_version_id uuid not null references public.material_versions(id) on delete cascade,
  slide_number integer not null check (slide_number > 0),
  image_path text,
  text_content text not null default '',
  notes text,
  created_at timestamptz not null default now(),
  unique (material_version_id, slide_number)
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('material_ingestion', 'vector_cleanup')),
  status public.processing_job_status not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  locked_at timestamptz,
  locked_by text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.generation_runs (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id),
  requested_by uuid references auth.users(id),
  status public.generation_status not null default 'queued',
  question_count integer not null check (question_count between 1 and 20),
  difficulty public.difficulty_level not null,
  material_version_ids uuid[] not null,
  extra_instructions text,
  model text,
  retrieved_chunk_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  generation_run_id uuid references public.generation_runs(id) on delete set null,
  subject_id uuid not null references public.subjects(id),
  prompt text not null,
  explanation text not null,
  difficulty public.difficulty_level not null,
  status public.question_status not null default 'draft',
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  position integer not null check (position between 0 and 7),
  content text not null,
  is_correct boolean not null default false,
  unique (question_id, position)
);

create table public.question_sources (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  material_version_id uuid not null references public.material_versions(id),
  slide_number integer not null,
  chunk_id text not null,
  excerpt text not null,
  retrieval_score double precision,
  unique (question_id, chunk_id)
);

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id),
  title text not null,
  duration_minutes integer not null default 60 check (duration_minutes > 0),
  status public.exam_status not null default 'draft',
  created_by uuid references auth.users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.exam_questions (
  exam_id uuid not null references public.exams(id) on delete cascade,
  question_id uuid not null references public.questions(id),
  position integer not null check (position > 0),
  points numeric(6,2) not null default 1,
  primary key (exam_id, question_id),
  unique (exam_id, position)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index material_versions_status_idx on public.material_versions(status);
create index processing_jobs_poll_idx on public.processing_jobs(status, created_at);
create index questions_review_idx on public.questions(status, created_at desc);
create index question_sources_version_idx on public.question_sources(material_version_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, school_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'school_id'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.claim_processing_job(p_worker_name text)
returns setof public.processing_jobs
language plpgsql
security definer set search_path = public
as $$
begin
  return query
  with candidate as (
    select id
    from public.processing_jobs
    where status = 'queued' and attempts < max_attempts
    order by created_at
    for update skip locked
    limit 1
  )
  update public.processing_jobs as job
  set status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = p_worker_name,
      updated_at = now()
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

create or replace function public.save_generated_questions(p_run_id uuid, p_questions jsonb)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_run public.generation_runs%rowtype;
  v_question jsonb;
  v_question_id uuid;
  v_option jsonb;
  v_source jsonb;
  v_count integer := 0;
begin
  select * into v_run from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'Generation run not found'; end if;

  for v_question in select * from jsonb_array_elements(p_questions)
  loop
    insert into public.questions (
      generation_run_id, subject_id, prompt, explanation, difficulty, created_by
    ) values (
      v_run.id,
      v_run.subject_id,
      v_question ->> 'prompt',
      v_question ->> 'explanation',
      (v_question ->> 'difficulty')::public.difficulty_level,
      v_run.requested_by
    ) returning id into v_question_id;

    for v_option in select * from jsonb_array_elements(v_question -> 'options')
    loop
      insert into public.question_options (question_id, position, content, is_correct)
      values (
        v_question_id,
        (v_option ->> 'position')::integer,
        v_option ->> 'content',
        (v_option ->> 'is_correct')::boolean
      );
    end loop;

    for v_source in select * from jsonb_array_elements(v_question -> 'sources')
    loop
      insert into public.question_sources (
        question_id, material_version_id, slide_number, chunk_id, excerpt, retrieval_score
      ) values (
        v_question_id,
        (v_source ->> 'material_version_id')::uuid,
        (v_source ->> 'slide_number')::integer,
        v_source ->> 'chunk_id',
        v_source ->> 'excerpt',
        nullif(v_source ->> 'retrieval_score', '')::double precision
      );
    end loop;

    v_count := v_count + 1;
  end loop;

  update public.generation_runs
  set status = 'completed', completed_at = now()
  where id = p_run_id;

  return v_count;
end;
$$;

create or replace function public.create_exam_with_questions(
  p_subject_id uuid,
  p_title text,
  p_duration_minutes integer,
  p_question_ids uuid[],
  p_publish boolean,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_exam_id uuid;
  v_valid_count integer;
begin
  if cardinality(p_question_ids) = 0 then
    raise exception 'At least one question is required';
  end if;

  select count(*) into v_valid_count
  from public.questions
  where id = any(p_question_ids)
    and subject_id = p_subject_id
    and status = 'approved';

  if v_valid_count <> cardinality(p_question_ids) then
    raise exception 'Every exam question must be approved and belong to the selected subject';
  end if;

  insert into public.exams (
    subject_id, title, duration_minutes, status, created_by, published_at
  ) values (
    p_subject_id,
    p_title,
    p_duration_minutes,
    case when p_publish then 'published' else 'draft' end,
    p_created_by,
    case when p_publish then now() else null end
  ) returning id into v_exam_id;

  insert into public.exam_questions (exam_id, question_id, position)
  select v_exam_id, question_id, position::integer
  from unnest(p_question_ids) with ordinality as selected(question_id, position);

  return v_exam_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.materials enable row level security;
alter table public.material_versions enable row level security;
alter table public.slides enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.generation_runs enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.question_sources enable row level security;
alter table public.exams enable row level security;
alter table public.exam_questions enable row level security;
alter table public.audit_logs enable row level security;

create policy "profile reads itself" on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "profile updates itself" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on table public.profiles from authenticated;
grant update (full_name, school_id, updated_at) on table public.profiles to authenticated;
create policy "authenticated reads subjects" on public.subjects for select to authenticated using (true);
create policy "admin manages subjects" on public.subjects for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads materials" on public.materials for select to authenticated using (true);
create policy "admin manages materials" on public.materials for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads ready versions" on public.material_versions for select to authenticated using (status = 'ready' or public.is_admin());
create policy "admin manages versions" on public.material_versions for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads ready slides" on public.slides for select to authenticated using (
  exists (select 1 from public.material_versions v where v.id = material_version_id and (v.status = 'ready' or public.is_admin()))
);
create policy "admin manages slides" on public.slides for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin manages jobs" on public.processing_jobs for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin manages generation runs" on public.generation_runs for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads approved questions" on public.questions for select to authenticated using (status = 'approved' or public.is_admin());
create policy "admin manages questions" on public.questions for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads approved options" on public.question_options for select to authenticated using (
  exists (select 1 from public.questions q where q.id = question_id and (q.status = 'approved' or public.is_admin()))
);
create policy "admin manages options" on public.question_options for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin manages question sources" on public.question_sources for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads published exams" on public.exams for select to authenticated using (status = 'published' or public.is_admin());
create policy "admin manages exams" on public.exams for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "authenticated reads published exam questions" on public.exam_questions for select to authenticated using (
  exists (select 1 from public.exams e where e.id = exam_id and (e.status = 'published' or public.is_admin()))
);
create policy "admin manages exam questions" on public.exam_questions for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin reads audit logs" on public.audit_logs for select to authenticated using (public.is_admin());

insert into storage.buckets (id, name, public)
values
  ('material-originals', 'material-originals', false),
  ('material-previews', 'material-previews', false),
  ('slide-images', 'slide-images', false)
on conflict (id) do nothing;

create policy "admin uploads material originals" on storage.objects for insert to authenticated with check (bucket_id = 'material-originals' and public.is_admin());
create policy "admin reads material originals" on storage.objects for select to authenticated using (bucket_id = 'material-originals' and public.is_admin());
create policy "authenticated reads previews" on storage.objects for select to authenticated using (bucket_id in ('material-previews', 'slide-images'));
create policy "admin manages generated assets" on storage.objects for all to authenticated using (bucket_id in ('material-previews', 'slide-images') and public.is_admin()) with check (bucket_id in ('material-previews', 'slide-images') and public.is_admin());

revoke all on function public.claim_processing_job(text) from public, anon, authenticated;
grant execute on function public.claim_processing_job(text) to service_role;
revoke all on function public.save_generated_questions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_generated_questions(uuid, jsonb) to service_role;
revoke all on function public.create_exam_with_questions(uuid, text, integer, uuid[], boolean, uuid) from public, anon, authenticated;
grant execute on function public.create_exam_with_questions(uuid, text, integer, uuid[], boolean, uuid) to service_role;

commit;
