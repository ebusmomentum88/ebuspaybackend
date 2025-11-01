const express = require('express');
const cors = require('cors');
const path = require('path'); // Node.js module for working with file paths

const app = express();
// Render automatically sets the PORT environment variable. We use 3000 for local development.
const PORT = process.env.PORT || 3000; 

// --- Mock Database (Placeholder for a real database) ---
// In a real application, you would connect to PostgreSQL, MongoDB, etc.
let users = [];

// --- Middleware Setup ---
// 1. CORS: Allows your frontend (EbusBet-Prototype) to talk to this backend
app.use(cors({
    origin: '*', // For a live app, change '*' to your specific Vercel domain
}));
// 2. JSON Parser: Handles incoming JSON data from the forms
app.use(express.json());

// --- ROUTES ---

// 1. Sign Up/Registration Route
app.post('/api/signup', (req, res) => {
    const { email, password, fullname } = req.body;

    if (!email || !password || !fullname) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    if (users.find(user => user.email === email)) {
        return res.status(409).json({ success: false, message: 'User already exists.' });
    }

    // Create a new user (NOTE: NEVER store plain passwords in production!)
    const newUser = {
        id: users.length + 1,
        fullname,
        email,
        password 
    };

    users.push(newUser);
    console.log('New User Registered:', newUser.email);

    res.status(201).json({ success: true, message: 'Registration successful! You can now log in.', user: {fullname, email} });
});

// 2. Login Route
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    const user = users.find(u => u.email === email);

    if (!user) {
        return res.status(401).json({ success: false, message: 'Login failed: User not found.' });
    }

    if (user.password !== password) {
        return res.status(401).json({ success: false, message: 'Login failed: Incorrect password.' });
    }

    // Success
    res.status(200).json({ success: true, message: 'Login successful!', user: {fullname: user.fullname, email: user.email} });
});

// --- Health Check Route (Important for Render) ---
// This simple GET route tells Render the server is alive.
app.get('/', (req, res) => {
    res.status(200).send('EbusBet Backend is running successfully!');
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`EbusBet Backend Server running on port ${PORT}`);
    console.log(`Mock Users loaded: ${users.length}`);
});