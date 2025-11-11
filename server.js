// server.js - Express + Postgres + Paystack verify
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://pay-bills-mxfj.vercel.app',
  credentials: true
}));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : false });
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

// Create tables on startup
const createTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(20),
      password VARCHAR(255),
      balance NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type VARCHAR(50),
      service_type TEXT,
      account TEXT,
      amount NUMERIC(14,2),
      reference VARCHAR(200) UNIQUE,
      status VARCHAR(30) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type VARCHAR(50),
      service_type TEXT,
      amount NUMERIC(14,2),
      reference VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Tables created/verified.");
};
createTables().catch(console.error);

// Auth helpers
const signToken = (user) => jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
const authMiddleware = (req,res,next) => {
  const h = req.headers.authorization;
  if(!h) return res.status(401).json({ success:false, message:'No token' });
  const token = h.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch(err) { return res.status(401).json({ success:false, message:'Invalid token' }); }
};

// ========== AUTH ==========
app.post('/api/auth/register', async (req,res) => {
  try {
    const { name, email, phone, password } = req.body;
    if(!email || !password) return res.status(400).json({ success:false, message:'Missing fields' });
    const hashed = await bcrypt.hash(password, 10);
    const q = await pool.query('INSERT INTO users (name,email,phone,password,balance) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,balance', [name||null,email,phone||null,hashed,0]);
    const user = q.rows[0];
    const token = signToken(user);
    res.json({ success:true, user:{ id:user.id, name:user.name, email:user.email, balance: parseFloat(user.balance) }, token });
  } catch(err) {
    console.error(err);
    res.status(400).json({ success:false, message: 'Email may already exist' });
  }
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const { email, password } = req.body;
    const q = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if(q.rowCount===0) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const user = q.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if(!valid) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const token = signToken(user);
    res.json({ success:true, user:{ id:user.id, name:user.name, email:user.email, balance: parseFloat(user.balance) }, token });
  } catch(err) {
    console.error(err); res.status(500).json({ success:false, message:'Server error' });
  }
});

// ========== PROFILE/BALANCE/TRANSACTIONS ==========
app.get('/api/user/profile', authMiddleware, async (req,res) => {
  try {
    const q = await pool.query('SELECT id,name,email,phone,balance,created_at FROM users WHERE id=$1', [req.user.id]);
    if(q.rowCount===0) return res.status(404).json({ success:false, message:'User not found' });
    const u = q.rows[0];
    res.json({ success:true, user:{ id:u.id, name:u.name, email:u.email, phone:u.phone, balance: parseFloat(u.balance), created_at:u.created_at } });
  } catch(err){ console.error(err); res.status(500).json({ success:false }) }
});

app.get('/api/user/balance', authMiddleware, async (req,res) => {
  try {
    const q = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
    res.json({ success:true, balance: parseFloat(q.rows[0].balance) });
  } catch(err){ console.error(err); res.status(500).json({ success:false }) }
});

app.get('/api/transactions', authMiddleware, async (req,res) => {
  try {
    const q = await pool.query('SELECT type, service_type, amount, reference, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ success:true, transactions: q.rows });
  } catch(err){ console.error(err); res.status(500).json({ success:false }) }
});

// ========== PAYMENT FLOW (initialize and verify) ==========
// Initialize a payment (create pending payment row and return reference)
app.post('/api/initialize', authMiddleware, async (req,res) => {
  try {
    const { type, service_type, account, amount } = req.body;
    if(!type || !amount) return res.status(400).json({ success:false, message:'Missing fields' });

    const reference = `${type.toUpperCase().slice(0,4)}_${Date.now()}_${Math.floor(Math.random()*9000+1000)}`;
    await pool.query('INSERT INTO payments (user_id,type,service_type,account,amount,reference,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.id, type, service_type||null, account||null, amount, reference, 'pending']);

    // return to client to open paystack with this ref
    return res.json({ success:true, reference, amount });
  } catch(err){ console.error(err); res.status(500).json({ success:false, message:'Initialization failed' }) }
});

// Verify Paystack reference and finalize transaction
app.post('/api/verify', authMiddleware, async (req,res) => {
  try {
    const { reference } = req.body;
    if(!reference) return res.status(400).json({ success:false, message:'Missing reference' });

    // Check local payments row
    const payQ = await pool.query('SELECT * FROM payments WHERE reference=$1', [reference]);
    if(payQ.rowCount===0) return res.status(400).json({ success:false, message:'Payment not found' });
    const payment = payQ.rows[0];
    if(payment.status === 'success') {
      // already processed
      const balQ = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
      return res.json({ success:true, message:'Already verified', balance: parseFloat(balQ.rows[0].balance) });
    }

    // verify via Paystack API
    if(!PAYSTACK_SECRET) return res.status(500).json({ success:false, message:'Paystack secret not configured' });

    const verifyUrl = `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`;
    const vRes = await axios.get(verifyUrl, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } });

    if(!(vRes.data && vRes.data.status && vRes.data.data && vRes.data.data.status === 'success')) {
      // mark failed
      await pool.query('UPDATE payments SET status=$1 WHERE id=$2', ['failed', payment.id]);
      return res.status(400).json({ success:false, message:'Payment not successful on Paystack' });
    }

    // At this point, Paystack payment is successful
    // Update payment record
    await pool.query('UPDATE payments SET status=$1 WHERE id=$2', ['success', payment.id]);

    // If deposit -> add to user's balance; else (services) deduct when payment was for service (we assume user paid customer -> you then deliver service)
    // For deposit: user balance increases by amount
    if(payment.type === 'deposit') {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [payment.amount, req.user.id]);
      await pool.query('INSERT INTO transactions (user_id,type,service_type,amount,reference) VALUES ($1,$2,$3,$4,$5)',
        [req.user.id, 'deposit', payment.service_type || 'deposit', payment.amount, reference]);
    } else {
      // For service payments we can either:
      // - keep the customer's balance unchanged (since they paid via Paystack), and record a transaction; OR
      // - if you have an internal wallet, first credit on deposit then deduct for service
      // Here: user paid via Paystack: record transaction and do NOT deduct balance (since money came from Paystack)
      // But if your UI uses wallet balance to pay, you'd deduct wallet instead. We'll assume Paystack direct payment (no wallet charge).
      // Insert transaction record
      await pool.query('INSERT INTO transactions (user_id,type,service_type,amount,reference) VALUES ($1,$2,$3,$4,$5)',
        [req.user.id, payment.type, payment.service_type, payment.amount, reference]);
    }

    // Return updated balance
    const balQ = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
    return res.json({ success:true, message:'Payment verified', balance: parseFloat(balQ.rows[0].balance) });

  } catch(err) {
    console.error("Verify error:", err?.response?.data || err.message || err);
    return res.status(500).json({ success:false, message:'Verification failed' });
  }
});

// health
app.get('/api/health', (req,res) => res.json({ status:'ok' }));

// start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));





