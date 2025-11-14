require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();

// Allow frontend
app.use(cors({
  origin: ['https://pay-bills-2.vercel.app', 'https://paymoment-flow.vercel.app'],
  credentials: true
}));
app.use(bodyParser.json());

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET;

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ message: 'Invalid token' });
  }
};

// ====================== AUTH ======================
app.post('/api/auth/signup', async (req, res) => {
  let { name, email, phone, password } = req.body;
  email = email.trim().toLowerCase();
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rowCount > 0) return res.status(400).json({ message: 'Email already exists' });

    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, email, phone, password, balance) VALUES ($1, $2, $3, $4, $5)',
      [name, email, phone, hashed, 5000] // default balance
    );

    const newUser = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    const token = jwt.sign({ id: newUser.rows[0].id, email: newUser.rows[0].email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { 
        id: newUser.rows[0].id, 
        name: newUser.rows[0].name, 
        email: newUser.rows[0].email, 
        balance: newUser.rows[0].balance 
      }
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Error creating user' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  let { email, password } = req.body;
  email = email.trim().toLowerCase();
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (result.rowCount === 0) return res.status(400).json({ message: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, balance: user.balance }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Login error' });
  }
});

// ====================== PAYSTACK DEPOSIT ======================
app.post('/api/paystack/initialize', authenticateToken, async (req, res) => {
  const { amount, email } = req.body;
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      { email, amount: amount * 100 },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: 'Paystack initialization failed' });
  }
});

app.post('/api/paystack/verify', authenticateToken, async (req, res) => {
  const { reference } = req.body;
  try {
    const verify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });

    if (verify.data.data.status === 'success') {
      const amount = verify.data.data.amount / 100;
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [amount, req.user.id]);
      await pool.query(
        'INSERT INTO transactions (user_id, type, description, amount, reference, status) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.user.id, 'deposit', 'Wallet funding via Paystack', amount, reference, 'completed']
      );
      res.json({ success: true, message: 'Deposit successful', amount });
    } else {
      res.status(400).json({ success: false, message: 'Verification failed' });
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: 'Verification error' });
  }
});

// ====================== SERVICES PAY ======================
app.post('/api/services/pay', authenticateToken, async (req, res) => {
  const { type, description, amount } = req.body;
  try {
    const user = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
    const balance = parseFloat(user.rows[0].balance);
    if (balance < amount) return res.status(400).json({ message: 'Insufficient balance' });

    await pool.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [amount, req.user.id]);
    const ref = `${type.toUpperCase()}-${Date.now()}`;
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, reference, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, type, description, amount, ref, 'completed']
    );

    res.json({ success: true, message: `${type} payment successful`, reference: ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Payment error' });
  }
});

// ====================== BALANCE & TRANSACTIONS ======================
app.get('/api/user/balance', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
    res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Unable to fetch balance' });
  }
});

app.get('/api/user/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Unable to fetch transactions' });
  }
});

// ====================== SERVER ======================
app.get('/', (req, res) => res.send('✅ PayMoment Backend is Live'));
app.listen(process.env.PORT || 5000, () =>
  console.log(`🚀 Server running on port ${process.env.PORT || 5000}`)
);
















