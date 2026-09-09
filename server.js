require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || '777f23cf97fdfa78f16a528dcdb1a5519ad6a9b16cbf4172630e773cf3925b7f';

// Initialize Google OAuth client
const googleClient = new OAuth2Client();

// Initialize Supabase client if configured
let supabase = null;
const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim() : '';

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });
    console.log('✓ Supabase PostgreSQL client initialized.');
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err.message);
  }
} else {
  console.warn('⚠️ Supabase credentials not found in environment. Running in auth-verify mode.');
}

// Enable CORS for all incoming origins (GitHub Pages, localhost, mobile browsers)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse JSON request bodies up to 10MB (supports base64 photos)
app.use(express.json({ limit: '10mb' }));

// Rate limiter for chat endpoint: 60 req/min per IP
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: 'Too many requests from this IP. Please slow down and try again in a minute.'
    }
  }
});

// Middleware: Authenticate JWT Token
function authenticateUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required' } });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: { message: 'Invalid or expired session token' } });
    }
    req.user = decoded;
    next();
  });
}

// ==========================================
// 1. HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
  const rawKey = process.env.GROQ_API_KEY || '';
  const cleanKey = rawKey.trim().replace(/^["']|["']$/g, '');
  res.json({
    status: 'ok',
    service: 'Bharat Voice AI Gateway',
    time: new Date().toISOString(),
    hasApiKey: !!cleanKey,
    hasDatabase: !!supabase,
    defaultModel: process.env.DEFAULT_MODEL || 'openai/gpt-oss-20b'
  });
});

// ==========================================
// 2. AUTHENTICATION: GOOGLE SIGN-IN
// ==========================================
app.post('/api/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: { message: 'idToken is required' } });
  }

  try {
    // 1. Verify Google token signature
    const ticket = await googleClient.verifyIdToken({ idToken });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email || '';
    const name = payload.name || payload.given_name || 'Learner';
    const picture = payload.picture || '';

    let userRecord = {
      id: googleId,
      google_id: googleId,
      email,
      name,
      picture,
      plan: 'free'
    };
    let profileData = {};
    let performanceData = [];

    // 2. If Supabase is connected, sync user & load history
    if (supabase) {
      const { data: user, error: userError } = await supabase
        .from('users')
        .upsert(
          { google_id: googleId, email, name, picture, updated_at: new Date().toISOString() },
          { onConflict: 'google_id' }
        )
        .select()
        .single();

      if (!userError && user) {
        userRecord = user;

        // Fetch learner profile
        const { data: prof } = await supabase
          .from('learner_profiles')
          .select('role, grade, subject, learning_goal')
          .eq('user_id', user.id)
          .maybeSingle();

        if (prof) profileData = prof;

        // Fetch past performance records (up to 50 most recent)
        const { data: perfs } = await supabase
          .from('student_performance')
          .select('id, subject, topic, score, test_date, note')
          .eq('user_id', user.id)
          .order('test_date', { ascending: false })
          .limit(50);

        if (perfs) {
          performanceData = perfs.map(p => ({
            id: p.id,
            subject: p.subject,
            topic: p.topic,
            score: p.score,
            date: p.test_date,
            note: p.note
          }));
        }
      } else if (userError) {
        console.error('Supabase user upsert error:', userError.message);
      }
    }

    // 3. Issue secure session JWT (valid for 30 days)
    const token = jwt.sign(
      { userId: userRecord.id, email: userRecord.email, name: userRecord.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: userRecord.id,
        name: userRecord.name,
        email: userRecord.email,
        picture: userRecord.picture,
        plan: userRecord.plan || 'free'
      },
      profile: profileData,
      performance: performanceData
    });
  } catch (err) {
    console.error('Google verification failed:', err.message);
    res.status(401).json({ error: { message: 'Invalid or expired Google credential' } });
  }
});

