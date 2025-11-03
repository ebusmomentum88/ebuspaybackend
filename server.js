// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Sequelize, DataTypes } from "sequelize";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS
app.use(cors({
  origin: ["https://ebuspay.vercel.app", "http://localhost:3000"],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploads
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use("/uploads", express.static(uploadDir));

// Database
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: "postgres",
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
});

// Models
const User = sequelize.define("User", {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  balance: { type: DataTypes.FLOAT, defaultValue: 0 }
});

const News = sequelize.define("News", {
  title: { type: DataTypes.STRING, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
  imageUrl: DataTypes.STRING,
});

// Multer for news images
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Routes

// Health check
app.get("/", (req, res) => res.send("✅ EbusPay Backend is running..."));

// Signup
import bcrypt from "bcryptjs";
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "All fields required" });
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: "User already exists" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hash });
    res.json({ success: true, message: "Signup successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error signing up" });
  }
});

// Login
import jwt from "jsonwebtoken";
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, balance: user.balance } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Login error" });
  }
});

// Verify token / get profile
app.get("/api/user/profile", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "No token" });
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, balance: user.balance } });
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
});

// News routes
app.post("/api/news", upload.single("image"), async (req, res) => {
  try {
    const { title, content, adminPassword } = req.body;
    if (adminPassword !== process.env.ADMIN_PASSWORD) return res.status(403).json({ message: "Unauthorized" });
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const news = await News.create({ title, content, imageUrl });
    res.json({ success: true, message: "News posted", news });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error posting news" });
  }
});

app.get("/api/news", async (req, res) => {
  try {
    const news = await News.findAll({ order: [["createdAt", "DESC"]] });
    res.json({ success: true, news });
  } catch {
    res.status(500).json({ message: "Error fetching news" });
  }
});

app.delete("/api/news/:id", async (req, res) => {
  try {
    const { adminPassword } = req.query;
    if (adminPassword !== process.env.ADMIN_PASSWORD) return res.status(403).json({ message: "Unauthorized" });
    const news = await News.findByPk(req.params.id);
    if (!news) return res.status(404).json({ message: "Not found" });
    if (news.imageUrl) {
      const filePath = path.join(process.cwd(), news.imageUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await news.destroy();
    res.json({ success: true, message: "News deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error deleting news" });
  }
});

// Start server
sequelize.sync().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});


