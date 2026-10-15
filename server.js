const express = require('express');
const app = express();
const http = require('http').createServer(app);
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

app.use(express.static('public'));
app.use(express.json());

const USERS_FILE = path.join(__dirname, 'users.json');

// Load users from users.json file on startup
let users = {};
if (fs.existsSync(USERS_FILE)) {
    try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        console.log(`[HISPACE] Loaded ${Object.keys(users).length} account(s) from users.json`);
    } catch (err) {
        console.error("Error loading users.json:", err.message);
        users = {};
    }
}

// Helper: Save users object back to users.json asynchronously
function saveUsersToFile() {
    fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8', (err) => {
        if (err) {
            console.error("[HISPACE] Error saving users to file:", err.message);
        }
    });
}

const otps = {};
const clients = new Map();
const groups = {};

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

// Check if a username exists
app.get('/api/user-exists/:username', (req, res) => {
    const userId = req.params.username.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (users[userId]) {
        return res.json({ exists: true, user: { id: users[userId].id, username: users[userId].username } });
    } else {
        return res.json({ exists: false });
    }
});

// Password Login / Registration Route
app.post('/api/auth-password', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
    }

    const userId = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const passHash = hashPassword(password);

    if (users[userId]) {
        if (users[userId].passwordHash === passHash) {
            return res.json({ success: true, user: users[userId] });
        } else {
            return res.status(401).json({ error: "Incorrect password" });
        }
    } else {
        users[userId] = {
            id: userId,
            username: username,
            passwordHash: passHash,
            email: null
        };
        saveUsersToFile();
        console.log(`[HISPACE REGISTER] Created user: ${username} (saved to users.json)`);
        return res.json({ success: true, user: users[userId] });
    }
});

// Passcode Request via Email
app.post('/api/request-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otps[email] = code;

    console.log(`\n========================================`);
    console.log(` [HISPACE OTP CODE] for ${email}: ${code}`);
    console.log(`========================================\n`);

    try {
        await transporter.sendMail({
            from: '"Hispace Workspace" <mathewmartin088@gmail.com>',
            to: email,
            subject: 'Your Hispace Login Passcode',
            html: `<h3>Welcome to Hispace</h3><p>Your verification code is: <strong>${code}</strong></p>`
        });
        res.json({ success: true, message: "Passcode sent!" });
    } catch (err) {
        console.error("Email send error:", err.message);
        res.json({ success: true, message: "Code generated (check terminal if email fails)." });
    }
});

// Verify OTP
app.post('/api/verify-otp', (req, res) => {
    const { email, code, username } = req.body;
    if (otps[email] && otps[email] === code) {
        delete otps[email];
        const userId = (username || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]/g, '_');
        
        if (!users[userId]) {
            users[userId] = {
                id: userId,
                username: username || email.split('@')[0],
                passwordHash: null,
                email: email
            };
        } else {
            users[userId].email = email;
        }

        saveUsersToFile();
        res.json({ success: true, user: users[userId] });
    } else {
        res.status(400).json({ error: "Invalid verification code" });
    }
});

// WebSocket Server
const wss = new WebSocket.Server({ server: http });

wss.on('connection', (ws) => {
    let currentUserId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'handshake') {
                currentUserId = data.senderId;
                clients.set(currentUserId, ws);
                broadcastPresence();
                return;
            }

            if (data.type === 'create_group') {
                groups[data.groupId] = {
                    id: data.groupId,
                    name: data.groupName,
                    members: data.members
                };
                
                data.members.forEach(memberId => {
                    const target = clients.get(memberId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: 'group_created',
                            group: groups[data.groupId]
                        }));
                    }
                });
                return;
            }

            // WebRTC Voice Call Signaling
            if (data.type === 'call_signal') {
                const targetSocket = clients.get(data.recipientId);
                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                    targetSocket.send(JSON.stringify({
                        type: 'call_signal',
                        senderId: currentUserId,
                        senderName: users[currentUserId]?.username || currentUserId,
                        signal: data.signal
                    }));
                }
                return;
            }

            // WebRTC Call Status Signals (End, Reject)
            if (data.type === 'call_status') {
                const targetSocket = clients.get(data.recipientId);
                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                    targetSocket.send(JSON.stringify({
                        type: 'call_status',
                        senderId: currentUserId,
                        status: data.status
                    }));
                }
                return;
            }

            if (data.recipientId) {
                const targetSocket = clients.get(data.recipientId);
                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                    targetSocket.send(JSON.stringify(data));
                }
            } else if (data.groupId && groups[data.groupId]) {
                groups[data.groupId].members.forEach(memberId => {
                    if (memberId !== currentUserId) {
                        const memberSocket = clients.get(memberId);
                        if (memberSocket && memberSocket.readyState === WebSocket.OPEN) {
                            memberSocket.send(JSON.stringify(data));
                        }
                    }
                });
            }

        } catch (err) {
            console.error("Payload routing error:", err);
        }
    });

    ws.on('close', () => {
        if (currentUserId) {
            clients.delete(currentUserId);
            broadcastPresence();
        }
    });
});

function broadcastPresence() {
    const activeUsers = Array.from(clients.keys()).map(id => users[id] || { id, username: id });
    const payload = JSON.stringify({
        type: 'presence',
        users: activeUsers
    });
    clients.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
        }
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Hispace Server active at port ${PORT}`);
});
