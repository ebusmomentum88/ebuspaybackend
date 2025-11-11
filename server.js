import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';

const app = express();
app.use(cors({ origin: 'https://pay-bills-mxfj.vercel.app', credentials: true }));
app.use(bodyParser.json());

const users = [];
const transactions = [];

const SECRET = 'your-secret-key';

// Auth
app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body;
  if (users.find(u => u.email === email)) return res.status(400).json({ message: 'Email exists' });

  const newUser = { email, password, balance: 5000 };
  users.push(newUser);
  const token = jwt.sign({ email }, SECRET);
  res.json({ user: { email, balance: newUser.balance, token } });
});

app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });

  const token = jwt.sign({ email }, SECRET);
  res.json({ user: { email, balance: user.balance, token } });
});

// Middleware
function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(403).json({ message: 'No token' });
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(403).json({ message: 'Invalid token' });
  }
}

// Payments
app.post('/api/payments', verifyToken, (req, res) => {
  const { account, amount } = req.body;
  const user = users.find(u => u.email === req.user.email);
  if (user.balance < amount) return res.status(400).json({ message: 'Insufficient balance' });

  user.balance -= amount;
  const record = { email: user.email, type: 'Bill Payment', amount, date: new Date() };
  transactions.push(record);
  res.json({ message: 'Payment success', newBalance: user.balance });
});

app.get('/api/payments/history', verifyToken, (req, res) => {
  const history = transactions.filter(t => t.email === req.user.email);
  res.json({ transactions: history });
});

// Run server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));