// ==========================================
// 3. USER PROFILE (SAVE / SYNC)
// ==========================================
app.post('/api/user/profile', authenticateUser, async (req, res) => {
  const { role, grade, subject, learningGoal } = req.body;

  if (!supabase) {
    return res.json({ status: 'saved_locally_only', note: 'Database not configured yet' });
  }

  try {
    const { data, error } = await supabase
      .from('learner_profiles')
      .upsert({
        user_id: req.user.userId,
        role: role || 'student',
        grade: grade || '',
        subject: subject || '',
        learning_goal: learningGoal || 'balanced',
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'ok', profile: data });
  } catch (err) {
    console.error('Error saving learner profile:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ==========================================
// 4. STUDENT PERFORMANCE (SAVE / SYNC)
// ==========================================
app.post('/api/user/performance', authenticateUser, async (req, res) => {
  const { subject, topic, score, date, note } = req.body;

  if (!subject || typeof score !== 'number') {
    return res.status(400).json({ error: { message: 'Subject and numeric score are required.' } });
  }

  if (!supabase) {
    return res.json({ status: 'saved_locally_only', note: 'Database not configured yet' });
  }

  try {
    const { data, error } = await supabase
      .from('student_performance')
      .insert({
        user_id: req.user.userId,
        subject,
        topic: topic || '',
        score,
        test_date: date || new Date().toISOString().slice(0, 10),
        note: note || ''
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'ok', performance: data });
  } catch (err) {
    console.error('Error saving student performance:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/api/user/performance', authenticateUser, async (req, res) => {
  if (!supabase) {
    return res.json({ performance: [] });
  }

  try {
    const { data, error } = await supabase
      .from('student_performance')
      .select('id, subject, topic, score, test_date, note')
      .eq('user_id', req.user.userId)
      .order('test_date', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json({
      performance: (data || []).map(p => ({
        id: p.id,
        subject: p.subject,
        topic: p.topic,
        score: p.score,
        date: p.test_date,
        note: p.note
      }))
    });
  } catch (err) {
    console.error('Error fetching student performance:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ==========================================
// 5. CORE AI CHAT PROXY
// ==========================================
app.post('/api/chat', chatLimiter, async (req, res) => {
  const rawKey = process.env.GROQ_API_KEY || '';
  const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

  if (!apiKey) {
    return res.status(500).json({
      error: {
        message: 'Server error: GROQ_API_KEY is not configured on the backend.'
      }
    });
  }

  const { messages, model, temperature, max_tokens } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Invalid request: "messages" array is required.'
      }
    });
  }

  const selectedModel = model || process.env.DEFAULT_MODEL || 'openai/gpt-oss-20b';

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'BharatVoiceBackend/1.0'
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        max_tokens: typeof max_tokens === 'number' ? max_tokens : 1600
      })
    });

    const responseData = await groqResponse.json();

    if (!groqResponse.ok) {
      if (groqResponse.status === 404 || groqResponse.status === 400) {
        const fallbackModel = process.env.DEFAULT_MODEL || 'openai/gpt-oss-20b';
        if (selectedModel !== fallbackModel) {
          console.warn(`Model ${selectedModel} failed (${groqResponse.status}). Retrying with ${fallbackModel}...`);
          const retryResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'User-Agent': 'BharatVoiceBackend/1.0'
            },
            body: JSON.stringify({
              model: fallbackModel,
              messages: messages,
              temperature: typeof temperature === 'number' ? temperature : 0.7,
              max_tokens: typeof max_tokens === 'number' ? max_tokens : 1600
            })
          });
          const retryData = await retryResponse.json();
          if (retryResponse.ok) {
            return res.json(retryData);
          }
        }
      }

      const errMsg = responseData.error?.message || 'Error communicating with Groq upstream API.';
      return res.status(groqResponse.status).json({
        error: { message: errMsg }
      });
    }

    res.json(responseData);
  } catch (err) {
    console.error('Proxy request failed:', err);
    res.status(502).json({
      error: {
        message: 'Gateway error: unable to reach Groq AI server. Please check your network connection.'
      }
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` Bharat Voice AI Backend running on port ${PORT}`);
  console.log(` Health check: http://localhost:${PORT}/api/health`);
  console.log(` Chat proxy:   http://localhost:${PORT}/api/chat`);
  console.log(` Auth route:   http://localhost:${PORT}/api/auth/google`);
  console.log(` Database:     ${supabase ? 'Connected (Supabase)' : 'Waiting for SUPABASE_URL'}`);
  console.log(`=========================================`);
});
