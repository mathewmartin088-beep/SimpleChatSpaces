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

function saveUsersToFile() {
    fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8', (err) => {
        if (err) console.error("[HISPACE] Error saving users to file:", err.message);
    });
}

const otps = {};
const clients = new Map();
const groups = {};

// Active Voice Channels Map: roomName -> Set of { userId, socket }
const voiceChannels = new Map();

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

// Check user existence endpoint
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
        console.log(`[HISPACE REGISTER] Created user: ${username} (saved to users.json)`);
        return res.json({ success: true, user: users[userId] });
    }
});

// WebSocket Server
const wss = new WebSocket.Server({ server: http });

wss.on('connection', (ws) => {
    let currentUserId = null;
    let currentVoiceRoom = null;

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
                groups[data.groupId] = { id: data.groupId, name: data.groupName, members: data.members };
                data.members.forEach(memberId => {
                    const target = clients.get(memberId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({ type: 'group_created', group: groups[data.groupId] }));
                    }
                });
                return;
            }

            // VOICE ROOM CHANNEL MANAGEMENT
            if (data.type === 'join_voice_room') {
                currentVoiceRoom = data.roomId;
                if (!voiceChannels.has(currentVoiceRoom)) {
                    voiceChannels.set(currentVoiceRoom, new Map());
                }
                voiceChannels.get(currentVoiceRoom).set(currentUserId, ws);
                broadcastVoiceRoomState(currentVoiceRoom);
                return;
            }

            if (data.type === 'leave_voice_room') {
                leaveVoiceRoom(currentUserId, currentVoiceRoom);
                currentVoiceRoom = null;
                return;
            }

            // BROADCAST AUDIO CHUNKS TO VOICE CHANNEL MEMBERS
            if (data.type === 'voice_chunk') {
                if (currentVoiceRoom && voiceChannels.has(currentVoiceRoom)) {
                    const roomMembers = voiceChannels.get(currentVoiceRoom);
                    const audioPayload = JSON.stringify({
                        type: 'voice_stream',
                        senderId: currentUserId,
                        senderName: users[currentUserId]?.username || currentUserId,
                        audio: data.audio
                    });

                    roomMembers.forEach((memberWs, memberId) => {
                        if (memberId !== currentUserId && memberWs.readyState === WebSocket.OPEN) {
                            memberWs.send(audioPayload);
                        }
                    });
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
            if (currentVoiceRoom) {
                leaveVoiceRoom(currentUserId, currentVoiceRoom);
            }
            broadcastPresence();
        }
    });
});

function leaveVoiceRoom(userId, roomId) {
    if (roomId && voiceChannels.has(roomId)) {
        const room = voiceChannels.get(roomId);
        room.delete(userId);
        if (room.size === 0) {
            voiceChannels.delete(roomId);
        } else {
            broadcastVoiceRoomState(roomId);
        }
    }
}

function broadcastVoiceRoomState(roomId) {
    if (!voiceChannels.has(roomId)) return;
    const roomMembers = voiceChannels.get(roomId);
    const memberList = Array.from(roomMembers.keys()).map(id => ({
        id,
        username: users[id]?.username || id
    }));

    const payload = JSON.stringify({
        type: 'voice_room_members',
        roomId: roomId,
        members: memberList
    });

    roomMembers.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
        }
    });
}

function broadcastPresence() {
    const activeUsers = Array.from(clients.keys()).map(id => users[id] || { id, username: id });
    const payload = JSON.stringify({ type: 'presence', users: activeUsers });
    clients.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Hispace Server active on port ${PORT}`));
