// ==========================
// server.js - Full Backend
// ==========================

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // For Paystack verification

const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads"))); // Serve uploaded images

// ==========================
// Config & Storage
// ==========================
const PORT = process.env.PORT || 5000;
const JWT_SECRET = "supersecretkey"; // Use env variable in production
const PAYSTACK_SECRET = "sk_test_XXXXXXXXXXXXXXXX"; // replace with your Paystack secret

// Multer setup for news images
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ==========================
// In-memory DB (replace with real DB in production)
// ==========================
let users = []; // {id, name, email, passwordHash, balance, isAdmin}
let transactions = []; // {id, userId, type, amount, date, reference}
let newsList = []; // {id, title, content, imageUrl, createdAt}

// ==========================
// Middleware
// ==========================
function authMiddleware(req, res, next){
    const authHeader = req.headers.authorization;
    if(!authHeader) return res.status(401).json({message:"Unauthorized"});
    const token = authHeader.split(" ")[1];
    try{
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    }catch(err){
        res.status(401).json({message:"Invalid token"});
    }
}

// ==========================
// Auth Routes
// ==========================
app.post("/api/auth/signup", async (req,res)=>{
    const {name,email,password} = req.body;
    if(users.find(u=>u.email===email)) return res.status(400).json({message:"Email exists"});
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {id: Date.now().toString(), name, email, passwordHash, balance:0, isAdmin:false};
    users.push(user);
    res.json({message:"Signup successful"});
});

app.post("/api/auth/login", async (req,res)=>{
    const {email,password} = req.body;
    const user = users.find(u=>u.email===email);
    if(!user) return res.status(400).json({message:"User not found"});
    const match = await bcrypt.compare(password, user.passwordHash);
    if(!match) return res.status(400).json({message:"Incorrect password"});
    const token = jwt.sign({id:user.id,email:user.email,isAdmin:user.isAdmin}, JWT_SECRET, {expiresIn:"7d"});
    res.json({token, user:{id:user.id,name:user.name,email:user.email,balance:user.balance,isAdmin:user.isAdmin}});
});

app.get("/api/user/profile", authMiddleware, (req,res)=>{
    const user = users.find(u=>u.id===req.user.id);
    if(!user) return res.status(404).json({message:"User not found"});
    res.json({user});
});

// ==========================
// Transactions
// ==========================
app.get("/api/transactions", authMiddleware, (req,res)=>{
    const userTx = transactions.filter(t=>t.userId===req.user.id);
    res.json({transactions:userTx});
});

app.post("/api/transactions/deposit", authMiddleware, (req,res)=>{
    const {amount, reference} = req.body;
    const user = users.find(u=>u.id===req.user.id);
    if(!user) return res.status(404).json({message:"User not found"});
    user.balance += amount;
    transactions.push({id:Date.now().toString(), userId:user.id, type:"Deposit", amount, date: new Date(), reference});
    res.json({success:true});
});

// ==========================
// Paystack Verification
// ==========================
app.post("/api/payments/verify", authMiddleware, async (req,res)=>{
    const {reference, amount} = req.body;
    try{
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {Authorization: `Bearer ${PAYSTACK_SECRET}`}
        });
        const data = await response.json();
        if(data.status && data.data.status==="success" && data.data.amount/100===amount){
            res.json({success:true});
        } else res.status(400).json({success:false,message:"Payment failed"});
    }catch(err){ res.status(500).json({success:false,message:"Error verifying payment"}); }
});

// ==========================
// News Routes
// ==========================
app.get("/api/news", (req,res)=>{
    res.json({success:true, news: newsList.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))});
});

app.post("/api/news", authMiddleware, upload.single("image"), (req,res)=>{
    if(!req.user.isAdmin) return res.status(403).json({message:"Unauthorized"});
    const {title, content} = req.body;
    const imageUrl = req.file ? "/uploads/"+req.file.filename : null;
    const news = {id: Date.now().toString(), title, content, imageUrl, createdAt: new Date()};
    newsList.push(news);
    res.json({success:true, news});
});

app.put("/api/news/:id", authMiddleware, upload.single("image"), (req,res)=>{
    if(!req.user.isAdmin) return res.status(403).json({message:"Unauthorized"});
    const news = newsList.find(n=>n.id===req.params.id);
    if(!news) return res.status(404).json({message:"News not found"});
    if(req.body.title) news.title = req.body.title;
    if(req.body.content) news.content = req.body.content;
    if(req.file) news.imageUrl = "/uploads/"+req.file.filename;
    res.json({success:true, news});
});

app.delete("/api/news/:id", authMiddleware, (req,res)=>{
    if(!req.user.isAdmin) return res.status(403).json({message:"Unauthorized"});
    const index = newsList.findIndex(n=>n.id===req.params.id);
    if(index===-1) return res.status(404).json({message:"News not found"});
    const removed = newsList.splice(index,1);
    res.json({success:true, removed});
});

// ==========================
// Start Server
// ==========================
app.listen(PORT, ()=>console.log(`🚀 Server running on port ${PORT}`));



