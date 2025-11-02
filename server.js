require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

// Load environment variables
const PORT = process.env.PORT || 5000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const CLIENT_URL = process.env.CLIENT_URL || 'http://ebuspay.vercel.app/';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!DATABASE_URL || !JWT_SECRET || !PAYSTACK_SECRET_KEY) {
    console.error('❌ Please set DATABASE_URL, JWT_SECRET, and PAYSTACK_SECRET_KEY in .env or Render environment variables');
    process.exit(1);
}

// Initialize Express
const app = express();
app.use(cors({ origin: ['https://ebuspay.vercel.app', 'http://localhost:3000'], credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

sequelize.sync({ alter: true });

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
app.get('/', (req, res) => res.json({ success: true, message: 'EbusPay API running', paystack: 'Configured ✅' }));

// Signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ success: false, message: 'All fields required' });

        if (await User.findOne({ where: { email } })) return res.status(400).json({ success: false, message: 'User exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ name, email, password: hashedPassword });
        res.status(201).json({ success: true, user: { id: user.id, name: user.name, email: user.email, balance: user.balance } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        const token = generateToken(user.id);
        res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, balance: user.balance } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Deposit transaction
app.post('/api/transactions/deposit', protect, async (req, res) => {
    try {
        const { amount, reference } = req.body;
        if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum deposit ₦100' });
        if (!reference) return res.status(400).json({ success: false, message: 'Reference required' });

        if (await Transaction.findOne({ where: { reference } })) return res.status(400).json({ success: false, message: 'Transaction exists' });

        const transaction = await Transaction.create({ type: 'deposit', amount, reference, status: 'completed', UserId: req.user.id });
        req.user.balance += amount;
        await req.user.save();

        res.json({ success: true, transaction, balance: req.user.balance });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Initialize Paystack payment
app.post('/api/payments/initialize', protect, async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum amount ₦100' });

        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: req.user.email,
            amount: amount * 100,
            currency: 'NGN',
            callback_url: `${CLIENT_URL}/payment/callback`,
            metadata: { user_id: req.user.id, user_name: req.user.name }
        }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });

        res.json({ success: true, data: response.data.data });
    } catch (err) { res.status(500).json({ success: false, message: 'Error initializing payment', error: err.response?.data || err.message }); }
});

// Verify Paystack payment
app.post('/api/payments/verify', protect, async (req, res) => {
    try {
        const { reference, amount } = req.body;
        if (!reference) return res.status(400).json({ success: false, message: 'Reference required' });

        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const data = response.data.data;
        const paidAmount = data.amount / 100;
        if (Math.abs(paidAmount - amount) > 0.01) return res.status(400).json({ success: false, message: 'Amount mismatch', expected: amount, received: paidAmount });

        res.json({ success: true, verified: true, data: { amount: paidAmount, reference: data.reference, paidAt: data.paid_at } });
    } catch (err) { res.status(500).json({ success: false, verified: false, message: 'Error verifying payment', error: err.response?.data || err.message }); }
});
// -------------------- NEWS ROUTES --------------------
const News = sequelize.define('News', {
  title: { type: DataTypes.STRING, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
  imageUrl: { type: DataTypes.STRING },
  publishedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});
sequelize.sync({ alter: true });

// Create news
app.post('/api/news', async (req, res) => {
  try {
    const { title, content, imageUrl } = req.body;
    if (!title || !content)
      return res.status(400).json({ success: false, message: 'Title and content required' });

    const news = await News.create({ title, content, imageUrl });
    res.json({ success: true, news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all news
app.get('/api/news', async (req, res) => {
  try {
    const news = await News.findAll({ order: [['publishedAt', 'DESC']] });
    res.json({ success: true, news });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));



