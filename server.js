const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3100;

// Database Connection
const db = new sqlite3.Database('./hispace.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite persistent database.');
});

// Table Initialization
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed default channels if empty
  db.get('SELECT COUNT(*) as count FROM channels', (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO channels (id, name, type) VALUES ('general', 'general', 'text')`);
      db.run(`INSERT INTO channels (id, name, type) VALUES ('random', 'random', 'text')`);
      db.run(`INSERT INTO channels (id, name, type) VALUES ('lounge', 'Lounge', 'voice')`);
    }
  });
});

app.use(express.json());

// Authentication Endpoints
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken.' });
        return res.status(500).json({ error: 'Database error.' });
      }
      return res.json({ success: true, username });
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error during registration.' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (!user) return res.status(400).json({ error: 'User does not exist.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Incorrect password.' });

    return res.json({ success: true, username: user.username });
  });
});

// REST Endpoints
app.get('/api/channels', (req, res) => {
  db.all('SELECT * FROM channels', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch channels' });
    return res.json(rows || []);
  });
});

app.post('/api/channels', (req, res) => {
  const { id, name, type } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'Channel name required.' });

  db.run('INSERT INTO channels (id, name, type) VALUES (?, ?, ?)', [id, name, type || 'text'], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to create channel' });
    res.json({ success: true, id, name, type: type || 'text' });
  });
});

app.get('/api/messages/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  db.all('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at ASC', [channelId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch messages.' });
    return res.json(rows || []);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket Real-time & WebRTC Signaling
const clients = new Map(); // ws -> { username }

wss.on('connection', (ws) => {
  clients.set(ws, { username: null });

  ws.on('message', (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);

      if (data.type === 'auth') {
        clients.set(ws, { username: data.username });
        broadcastOnlineUsers();
      } else if (data.type === 'chat_message') {
        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        const timestamp = new Date().toISOString();

        db.run(
          'INSERT INTO messages (id, channel_id, username, content, created_at) VALUES (?, ?, ?, ?, ?)',
          [msgId, data.channelId, data.username, data.content, timestamp],
          (err) => {
            if (!err) {
              broadcast({
                type: 'new_message',
                message: {
                  id: msgId,
                  channel_id: data.channelId,
                  username: data.username,
                  content: data.content,
                  created_at: timestamp
                }
              });
            }
          }
        );
      } else if (data.type === 'webrtc_offer' || data.type === 'webrtc_answer' || data.type === 'webrtc_ice') {
        // Forward WebRTC Voice signaling packets to target peer
        for (const [client, info] of clients.entries()) {
          if (info.username === data.target && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
          }
        }
      }
    } catch (e) {
      console.error('WS Exception:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastOnlineUsers();
  });
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const [client] of clients.entries()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastOnlineUsers() {
  const onlineList = Array.from(clients.values()).map(c => c.username).filter(Boolean);
  const uniqueUsers = [...new Set(onlineList)];
  broadcast({ type: 'presence_update', users: uniqueUsers });
}

server.listen(PORT, () => {
  console.log(`hispace Server running on port ${PORT}`);
});
