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
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

const JWT_SECRET = process.env.JWT_SECRET || 'anarhy-change-this-secret';

app.use(cors());
app.use(express.json());

/* =========================
   BASIC HELPERS
========================= */

function errorMessage(error) {
  return error?.message || 'Unknown server error';
}

function makeToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  };

  const encoded = Buffer
    .from(JSON.stringify(payload))
    .toString('base64url');

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${signature}`;
}

function readToken(token) {
  try {
    const [encoded, signature] = String(token || '').split('.');

    if (!encoded || !signature) return null;

    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(encoded)
      .digest('base64url');

    if (signature !== expected) return null;

    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString()
    );

    if (!payload.exp || payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : null;

  const user = readToken(token);

  if (!user) {
    return res.status(401).json({
      error: 'Необходима авторизация'
    });
  }

  req.authUser = user;
  next();
}

function adminOnly(req, res, next) {
  if (!['admin', 'owner'].includes(req.authUser?.role)) {
    return res.status(403).json({
      error: 'Доступ только для администратора'
    });
  }

  next();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString('hex');

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  try {
    const [salt, storedHash] = String(storedPassword).split(':');

    if (!salt || !storedHash) return false;

    const hash = crypto
      .scryptSync(password, salt, 64)
      .toString('hex');

    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(storedHash, 'hex')
    );
  } catch {
    return false;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    nickname: user.nickname,
    email: user.email,
    avatar: user.avatar,
    about: user.about,
    role: user.role,
    xp: user.xp,
    level: user.level,
    penalties: user.penalties,
    streak_days: user.streak_days
  };
}

function requireDatabase(res) {
  if (!pool) {
    res.status(503).json({
      error: 'DATABASE_URL is not configured in Render'
    });

    return false;
  }

  return true;
}

/* =========================
   DATABASE SETUP
========================= */

async function setupDatabase() {
  if (!pool) {
    console.log('DATABASE_URL is not configured');
    return;
  }

  await pool.query(`
    create table if not exists profiles (
      id serial primary key,
      name text not null,
      nickname text not null unique,
      email text not null unique,
      password_hash text not null,
      avatar text default '',
      about text default '',
      role text not null default 'user',
      xp integer not null default 0,
      level integer not null default 1,
      penalties integer not null default 0,
      strikes integer not null default 0,
      streak_days integer not null default 0,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create table if not exists daily_tasks (
      id serial primary key,
      title text not null,
      description text default '',
      xp_reward integer not null default 10,
      videos_required integer not null default 3,
      deadline text not null default '22:00',
      due_time text not null default '22:00',
      active boolean not null default true,
      sort_order integer not null default 0,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create table if not exists reports (
      id serial primary key,
      user_id integer not null references profiles(id) on delete cascade,
      task_id integer not null references daily_tasks(id) on delete cascade,
      video_url text not null,
      text text default '',
      status text not null default 'pending',
      report_date date not null default current_date,
      created_at timestamptz not null default now(),
      reviewed_at timestamptz,
      reviewed_by integer references profiles(id)
    )
  `);

  await pool.query(`
    create table if not exists partner_profiles (
      id serial primary key,
      user_id integer not null unique references profiles(id) on delete cascade,
      partner_code text not null unique,
      clicks integer not null default 0,
      sales integer not null default 0,
      earned_rub integer not null default 0,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create table if not exists partner_clicks (
      id serial primary key,
      partner_code text not null,
      source text,
      landing_path text,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create table if not exists product_orders (
      id serial primary key,
      partner_user_id integer references profiles(id),
      amount_rub integer not null default 7000,
      status text not null default 'pending',
      confirmed_at timestamptz,
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create table if not exists partner_commissions (
      id serial primary key,
      order_id integer references product_orders(id),
      partner_user_id integer references profiles(id),
      amount_rub integer not null default 0,
      status text not null default 'available',
      created_at timestamptz not null default now()
    )
  `);

  const tasks = await pool.query(`
    select count(*)::int as count
    from daily_tasks
  `);

  if (tasks.rows[0].count === 0) {
    await pool.query(`
      insert into daily_tasks
        (title, description, xp_reward, videos_required, deadline, due_time, sort_order)
      values
        ('TikTok ролик №1', 'Опубликовать первый ролик за сегодня.', 10, 1, '22:00', '22:00', 1),
        ('TikTok ролик №2', 'Опубликовать второй ролик за сегодня.', 10, 1, '22:00', '22:00', 2),
        ('TikTok ролик №3', 'Опубликовать третий ролик за сегодня.', 10, 1, '22:00', '22:00', 3)
    `);
  }

  console.log('Database ready');
}

/* =========================
   HEALTH / CONFIG
========================= */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ANARHY OS',
    version: 'v2'
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

/* =========================
   AUTH
========================= */

app.post('/api/register', async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    name,
    nickname,
    email,
    password
  } = req.body;

  if (!name || !nickname || !email || !password) {
    return res.status(400).json({
      error: 'Заполни все поля'
    });
  }

  if (String(password).length < 6) {
    return res.status(400).json({
      error: 'Пароль должен быть минимум 6 символов'
    });
  }

  try {
    const exists = await pool.query(
      `
      select id
      from profiles
      where lower(email)=lower($1)
         or lower(nickname)=lower($2)
      `,
      [email, nickname]
    );

    if (exists.rows[0]) {
      return res.status(409).json({
        error: 'Email или nickname уже занят'
      });
    }

    const passwordHash = hashPassword(password);

    const result = await pool.query(
      `
      insert into profiles
        (name, nickname, email, password_hash)
      values
        ($1,$2,$3,$4)
      returning *
      `,
      [name, nickname, email, passwordHash]
    );

    const user = result.rows[0];

    await pool.query(
      `
      insert into partner_profiles
        (user_id, partner_code)
      values
        ($1,$2)
      `,
      [user.id, `anarhy-${user.id}-${crypto.randomBytes(3).toString('hex')}`]
    );

    res.status(201).json({
      token: makeToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

app.post('/api/login', async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    email,
    nickname,
    password
  } = req.body;

  const value = email || nickname;

  if (!value || !password) {
    return res.status(400).json({
      error: 'Введи логин и пароль'
    });
  }

  try {
    const result = await pool.query(
      `
      select *
      from profiles
      where lower(email)=lower($1)
         or lower(nickname)=lower($1)
      limit 1
      `,
      [value]
    );

    const user = result.rows[0];

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        error: 'Неверный логин или пароль'
      });
    }

    res.json({
      token: makeToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

app.get('/api/me', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      `select * from profiles where id=$1`,
      [req.authUser.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'Пользователь не найден'
      });
    }

    res.json({
      user: publicUser(result.rows[0])
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   PROFILE
========================= */

app.put('/api/profile', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    name,
    nickname,
    email,
    avatar,
    about
  } = req.body;

  if (!name || !nickname || !email) {
    return res.status(400).json({
      error: 'Имя, nickname и email обязательны'
    });
  }

  try {
    const duplicate = await pool.query(
      `
      select id
      from profiles
      where (lower(email)=lower($1) or lower(nickname)=lower($2))
        and id<>$3
      `,
      [email, nickname, req.authUser.id]
    );

    if (duplicate.rows[0]) {
      return res.status(409).json({
        error: 'Этот email или nickname уже используется'
      });
    }

    const result = await pool.query(
      `
      update profiles
      set name=$1,
          nickname=$2,
          email=$3,
          avatar=$4,
          about=$5
      where id=$6
      returning *
      `,
      [
        name,
        nickname,
        email,
        avatar || '',
        about || '',
        req.authUser.id
      ]
    );

    res.json({
      user: publicUser(result.rows[0])
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   TASKS
========================= */

app.get('/api/tasks', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(`
      select
        id,
        title,
        description,
        xp_reward,
        videos_required,
        deadline,
        due_time
      from daily_tasks
      where active=true
      order by sort_order asc, id asc
    `);

    res.json({
      tasks: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   REPORTS
========================= */

app.get('/api/reports', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      `
      select
        r.id,
        r.video_url,
        r.text,
        r.status,
        r.report_date,
        r.created_at,
        t.title as task_title,
        t.xp_reward
      from reports r
      join daily_tasks t on t.id=r.task_id
      where r.user_id=$1
      order by r.created_at desc
      `,
      [req.authUser.id]
    );

    res.json({
      reports: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

app.post('/api/reports', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    taskId,
    videoUrl,
    text
  } = req.body;

  if (!taskId || !videoUrl) {
    return res.status(400).json({
      error: 'taskId и videoUrl обязательны'
    });
  }

  try {
    const task = await pool.query(
      `
      select *
      from daily_tasks
      where id=$1 and active=true
      `,
      [taskId]
    );

    if (!task.rows[0]) {
      return res.status(404).json({
        error: 'Задание не найдено'
      });
    }

    const result = await pool.query(
      `
      insert into reports
        (user_id, task_id, video_url, text)
      values
        ($1,$2,$3,$4)
      returning *
      `,
      [
        req.authUser.id,
        taskId,
        videoUrl,
        text || ''
      ]
    );

    res.status(201).json({
      report: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   PROGRESS
========================= */

app.get('/api/progress', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(
      `
      select
        count(*)::int as "totalReports",
        count(*) filter (where status='approved')::int as "approvedReports",
        count(*) filter (
          where report_date=current_date
        )::int as "todayReports"
      from reports
      where user_id=$1
      `,
      [req.authUser.id]
    );

    res.json({
      progress: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   RATING
========================= */

app.get('/api/rating', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(`
      select
        name,
        nickname,
        level,
        xp
      from profiles
      order by xp desc, level desc, name asc
      limit 100
    `);

    res.json({
      rating: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   DASHBOARD
========================= */

app.get('/api/dashboard/:userId', auth, async (req, res) => {
  if (!requireDatabase(res)) return;

  const userId = Number(req.params.userId);

  if (
    req.authUser.id !== userId &&
    !['admin', 'owner'].includes(req.authUser.role)
  ) {
    return res.status(403).json({
      error: 'Нет доступа'
    });
  }

  try {
    const user = await pool.query(
      `
      select
        id,
        name,
        nickname,
        email,
        role,
        xp,
        level,
        penalties,
        strikes,
        streak_days
      from profiles
      where id=$1
      `,
      [userId]
    );

    const tasks = await pool.query(`
      select
        id,
        title,
        description,
        xp_reward,
        videos_required,
        deadline,
        due_time
      from daily_tasks
      where active=true
      order by sort_order asc
    `);

    const partner = await pool.query(
      `
      select *
      from partner_profiles
      where user_id=$1
      `,
      [userId]
    );

    res.json({
      user: user.rows[0] || null,
      tasks: tasks.rows,
      partner: partner.rows[0] || null
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   PARTNERS
========================= */

app.post('/api/partner/click', async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    code,
    source,
    landingPath
  } = req.body;

  if (!code) {
    return res.status(400).json({
      error: 'code is required'
    });
  }

  try {
    const result = await pool.query(
      `
      insert into partner_clicks
        (partner_code, source, landing_path)
      values
        ($1,$2,$3)
      returning id, created_at
      `,
      [
        code,
        source || null,
        landingPath || null
      ]
    );

    await pool.query(
      `
      update partner_profiles
      set clicks=clicks+1
      where partner_code=$1
      `,
      [code]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

/* =========================
   ADMIN
========================= */

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(`
      select
        id,
        name,
        nickname,
        email,
        role,
        xp,
        level,
        penalties,
        created_at
      from profiles
      order by created_at desc
    `);

    res.json({
      users: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

app.get('/api/admin/reports', auth, adminOnly, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await pool.query(`
      select
        r.id,
        r.video_url,
        r.text,
        r.status,
        r.report_date,
        r.created_at,
        p.name,
        p.nickname,
        t.title as task_title,
        t.xp_reward
      from reports r
      join profiles p on p.id=r.user_id
      join daily_tasks t on t.id=r.task_id
      order by r.created_at desc
    `);

    res.json({
      reports: result.rows
    });
  } catch (error) {
    res.status(500).json({
      error: errorMessage(error)
    });
  }
});

app.post('/api/admin/review-report', auth, adminOnly, async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    reportId,
    status
  } = req.body;

  if (!reportId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({
      error: 'reportId и корректный status обязательны'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const report = await client.query(
      `
      select
        r.*,
        t.xp_reward
      from reports r
      join daily_tasks t on t.id=r.task_id
      where r.id=$1
      for update
      `,
      [reportId]
    );

    if (!report.rows[0]) {
      await client.query('rollback');

      return res.status(404).json({
        error: 'Отчёт не найден'
      });
    }

    const current = report.rows[0];

    if (current.status !== 'pending') {
      await client.query('rollback');

      return res.json({
        ok: true,
        alreadyReviewed: true,
        status: current.status
      });
    }

    await client.query(
      `
      update reports
      set status=$1,
          reviewed_at=now(),
          reviewed_by=$2
      where id=$3
      `,
      [
        status,
        req.authUser.id,
        reportId
      ]
    );

    if (status === 'approved') {
      await client.query(
        `
        update profiles
        set xp=xp+$1,
            level=greatest(1, floor((xp+$1)/100)+1)
        where id=$2
        `,
        [
          Number(current.xp_reward || 0),
          current.user_id
        ]
      );
    } else {
      await client.query(
        `
        update profiles
        set penalties=penalties+1,
            strikes=strikes+1
        where id=$1
        `,
        [current.user_id]
      );
    }

    await client.query('commit');

    res.json({
      ok: true,
      status
    });
  } catch (error) {
    await client.query('rollback');

    res.status(500).json({
      error: errorMessage(error)
    });
  } finally {
    client.release();
  }
});

app.post('/api/admin/confirm-sale', auth, adminOnly, async (req, res) => {
  if (!requireDatabase(res)) return;

  const {
    orderId
  } = req.body;

  if (!orderId) {
    return res.status(400).json({
      error: 'orderId is required'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const order = await client.query(
      `
      select *
      from product_orders
      where id=$1
      for update
      `,
      [orderId]
    );

    if (!order.rows[0]) {
      await client.query('rollback');

      return res.status(404).json({
        error: 'Order not found'
      });
    }

    const current = order.rows[0];

    if (current.status === 'confirmed') {
      await client.query('rollback');

      return res.json({
        ok: true,
        alreadyConfirmed: true
      });
    }

    const commission = Math.round(
      Number(current.amount_rub) *
      Number(process.env.PARTNER_COMMISSION_PERCENT || 30) /
      100
    );

    await client.query(
      `
      update product_orders
      set status='confirmed',
          confirmed_at=now()
      where id=$1
      `,
      [orderId]
    );

    await client.query(
      `
      insert into partner_commissions
        (order_id, partner_user_id, amount_rub, status)
      values
        ($1,$2,$3,'available')
      `,
      [
        orderId,
        current.partner_user_id,
        commission
      ]
    );

    await client.query(
      `
      update partner_profiles
      set sales=sales+1,
          earned_rub=earned_rub+$1
      where user_id=$2
      `,
      [
        commission,
        current.partner_user_id
      ]
    );

    await client.query('commit');

    res.json({
      ok: true,
      commissionRub: commission
    });
  } catch (error) {
    await client.query('rollback');

    res.status(500).json({
      error: errorMessage(error)
    });
  } finally {
    client.release();
  }
});

/* =========================
   START SERVER
========================= */

async function start() {
  try {
    await setupDatabase();

    app.listen(port, () => {
      console.log(
        `ANARHY OS API running on port ${port}`
      );
    });
  } catch (error) {
    console.error(
      'Failed to start ANARHY OS API:',
      errorMessage(error)
    );

    process.exit(1);
  }
}

start();
