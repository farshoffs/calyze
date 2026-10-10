-- Calyze account and replay checkpoints. Raw M1 data is never duplicated in snapshots.
create table if not exists public.backtest_save_states (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id uuid references public.datasets(id) on delete set null,
  dataset_key text not null,
  name text not null check (char_length(name) between 1 and 100),
  kind text not null check (kind in ('auto', 'manual')),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backtest_save_states_user_updated_idx
on public.backtest_save_states(user_id, updated_at desc);
create index if not exists backtest_save_states_user_dataset_idx
on public.backtest_save_states(user_id, dataset_key);

alter table public.backtest_save_states enable row level security;

grant select, insert, update, delete on public.backtest_save_states to authenticated;

create policy backtest_saves_select_own on public.backtest_save_states
for select to authenticated using (user_id = (select auth.uid()));
create policy backtest_saves_insert_own on public.backtest_save_states
for insert to authenticated with check (user_id = (select auth.uid()));
create policy backtest_saves_update_own on public.backtest_save_states
for update to authenticated using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));
create policy backtest_saves_delete_own on public.backtest_save_states
for delete to authenticated using (user_id = (select auth.uid()));

-- A session cannot be pointed at another user's dataset through its FK.
create or replace function public.check_backtest_save_dataset_owner()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.dataset_id is not null and not exists (
    select 1 from public.datasets d
      where d.id = new.dataset_id and d.user_id = new.user_id
  ) then
    raise exception 'Dataset is not owned by save-state user';
  end if;
  return new;
end
$$;

create trigger backtest_save_dataset_owner_trigger
before insert or update of dataset_id, user_id on public.backtest_save_states
for each row execute function public.check_backtest_save_dataset_owner();
