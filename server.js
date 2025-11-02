const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 5000;

// -------------------- SECRET KEYS --------------------
const PAYSTACK_SECRET_KEY = 'sk_test_1ae7634d7d57171ef43b8ac0087dfa6c72c9633f'; // Hardcoded for testing
const JWT_SECRET = 'supersecretkey';

// --- In-memory user storage ---
let users = [];

// Middleware: JWT Auth
const authenticate = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ message: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

// -------------------- SIGNUP --------------------
app.post('/api/signup', async (req, res) => {
    const { fullname, email, password } = req.body;
    if (!fullname || !email || !password) return res.status(400).json({ message: 'All fields required' });

    const exists = users.find(u => u.email === email);
    if (exists) return res.status(409).json({ message: 'Email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = { id: users.length + 1, fullname, email, passwordHash, walletBalance: 0 };
    users.push(newUser);

    res.json({ message: 'Signup successful. Please login.' });
});

// -------------------- LOGIN --------------------
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ message: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email, fullname: user.fullname }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ user: { id: user.id, fullname: user.fullname, email: user.email }, token });
});

// -------------------- INITIALIZE DEPOSIT --------------------
app.post('/api/pay', authenticate, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const reference = new Date().getTime().toString(); // unique reference
    res.json({ success: true, data: { reference } });
});

// -------------------- VERIFY PAYMENT --------------------
app.post('/api/verify-payment', authenticate, async (req, res) => {
    const { reference } = req.body;

    try {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        if (response.data.status && response.data.data.status === 'success') {
            const user = users.find(u => u.email === req.user.email);
            if (user) user.walletBalance += response.data.data.amount / 100; // Kobo -> Naira
            return res.json({ success: true, data: { balance: user.walletBalance } });
        } else {
            return res.status(400).json({ success: false, message: 'Payment not successful' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Payment verification failed' });
    }
});

// -------------------- GET WALLET BALANCE --------------------
app.get('/api/wallet', authenticate, (req, res) => {
    const user = users.find(u => u.email === req.user.email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ walletBalance: user.walletBalance });
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});



