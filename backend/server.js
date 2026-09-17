import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

app.use(cors());
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ANARHY OS', version: 'mvp-0.1' }));

app.get('/api/config', (_req, res) => res.json({
  productPriceRub: Number(process.env.PRODUCT_PRICE_RUB || 7000),
  commissionPercent: Number(process.env.PARTNER_COMMISSION_PERCENT || 30),
  deadline: '22:00',
  dailyTikTokTasks: 3,
  trialDays: 9
}));

app.get('/api/dashboard/:userId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
  try {
    const user = await pool.query('select id, username, role, xp, level, strikes, streak_days from profiles where id=$1', [req.params.userId]);
    const tasks = await pool.query('select id, title, xp_reward, due_time from daily_tasks where active=true order by sort_order asc');
    const partner = await pool.query('select * from partner_profiles where user_id=$1', [req.params.userId]);
    res.json({ user: user.rows[0] || null, tasks: tasks.rows, partner: partner.rows[0] || null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/partner/click', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
  const { code, source, landingPath } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  try {
    const result = await pool.query(`
      insert into partner_clicks (partner_code, source, landing_path)
      values ($1,$2,$3) returning id, created_at
    `, [code, source || null, landingPath || null]);
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/admin/confirm-sale', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const order = await client.query('select * from product_orders where id=$1 for update', [orderId]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].status === 'confirmed') return res.json({ ok: true, alreadyConfirmed: true });
    const commission = Math.round(Number(order.rows[0].amount_rub) * Number(process.env.PARTNER_COMMISSION_PERCENT || 30) / 100);
    await client.query(`update product_orders set status='confirmed', confirmed_at=now() where id=$1`, [orderId]);
    await client.query(`insert into partner_commissions (order_id, partner_user_id, amount_rub, status) values ($1,$2,$3,'available')`, [orderId, order.rows[0].partner_user_id, commission]);
    await client.query('commit');
    res.json({ ok: true, commissionRub: commission });
  } catch (error) { await client.query('rollback'); res.status(500).json({ error: error.message }); }
  finally { client.release(); }
});

app.listen(port, () => console.log(`ANARHY OS API running on http://localhost:${port}`));
