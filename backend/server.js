import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

const app = express();
const port = Number(process.env.PORT || 3000);

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

app.use(cors());
app.use(express.json());

const tokens = new Map();

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const userId = tokens.get(token);

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.userId = userId;
  next();
}

async function setupDatabase() {
  if (!pool) return;

  await pool.query(`
    create table if not exists profiles (
      id uuid primary key default gen_random_uuid(),
      username text unique not null,
      email text unique not null,
      password text not null,
      role text default 'user',
      xp integer default 0,
      level integer default 1,
      strikes integer default 0,
      streak_days integer default 0,
      about text default '',
      avatar_url text default '',
      created_at timestamptz default now()
    );

    create table if not exists daily_tasks (
      id serial primary key,
      title text not null,
      xp_reward integer default 10,
      due_time text default '22:00',
      active boolean default true,
      sort_order integer default 0
    );

    create table if not exists reports (
      id serial primary key,
      user_id uuid references profiles(id) on delete cascade,
      report_date date default current_date,
      videos_count integer default 0,
      comment text default '',
      status text default 'pending',
      created_at timestamptz default now(),
      unique(user_id, report_date)
    );

    create table if not exists partner_profiles (
      id serial primary key,
      user_id uuid unique references profiles(id) on delete cascade,
      partner_code text unique,
      clicks integer default 0,
      sales integer default 0,
      earnings integer default 0
    );

    create table if not exists partner_clicks (
      id serial primary key,
      partner_code text,
      source text,
      landing_path text,
      created_at timestamptz default now()
    );

    create table if not exists product_orders (
      id serial primary key,
      partner_user_id uuid references profiles(id),
      amount_rub integer default 7000,
      status text default 'pending',
      confirmed_at timestamptz
    );

    create table if not exists partner_commissions (
      id serial primary key,
      order_id integer references product_orders(id),
      partner_user_id uuid references profiles(id),
      amount_rub integer default 0,
      status text default 'available',
      created_at timestamptz default now()
    );
  `);

  const taskCheck = await pool.query(
    'select count(*)::int as count from daily_tasks'
  );

  if (taskCheck.rows[0].count === 0) {
    await pool.query(`
      insert into daily_tasks (title, xp_reward, due_time, sort_order)
      values
      ('Опубликовать TikTok-ролик №1', 10, '22:00', 1),
      ('Опубликовать TikTok-ролик №2', 10, '22:00', 2),
      ('Опубликовать TikTok-ролик №3', 10, '22:00', 3)
    `);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ANARHY OS',
    version: '2.0'
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    productPriceRub: Number(process.env.PRODUCT_PRICE_RUB || 7000),
    commissionPercent: Number(
      process.env.PARTNER_COMMISSION_PERCENT || 30
    ),
    deadline: '22:00',
    dailyTikTokTasks: 3,
    trialDays: 9
  });
});

