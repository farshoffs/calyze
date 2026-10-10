-- Cloud CSV archive for very large cTrader exports (millions of M1 bars).
-- Split source into 4 MiB slices; gzip every slice as its own storage object.
-- Each object stays under Supabase Free's 50 MB per-object limit.

alter table public.datasets
  add column if not exists storage_format text,
  add column if not exists storage_parts integer,
  add column if not exists storage_state text not null default 'ready',
  add column if not exists source_bytes bigint,
  add column if not exists original_file_name text;

create index if not exists datasets_user_cloud_idx
  on public.datasets(user_id, storage_state, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit)
values ('calyze-imports', 'calyze-imports', false, 8388608)
on conflict (id) do nothing;

-- Objects can only be accessed within the current signed-in user's UUID folder.
create policy "calyze_imports_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'calyze-imports' and
    (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "calyze_imports_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'calyze-imports' and
    (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "calyze_imports_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'calyze-imports' and
    (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'calyze-imports' and
    (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "calyze_imports_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'calyze-imports' and
    (storage.foldername(name))[1] = (select auth.uid())::text
  );
