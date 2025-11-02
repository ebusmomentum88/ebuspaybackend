const express = require('express');
const cors = require('cors');
// 1. Paystack Library Initialization
const Paystack = require('paystack-node'); 

const app = express();
const PORT = process.env.PORT || 3000; 

// --- Configuration ---
// 🛑 IMPORTANT: Replace 'YOUR_PAYSTACK_SECRET_KEY' with your actual sk_test_... key 🛑
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_1ae7634d7d57171ef43b8ac0087dfa6c72c9633f';
const paystack = new Paystack(PAYSTACK_SECRET_KEY, process.env.NODE_ENV);


// --- Mock Database (for simplicity, now it holds users and transactions) ---
let users = [];
let transactions = [];

// --- Middleware Setup ---
app.use(cors({ origin: '*' })); // Allow all origins
app.use(express.json());

// --- Authentication Routes (Same as before) ---
app.post('/api/signup', (req, res) => {
    // ... [EXISTING SIGNUP LOGIC HERE] ...
    const { email, password, fullname } = req.body;
    if (!email || !password || !fullname) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    if (users.find(user => user.email === email)) {
        return res.status(409).json({ success: false, message: 'User already exists with this email.' });
    }
    const newUser = { id: users.length + 1, fullname, email, password };
    users.push(newUser);
    res.status(201).json({ success: true, message: 'Registration successful!', user: {fullname, email} });
});

app.post('/api/login', (req, res) => {
    // ... [EXISTING LOGIN LOGIC HERE] ...
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user || user.password !== password) {
        return res.status(401).json({ success: false, message: 'Login failed: Incorrect credentials.' });
    }
    res.status(200).json({ success: true, message: 'Login successful!', user: {fullname: user.fullname, email: user.email} });
});


// ------------------------------------------------------------------
// 3. NEW PAYMENT ROUTE: Initialize Paystack Transaction
// ------------------------------------------------------------------
app.post('/api/pay', async (req, res) => {
    const { amount, email, currency = 'NGN' } = req.body;

    if (!amount || !email) {
        return res.status(400).json({ success: false, message: 'Amount and email are required.' });
    }

    // Amount must be in kobo (or the lowest denomination of the currency)
    const amountInKobo = amount * 100;

    try {
        const response = await paystack.transaction.initialize({
            amount: amountInKobo,
            email: email,
            currency: currency,
            // A callback URL is usually needed for webhooks, 
            // but for simple inline, Paystack handles the popup.
        });

        if (response.status) {
            // Respond with the authorization URL/data needed by the frontend 
            // to open the Paystack popup.
            res.status(200).json({
                success: true,
                message: 'Payment initialized.',
                data: response.data // Contains authorization_url and access_code
            });
        } else {
            console.error('Paystack initialization error:', response.message);
            res.status(500).json({ success: false, message: 'Failed to initialize payment with Paystack.' });
        }
    } catch (error) {
        console.error('Server error during payment initialization:', error);
        res.status(500).json({ success: false, message: 'Internal server error while processing payment.' });
    }
});


// --- Health Check Route ---
app.get('/', (req, res) => {
    res.status(200).send('EbusBet Backend is running successfully!');
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`EbusBet Backend Server running on port ${PORT}`);
    // In a real app, you would connect to PostgreSQL/MongoDB here.
});
