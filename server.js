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

// Connect to SQLite Database
const db = new sqlite3.Database('./hispace.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite persistent database.');
});

// Initialize Database Tables
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
    type TEXT NOT NULL DEFAULT 'text',
    server_id TEXT NOT NULL DEFAULT 'main'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reactions TEXT DEFAULT '{}'
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

// API Routes
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Username already taken.' });
        }
        return res.status(500).json({ error: 'Database error: ' + err.message });
      }
      return res.json({ success: true, username });
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error during registration.' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database query error.' });
    if (!user) return res.status(400).json({ error: 'User does not exist.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Incorrect password.' });

    return res.json({ success: true, username: user.username });
  });
});

app.get('/api/channels', (req, res) => {
  db.all('SELECT * FROM channels', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch channels' });
    return res.json(rows || []);
  });
});

app.get('/api/messages/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  if (!channelId || channelId === 'undefined' || channelId === 'null') {
    return res.status(400).json({ error: 'Invalid channel ID specified.' });
  }

  db.all(
    'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at ASC',
    [channelId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Failed to fetch messages.' });
      const formatted = (rows || []).map(r => ({
        ...r,
        reactions: JSON.parse(r.reactions || '{}')
      }));
      return res.json(formatted);
    }
  );
});

// Any bad API endpoint returns JSON with an explicit message
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `API route '${req.originalUrl}' not found.` });
});

// Static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Catch-All SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket Real-time Messaging
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (messageRaw) => {
    try {
      const data = JSON.parse(messageRaw);

      if (data.type === 'chat_message' && data.channelId && data.username && data.content) {
        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        const timestamp = new Date().toISOString();

        db.run(
          'INSERT INTO messages (id, channel_id, username, content, created_at, reactions) VALUES (?, ?, ?, ?, ?, ?)',
          [msgId, data.channelId, data.username, data.content, timestamp, '{}'],
          (err) => {
            if (!err) {
              broadcast({
                type: 'new_message',
                message: {
                  id: msgId,
                  channel_id: data.channelId,
                  username: data.username,
                  content: data.content,
                  created_at: timestamp,
                  reactions: {}
                }
              });
            }
          }
        );
      }
    } catch (e) {
      console.error('WS Error:', e);
    }
  });

  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
