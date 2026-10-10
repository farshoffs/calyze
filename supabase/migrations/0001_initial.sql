-- Calyze initial schema.
-- All browser-accessible tables use per-user RLS. The frontend uses a publishable key only.

create table if not exists public.datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  symbol text not null,
  source text not null default 'ctrader_csv',
  base_timeframe text not null default 'M1',
  row_count bigint not null default 0,
  first_ts timestamptz,
  last_ts timestamptz,
  instrument jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.market_candles (
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume double precision not null default 0,
  primary key (dataset_id, ts)
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id uuid references public.datasets(id) on delete set null,
  name text not null default 'Workspace',
  timeframe text not null default 'M15',
  replay_time timestamptz,
  settings jsonb not null default '{}'::jsonb,
  drawings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.backtest_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null default 'Backtest account',
  currency text not null default 'USD',
  initial_balance numeric(20,8) not null,
  balance numeric(20,8) not null,
  leverage numeric(20,8) not null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.backtest_accounts(id) on delete cascade,
  dataset_id uuid references public.datasets(id) on delete set null,
  side text not null check (side in ('buy', 'sell')),
  lots numeric(20,8) not null check (lots > 0),
  open_time timestamptz not null,
  open_price numeric(24,10) not null,
  stop_loss numeric(24,10),
  take_profit numeric(24,10),
  close_time timestamptz,
  close_price numeric(24,10),
  raw_pnl numeric(20,8),
  net_pnl numeric(20,8),
  commission numeric(20,8) not null default 0,
  exit_reason text,
  created_at timestamptz not null default now()
);

create index if not exists datasets_user_created_idx on public.datasets(user_id, created_at desc);
create index if not exists market_candles_user_dataset_ts_idx on public.market_candles(user_id, dataset_id, ts);
create index if not exists workspaces_user_updated_idx on public.workspaces(user_id, updated_at desc);
create index if not exists trades_user_account_open_idx on public.trades(user_id, account_id, open_time);

alter table public.datasets enable row level security;
alter table public.market_candles enable row level security;
alter table public.workspaces enable row level security;
alter table public.backtest_accounts enable row level security;
alter table public.trades enable row level security;

grant select, insert, update, delete on public.datasets to authenticated;
grant select, insert, update, delete on public.market_candles to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.backtest_accounts to authenticated;
grant select, insert, update, delete on public.trades to authenticated;

create policy "datasets_select_own" on public.datasets for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "datasets_insert_own" on public.datasets for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "datasets_update_own" on public.datasets for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "datasets_delete_own" on public.datasets for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "candles_select_own" on public.market_candles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "candles_insert_own" on public.market_candles for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "candles_update_own" on public.market_candles for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "candles_delete_own" on public.market_candles for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "workspaces_select_own" on public.workspaces for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "workspaces_insert_own" on public.workspaces for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "workspaces_update_own" on public.workspaces for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "workspaces_delete_own" on public.workspaces for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "accounts_select_own" on public.backtest_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "accounts_insert_own" on public.backtest_accounts for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "accounts_update_own" on public.backtest_accounts for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "accounts_delete_own" on public.backtest_accounts for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "trades_select_own" on public.trades for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "trades_insert_own" on public.trades for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "trades_update_own" on public.trades for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "trades_delete_own" on public.trades for delete to authenticated
  using ((select auth.uid()) = user_id);
