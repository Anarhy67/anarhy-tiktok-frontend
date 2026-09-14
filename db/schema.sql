create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  username text unique not null,
  role text not null default 'creator' check (role in ('creator','partner','admin')),
  xp integer not null default 0,
  level text not null default 'Rookie',
  strikes integer not null default 0,
  streak_days integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists daily_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  xp_reward integer not null default 120,
  due_time time not null default '22:00',
  sort_order integer not null default 0,
  active boolean not null default true
);

create table if not exists task_reports (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references daily_tasks(id),
  user_id uuid not null references profiles(id),
  video_url text not null,
  proof_url text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewer_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists partner_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references profiles(id),
  partner_code text unique not null,
  commission_percent numeric(5,2) not null default 30,
  status text not null default 'active' check (status in ('pending','active','blocked')),
  created_at timestamptz not null default now()
);

create table if not exists partner_clicks (
  id uuid primary key default gen_random_uuid(),
  partner_code text not null references partner_profiles(partner_code),
  source text,
  landing_path text,
  created_at timestamptz not null default now()
);

create table if not exists product_orders (
  id uuid primary key default gen_random_uuid(),
  partner_user_id uuid references profiles(id),
  partner_code text references partner_profiles(partner_code),
  amount_rub numeric(12,2) not null,
  external_payment_id text unique,
  status text not null default 'pending' check (status in ('pending','confirmed','refunded','cancelled')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists partner_commissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid unique not null references product_orders(id),
  partner_user_id uuid not null references profiles(id),
  amount_rub numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending','available','requested','paid','reversed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists payout_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  amount_rub numeric(12,2) not null,
  status text not null default 'requested' check (status in ('requested','approved','paid','rejected')),
  payment_details jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

insert into daily_tasks (title, description, xp_reward, sort_order)
select * from (values
  ('Hook / динамика','Сильный первый кадр и удержание внимания.',120,1),
  ('Story cut','Собрать короткую историю.',120,2),
  ('Trend adaptation','Адаптировать тренд под стиль ANARHY.',120,3)
) as v(title,description,xp_reward,sort_order)
where not exists (select 1 from daily_tasks);
