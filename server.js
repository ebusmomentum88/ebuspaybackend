const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
  }
});

// Create tables
const createTables = async () => {
  const usersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(11) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      balance DECIMAL(10, 2) DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const transactionsTable = `
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      description TEXT NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      status VARCHAR(20) DEFAULT 'completed',
      reference VARCHAR(100) UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const depositsTable = `
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      amount DECIMAL(10, 2) NOT NULL,
      reference VARCHAR(100) UNIQUE NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await pool.query(usersTable);
    await pool.query(transactionsTable);
    await pool.query(depositsTable);
    console.log('✅ All tables created successfully');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
};

createTables();

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'paybill_secret_key_2024';

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: 'Invalid token' });
  }
};

// ========== AUTH ROUTES ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    // Validation
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR phone = $2',
      [email, phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      'INSERT INTO users (name, email, phone, password, balance) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, phone, balance',
      [name, email, phone, hashedPassword, 0.00]
    );

    const user = result.rows[0];

    // Generate token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        balance: parseFloat(user.balance)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    // Find user
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        balance: parseFloat(user.balance)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ========== USER ROUTES ==========

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, balance, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        balance: parseFloat(user.balance),
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get user balance
app.get('/api/user/balance', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      balance: parseFloat(result.rows[0].balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ========== TRANSACTION ROUTES ==========

// Get user transactions
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );

    res.json({
      success: true,
      transactions: result.rows.map(t => ({
        id: t.id,
        type: t.type,
        description: t.description,
        amount: parseFloat(t.amount),
        status: t.status,
        reference: t.reference,
        created_at: t.created_at
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Buy Airtime
app.post('/api/services/airtime', authenticateToken, async (req, res) => {
  try {
    const { network, phone, amount } = req.body;

    // Validation
    if (!network || !phone || !amount) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (amount < 50) {
      return res.status(400).json({ success: false, message: 'Minimum airtime is ₦50' });
    }

    // Check balance
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = parseFloat(userResult.rows[0].balance);

    if (balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);

    // Create transaction
    const reference = 'AIR' + Date.now() + Math.floor(Math.random() * 1000);
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, reference) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'airtime', `${network} Airtime - ${phone}`, amount, reference]
    );

    // Get updated balance
    const updatedUser = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);

    res.json({
      success: true,
      message: 'Airtime purchase successful',
      reference,
      balance: parseFloat(updatedUser.rows[0].balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Buy Data
app.post('/api/services/data', authenticateToken, async (req, res) => {
  try {
    const { network, plan, phone, amount } = req.body;

    // Validation
    if (!network || !plan || !phone || !amount) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    // Check balance
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = parseFloat(userResult.rows[0].balance);

    if (balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);

    // Create transaction
    const reference = 'DATA' + Date.now() + Math.floor(Math.random() * 1000);
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, reference) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'data', `${network} Data - ${plan} to ${phone}`, amount, reference]
    );

    // Get updated balance
    const updatedUser = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);

    res.json({
      success: true,
      message: 'Data purchase successful',
      reference,
      balance: parseFloat(updatedUser.rows[0].balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Pay Electricity
app.post('/api/services/electricity', authenticateToken, async (req, res) => {
  try {
    const { disco, meterNumber, amount } = req.body;

    // Validation
    if (!disco || !meterNumber || !amount) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (amount < 500) {
      return res.status(400).json({ success: false, message: 'Minimum payment is ₦500' });
    }

    // Check balance
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = parseFloat(userResult.rows[0].balance);

    if (balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);

    // Create transaction
    const reference = 'ELEC' + Date.now() + Math.floor(Math.random() * 1000);
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, reference) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'electricity', `${disco} - Meter: ${meterNumber}`, amount, reference]
    );

    // Get updated balance
    const updatedUser = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);

    res.json({
      success: true,
      message: 'Electricity payment successful',
      reference,
      token: Math.random().toString(36).substr(2, 20).toUpperCase(),
      balance: parseFloat(updatedUser.rows[0].balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Book Transport
app.post('/api/services/transport', authenticateToken, async (req, res) => {
  try {
    const { company, from, to, date, amount } = req.body;

    // Validation
    if (!company || !from || !to || !date || !amount) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (amount < 1000) {
      return res.status(400).json({ success: false, message: 'Minimum booking is ₦1,000' });
    }

    // Check balance
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = parseFloat(userResult.rows[0].balance);

    if (balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);

    // Create transaction
    const reference = 'TRN' + Date.now() + Math.floor(Math.random() * 1000);
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, reference) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'transport', `${company} - ${from} to ${to} (${date})`, amount, reference]
    );

    // Get updated balance
    const updatedUser = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);

    res.json({
      success: true,
      message: 'Transport booking successful',
      reference,
      balance: parseFloat(updatedUser.rows[0].balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ========== DEPOSIT ROUTE ==========

// Deposit money (for testing - in production, integrate with payment gateway)
app.post('/api/deposit', authenticateToken, async (req, res) => {
  try {
    const { amount, reference } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum deposit is ₦100' });
    }

    // Add to balance
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, req.user.id]);

    // Record deposit
    await pool.query(
      'INSERT INTO deposits (user_id, amount, reference, status) VALUES ($1, $2, $3, $4)',
      [req.user.id, amount, reference || 'DEP' + Date.now(), 'completed']
    );

    // Create transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, description, amount, reference) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'deposit', 'Account deposit', amount, reference || 'DEP' + Date.now()]
    );

    // Get updated balance
    const updatedUser = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);

    res.json({
      success: true,
      message: 'Deposit successful',
      balance: parseFloat(updatedUser.rows[0].balance)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Paybill API is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});





