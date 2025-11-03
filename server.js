// server.js (replace your existing backend file with this or merge)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Load environment variables
const PORT = process.env.PORT || 5000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const CLIENT_URL = process.env.CLIENT_URL || 'http://ebuspay.vercel.app';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ebusadmin123'; // change in Render env

if (!DATABASE_URL || !JWT_SECRET || !PAYSTACK_SECRET_KEY) {
  console.error('❌ Please set DATABASE_URL, JWT_SECRET, and PAYSTACK_SECRET_KEY in Render environment variables');
  process.exit(1);
}

// Initialize Express
const app = express();
app.use(cors({ origin: ['https://ebuspay.vercel.app', 'http://localhost:3000'], credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------- UPLOADS (multer) --------------------
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const fn = `${Date.now()}-${Math.round(Math.random()*1e6)}${ext}`;
    cb(null, fn);
  }
});
const upload = multer({ storage });

// Serve uploaded images
app.use('/uploads', express.static(uploadDir));

// -------------------- DATABASE --------------------
const sequelize = new Sequelize(DATABASE_URL, { dialect: 'postgres', logging: false });

sequelize.authenticate()
  .then(() => console.log('✅ PostgreSQL connected successfully'))
  .catch(err => { console.error('❌ DB Connection Error:', err.message); process.exit(1); });

// -------------------- MODELS --------------------
const User = sequelize.define('User', {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  balance: { type: DataTypes.FLOAT, defaultValue: 0 }
});

const Transaction = sequelize.define('Transaction', {
  type: { type: DataTypes.ENUM('deposit', 'withdrawal', 'transfer'), allowNull: false },
  amount: { type: DataTypes.FLOAT, allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'completed', 'failed'), defaultValue: 'pending' },
  reference: { type: DataTypes.STRING, allowNull: false, unique: true },
  description: { type: DataTypes.STRING, defaultValue: 'Deposit via Paystack' }
});

User.hasMany(Transaction);
Transaction.belongsTo(User);

// News model
const News = sequelize.define('News', {
  title: { type: DataTypes.STRING, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
  imageUrl: { type: DataTypes.STRING }, // e.g. '/uploads/12345.jpg' or a full URL
  publishedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

sequelize.sync({ alter: true })
  .then(() => console.log('✅ Models synced'))
  .catch(err => console.error('Sync error', err));

// -------------------- HELPERS --------------------
const generateToken = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findByPk(decoded.id);
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Token invalid' });
  }
};

// -------------------- ROUTES --------------------

// Health check
app.get('/', (req, res) => res.json({ success: true, message: 'EbusPay API running ✅' }));

// Auth routes (signup/login) — unchanged
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'All fields required' });

    if (await User.findOne({ where: { email } }))
      return res.status(400).json({ success: false, message: 'User exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    res.status(201).json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = generateToken(user.id);
    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Deposit transaction
app.post('/api/transactions/deposit', protect, async (req, res) => {
  try {
    const { amount, reference } = req.body;
    if (!amount || amount < 100)
      return res.status(400).json({ success: false, message: 'Minimum deposit ₦100' });

    if (!reference)
      return res.status(400).json({ success: false, message: 'Reference required' });

    if (await Transaction.findOne({ where: { reference } }))
      return res.status(400).json({ success: false, message: 'Transaction exists' });

    const transaction = await Transaction.create({
      type: 'deposit',
      amount,
      reference,
      status: 'completed',
      UserId: req.user.id
    });

    req.user.balance += amount;
    await req.user.save();

    res.json({ success: true, transaction, balance: req.user.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Paystack: Initialize
app.post('/api/payments/initialize', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100)
      return res.status(400).json({ success: false, message: 'Minimum amount ₦100' });

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: req.user.email,
        amount: amount * 100,
        currency: 'NGN',
        callback_url: `${CLIENT_URL}/payment/callback`,
        metadata: { user_id: req.user.id, user_name: req.user.name }
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    res.json({ success: true, data: response.data.data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error initializing payment', error: err.response?.data || err.message });
  }
});

// Paystack: Verify
app.post('/api/payments/verify', protect, async (req, res) => {
  try {
    const { reference, amount } = req.body;
    if (!reference)
      return res.status(400).json({ success: false, message: 'Reference required' });

    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const data = response.data.data;
    const paidAmount = data.amount / 100;

    if (Math.abs(paidAmount - amount) > 0.01)
      return res.status(400).json({ success: false, message: 'Amount mismatch' });

    res.json({ success: true, verified: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error verifying payment' });
  }
});

// -------------------- 📰 NEWS ROUTES (with uploads + delete) --------------------

// Create news (Admin Only) — accepts multipart/form-data with "image" file field
app.post('/api/news', upload.single('image'), async (req, res) => {
  try {
    // adminPassword can come from form field (multipart) or JSON body
    const adminPassword = req.body.adminPassword || req.body.adminpassword || req.headers['x-admin-password'];
    if (adminPassword !== ADMIN_PASSWORD) {
      // remove uploaded file if unauthorized
      if (req.file && req.file.path) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(403).json({ success: false, message: 'Unauthorized: wrong admin password' });
    }

    const { title, content } = req.body;
    if (!title || !content) {
      if (req.file && req.file.path) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(400).json({ success: false, message: 'Title and content required' });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : (req.body.imageUrl || null);
    const news = await News.create({ title, content, imageUrl });
    res.status(201).json({ success: true, news });
  } catch (err) {
    console.error('POST /api/news error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all football news (public)
app.get('/api/news', async (req, res) => {
  try {
    const news = await News.findAll({ order: [['publishedAt', 'DESC']] });
    res.json({ success: true, news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete news (Admin only) — accepts adminPassword in body, query or header
app.delete('/api/news/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const adminPassword = req.body?.adminPassword || req.query?.adminPassword || req.headers['x-admin-password'];
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, message: 'Unauthorized: wrong admin password' });
    }

    const news = await News.findByPk(id);
    if (!news) return res.status(404).json({ success: false, message: 'News not found' });

    // delete image file if stored in uploads folder (imageUrl like '/uploads/filename')
    if (news.imageUrl && news.imageUrl.startsWith('/uploads/')) {
      const filePath = path.join(process.cwd(), news.imageUrl);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.warn('Failed deleting file', e); }
      }
    }

    await news.destroy();
    res.json({ success: true, message: 'News deleted' });
  } catch (err) {
    console.error('DELETE /api/news/:id error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));


