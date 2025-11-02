const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

// ==================== CONFIG ====================
const PAYSTACK_SECRET_KEY = 'sk_test_1ae7634d7d57171ef43b8ac0087dfa6c72c9633f'; // Test key
const MONGODB_URI = 'YOUR_MONGODB_URI_HERE'; // Replace with your MongoDB connection string
const JWT_SECRET = 'your_jwt_secret'; // Replace with your JWT secret
const CLIENT_URL = 'http://localhost:3000'; // Replace with your frontend URL

// ==================== INIT ====================
const app = express();
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== DATABASE ====================
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => {
        process.exit(1);
    });

// ==================== MODELS ====================
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'transfer'], required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    reference: { type: String, required: true, unique: true },
    description: String,
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

// ==================== MIDDLEWARE ====================
const protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ success: false, message: 'Not authorized' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = await User.findById(decoded.id).select('-password');
        if (!req.user) return res.status(401).json({ success: false, message: 'User not found' });
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Token invalid' });
    }
};

const generateToken = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });

// ==================== ROUTES ====================
// Health check
app.get('/', (req, res) => {
    res.json({ success: true, message: 'EbusPay API running', paystack: PAYSTACK_SECRET_KEY ? 'Configured ✅' : 'Not Configured ❌' });
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: 'All fields required' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ success: false, message: 'User already exists' });

    const user = await User.create({ name, email, password });
    res.status(201).json({ success: true, user: { id: user._id, name: user.name, email: user.email, balance: user.balance } });
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = generateToken(user._id);
    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, balance: user.balance } });
});

// Initialize Paystack payment
app.post('/api/payments/initialize', protect, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum amount ₦100' });

    try {
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: req.user.email,
            amount: amount * 100,
            currency: 'NGN',
            callback_url: `${CLIENT_URL}/payment/callback`,
            metadata: { user_id: req.user._id.toString(), user_name: req.user.name }
        }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });

        res.json({ success: true, data: response.data.data });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error initializing payment', error: err.response?.data || err.message });
    }
});

// Verify Paystack payment
app.post('/api/payments/verify', protect, async (req, res) => {
    const { reference, amount } = req.body;
    if (!reference) return res.status(400).json({ success: false, message: 'Reference required' });

    try {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const data = response.data.data;
        const paidAmount = data.amount / 100;
        if (Math.abs(paidAmount - amount) > 0.01) return res.status(400).json({ success: false, message: 'Amount mismatch', expected: amount, received: paidAmount });

        res.json({ success: true, verified: true, data: { amount: paidAmount, reference: data.reference, paidAt: data.paid_at } });
    } catch (err) {
        res.status(500).json({ success: false, verified: false, message: 'Error verifying payment', error: err.response?.data || err.message });
    }
});

// Render port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));