app.post('/api/register', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'DATABASE_URL is not configured' });
  }

  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({
      error: 'Username, email and password are required'
    });
  }

  try {
    const exists = await pool.query(
      'select id from profiles where username=$1 or email=$2',
      [username, email]
    );

    if (exists.rows.length) {
      return res.status(409).json({
        error: 'User already exists'
      });
    }

    const user = await pool.query(
      `insert into profiles (username, email, password)
       values ($1,$2,$3)
       returning id, username, email, role, xp, level, strikes, streak_days,
                 about, avatar_url`,
      [username, email, password]
    );

    const profile = user.rows[0];

    const partnerCode = `anarhy-${profile.id.slice(0, 8)}`;

    await pool.query(
      `insert into partner_profiles (user_id, partner_code)
       values ($1,$2)
       on conflict (user_id) do nothing`,
      [profile.id, partnerCode]
    );

    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, profile.id);

    res.status(201).json({
      token,
      user: profile
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'DATABASE_URL is not configured' });
  }

  const { email, username, password } = req.body;
  const login = email || username;

  if (!login || !password) {
    return res.status(400).json({
      error: 'Login and password are required'
    });
  }

  try {
    const result = await pool.query(
      `select id, username, email, role, xp, level, strikes,
              streak_days, about, avatar_url
       from profiles
       where (email=$1 or username=$1) and password=$2`,
      [login, password]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: 'Invalid login or password'
      });
    }

    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString('hex');

    tokens.set(token, user.id);

    res.json({
      token,
      user
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `select id, username, email, role, xp, level, strikes,
              streak_days, about, avatar_url
       from profiles where id=$1`,
      [req.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profile', auth, async (req, res) => {
  const result = await pool.query(
    `select id, username, email, role, xp, level, strikes,
            streak_days, about, avatar_url
     from profiles where id=$1`,
    [req.userId]
  );

  res.json(result.rows[0] || null);
});

app.put('/api/profile', auth, async (req, res) => {
  const { username, email, about, avatar_url, avatarUrl } = req.body;

  try {
    const result = await pool.query(
      `update profiles
       set username=coalesce($1, username),
           email=coalesce($2, email),
           about=coalesce($3, about),
           avatar_url=coalesce($4, avatar_url)
       where id=$5
       returning id, username, email, role, xp, level, strikes,
                 streak_days, about, avatar_url`,
      [
        username || null,
        email || null,
        about ?? null,
        avatar_url ?? avatarUrl ?? null,
        req.userId
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tasks', auth, async (_req, res) => {
  const result = await pool.query(
    `select id, title, xp_reward, due_time
     from daily_tasks
     where active=true
     order by sort_order asc`
  );

  res.json(result.rows);
});

app.post('/api/reports', auth, async (req, res) => {
  const { videos_count, videosCount, comment } = req.body;
  const count = Number(videos_count ?? videosCount ?? 0);

  try {
    const result = await pool.query(
      `insert into reports (user_id, videos_count, comment)
       values ($1,$2,$3)
       on conflict (user_id, report_date)
       do update set videos_count=$2, comment=$3
       returning *`,
      [req.userId, count, comment || '']
    );

    if (count >= 3) {
      await pool.query(
        `update profiles
         set xp=xp+30, streak_days=streak_days+1
         where id=$1`,
        [req.userId]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports', auth, async (req, res) => {
  const result = await pool.query(
    `select * from reports
     where user_id=$1
     order by report_date desc`,
    [req.userId]
  );

  res.json(result.rows);
});

app.get('/api/progress', auth, async (req, res) => {
  const result = await pool.query(
    `select
       count(*)::int as total_reports,
       coalesce(sum(videos_count),0)::int as total_videos,
       coalesce(sum(case when videos_count >= 3 then 1 else 0 end),0)::int
         as completed_days
     from reports
     where user_id=$1`,
    [req.userId]
  );

  res.json(result.rows[0]);
});

app.get('/api/rating', async (_req, res) => {
  const result = await pool.query(
    `select username, xp, level, streak_days
     from profiles
     order by xp desc, level desc
     limit 100`
  );

  res.json(result.rows);
});

app.get('/api/dashboard/:userId', async (req, res) => {
  try {
    const user = await pool.query(
      `select id, username, email, role, xp, level, strikes,
              streak_days, about, avatar_url
       from profiles where id=$1`,
      [req.params.userId]
    );

    const tasks = await pool.query(
      `select id, title, xp_reward, due_time
       from daily_tasks
       where active=true
       order by sort_order asc`
    );

    const partner = await pool.query(
      'select * from partner_profiles where user_id=$1',
      [req.params.userId]
    );

    res.json({
      user: user.rows[0] || null,
      tasks: tasks.rows,
      partner: partner.rows[0] || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/partner/click', async (req, res) => {
  const { code, source, landingPath } = req.body;

  if (!code) {
    return res.status(400).json({
      error: 'code is required'
    });
  }

  try {
    const result = await pool.query(
      `insert into partner_clicks
       (partner_code, source, landing_path)
       values ($1,$2,$3)
       returning id, created_at`,
      [code, source || null, landingPath || null]
    );

    await pool.query(
      `update partner_profiles
       set clicks=clicks+1
       where partner_code=$1`,
      [code]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/confirm-sale', async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({
      error: 'orderId is required'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const order = await client.query(
      'select * from product_orders where id=$1 for update',
      [orderId]
    );

    if (!order.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (order.rows[0].status === 'confirmed') {
      await client.query('commit');
      return res.json({
        ok: true,
        alreadyConfirmed: true
      });
    }

    const commission = Math.round(
      Number(order.rows[0].amount_rub) *
      Number(process.env.PARTNER_COMMISSION_PERCENT || 30) / 100
    );

    await client.query(
      `update product_orders
       set status='confirmed', confirmed_at=now()
       where id=$1`,
      [orderId]
    );

    await client.query(
      `insert into partner_commissions
       (order_id, partner_user_id, amount_rub, status)
       values ($1,$2,$3,'available')`,
      [
        orderId,
        order.rows[0].partner_user_id,
        commission
      ]
    );

    await client.query('commit');

    res.json({
      ok: true,
      commissionRub: commission
    });
  } catch (error) {
    await client.query('rollback');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

setupDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`ANARHY OS API running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error('Database setup failed:', error);
    app.listen(port, () => {
      console.log(`ANARHY OS API running on port ${port}`);
    });
  });
