const express = require('express');
const app = express();
const serverless = require('serverless-http');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));
app.use(express.json());

// Serverless filesystem uses /tmp for temporary file writes
const USERS_FILE = path.join('/tmp', 'users.json');

let users = {};
if (fs.existsSync(USERS_FILE)) {
    try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (err) {
        users = {};
    }
}

function saveUsersToFile() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    } catch (err) {
        console.error("Save error:", err);
    }
}

const otps = {};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'mathewmartin088@gmail.com', 
        pass: 'huys rxde icfc lica'     
    }
});

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

const router = express.Router();

router.post('/auth-password', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const userId = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const passHash = hashPassword(password);

    if (users[userId]) {
        if (users[userId].passwordHash === passHash) {
            return res.json({ success: true, user: users[userId] });
        } else {
            return res.status(401).json({ error: "Incorrect password" });
        }
    } else {
        users[userId] = { id: userId, username, passwordHash: passHash, email: null };
        saveUsersToFile();
        return res.json({ success: true, user: users[userId] });
    }
});

router.post('/request-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otps[email] = code;

    try {
        await transporter.sendMail({
            from: '"Hispace Workspace" <mathewmartin088@gmail.com>',
