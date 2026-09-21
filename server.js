require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || '777f23cf97fdfa78f16a528dcdb1a5519ad6a9b16cbf4172630e773cf3925b7f';

// Initialize Google OAuth client
const googleClient = new OAuth2Client();

// Initialize Razorpay client if configured
let razorpay = null;
const razorpayKeyId = process.env.RAZORPAY_KEY_ID ? process.env.RAZORPAY_KEY_ID.trim() : '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET ? process.env.RAZORPAY_KEY_SECRET.trim() : '';

if (razorpayKeyId && razorpayKeySecret) {
  try {
    razorpay = new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret
    });
    console.log('✓ Razorpay payment gateway client initialized.');
  } catch (err) {
    console.error('Failed to initialize Razorpay client:', err.message);
  }
} else {
  console.warn('⚠️ Razorpay credentials not found in environment. Payment endpoints will prompt for setup.');
}

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
  const nvKey = process.env.NVIDIA_API_KEY || '';
  res.json({
    status: 'ok',
    service: 'Bharat Voice AI Gateway',
    time: new Date().toISOString(),
    hasApiKey: !!cleanKey,
    hasImageGen: !!nvKey.trim(),
    hasDatabase: !!supabase,
    hasRazorpay: !!razorpay,
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
// 5. RAZORPAY PAYMENT GATEWAY
// ==========================================
const PLAN_CATALOG = {
  shakti: { amount: 4900, name: 'Bharat Voice Shakti', durationDays: 30 },
  mahashakti: { amount: 54900, name: 'Bharat Voice Maha Shakti', durationDays: 365 },
  bharatpro: { amount: 9900, name: 'Bharat Voice Bharat Pro', durationDays: 30 },
  bharatmax: { amount: 19900, name: 'Bharat Voice Bharat Max', durationDays: 30 },
  scholarpro: { amount: 14900, name: 'Bharat Voice Scholar Pro', durationDays: 30 }
};

// 1. Create Razorpay Order
app.post('/api/payment/create-order', authenticateUser, async (req, res) => {
  if (!razorpay || !razorpayKeySecret) {
    return res.status(503).json({
      error: {
        message: 'Payment gateway is not configured on the backend. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.'
      }
    });
  }

  const { planId } = req.body;
  const selectedPlan = PLAN_CATALOG[planId];

  if (!selectedPlan) {
    return res.status(400).json({
      error: {
        message: `Invalid plan selected: "${planId}". Valid plans: ${Object.keys(PLAN_CATALOG).join(', ')}`
      }
    });
  }

  try {
    const receiptId = `rcpt_${String(req.user.userId || 'usr').slice(0, 8)}_${Date.now()}`.slice(0, 40);
    const options = {
      amount: selectedPlan.amount, // amount in paise
      currency: 'INR',
      receipt: receiptId,
      notes: {
        userId: String(req.user.userId || ''),
        userEmail: String(req.user.email || ''),
        userName: String(req.user.name || ''),
        planId: String(planId)
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      planId: planId,
      planName: selectedPlan.name,
      keyId: razorpayKeyId
    });
  } catch (err) {
    console.error('Razorpay order creation error:', err);
    res.status(500).json({
      error: {
        message: err.error?.description || err.message || 'Could not initiate Razorpay payment order.'
      }
    });
  }
});

// 2. Verify Payment Signature & Activate Plan
app.post('/api/payment/verify', authenticateUser, async (req, res) => {
  if (!razorpayKeySecret) {
    return res.status(503).json({
      error: {
        message: 'Payment gateway secret is not configured on the backend.'
      }
    });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({
      error: {
        message: 'Missing payment details: razorpay_order_id, razorpay_payment_id, and razorpay_signature are all required.'
      }
    });
  }

  const validPlan = PLAN_CATALOG[planId] ? planId : 'shakti';

  try {
    // Cryptographically verify HMAC SHA-256 signature
    const hmac = crypto.createHmac('sha256', razorpayKeySecret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const expectedSignature = hmac.digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.warn(`Payment signature mismatch for user ${req.user.userId}: expected ${expectedSignature}, received ${razorpay_signature}`);
      return res.status(400).json({
        error: {
          message: 'Payment signature verification failed. Transaction cannot be verified.'
        }
      });
    }

    // Update user's plan in Supabase if configured
    if (supabase) {
      const { error: userUpdateErr } = await supabase
        .from('users')
        .update({
          plan: validPlan,
          updated_at: new Date().toISOString()
        })
        .eq('id', req.user.userId);

      if (userUpdateErr) {
        console.error('Error updating user plan in Supabase:', userUpdateErr.message);
      }

      const selectedPlan = PLAN_CATALOG[validPlan];
      const { error: payInsertErr } = await supabase
        .from('payments')
        .insert({
          user_id: req.user.userId,
          razorpay_order_id,
          razorpay_payment_id,
          amount: selectedPlan ? (selectedPlan.amount / 100) : 0,
          currency: 'INR',
          plan_id: validPlan,
          status: 'captured'
        });

      if (payInsertErr) {
        console.error('Error recording payment in Supabase:', payInsertErr.message);
      }
    }

    console.log(`✓ Payment verified successfully! User ${req.user.userId} upgraded to ${validPlan}. Payment ID: ${razorpay_payment_id}`);

    res.json({
      status: 'success',
      message: `Payment verified successfully! You are now subscribed to ${PLAN_CATALOG[validPlan]?.name || validPlan}.`,
      plan: validPlan,
      paymentId: razorpay_payment_id
    });
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({
      error: {
        message: err.message || 'An error occurred during payment verification.'
      }
    });
  }
});

// ==========================================
// 6. CORE AI CHAT PROXY
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

// ==========================================
// 7. HIGH-RESOLUTION AI IMAGE GENERATION (NVIDIA FLUX)
// ==========================================
app.post('/api/generate-image', async (req, res) => {
  const { prompt, style = 'auto', ratio = 'square' } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: { message: 'A text "prompt" is required for image generation.' } });
  }

  const rawKey = process.env.NVIDIA_API_KEY || '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';
  const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'Server error: NVIDIA_API_KEY is not configured on the backend.' }
    });
  }

  const raw = prompt.trim();
  let detectedStyle = style;
  if (detectedStyle === 'auto') {
    if (/concept\s*map|mind\s*map|flowchart|infographic|diagram|roadmap|workflow|schematic|architecture/i.test(raw)) {
      detectedStyle = 'conceptmap';
    } else if (/atom|molecule|electron|nucleus|cell|dna|photosynthesis|organ|anatomy|circuit|solar\s*system|planet|physics|chemistry|biology|science|schematic/i.test(raw)) {
      detectedStyle = 'diagram';
    } else if (/photo|photograph|portrait|real life|realistic|person|landscape|dslr/i.test(raw)) {
      detectedStyle = 'photo';
    } else if (/3d|isometric|blender|render/i.test(raw)) {
      detectedStyle = '3d';
    } else if (/anime|manga|cartoon|sketch|art|digital art/i.test(raw)) {
      detectedStyle = 'art';
    } else {
      detectedStyle = 'diagram';
    }
  }

  let styleSuffix = '';
  let appliedRatio = ratio;

  if (detectedStyle === 'conceptmap') {
    styleSuffix = ', clear educational concept map infographic, structured connected nodes, modern minimalist vector typography, high visual contrast, elegant layout, academic poster, ultra-sharp 8k uhd';
    if (appliedRatio === 'auto' || appliedRatio === 'square') appliedRatio = 'landscape';
  } else if (detectedStyle === 'diagram') {
    styleSuffix = ', accurate 3d educational scientific illustration, clear labeled parts, clean dark background, vivid colors, sharp focus, 8k uhd';
    if (appliedRatio === 'auto') appliedRatio = 'landscape';
  } else if (detectedStyle === 'photo') {
    styleSuffix = ', photorealistic, masterwork photography, 8k uhd, cinematic lighting, sharp focus, high dynamic range, breathtaking detail';
  } else if (detectedStyle === 'art') {
    styleSuffix = ', stunning digital art, vibrant color grading, intricate details, artistic masterpiece, trending on artstation, 8k';
  } else if (detectedStyle === '3d') {
    styleSuffix = ', 3d isometric render, blender 3d style, octane render, soft ambient shadows, modern clean 3d illustration, 8k';
  } else {
    styleSuffix = ', high quality, ultra detailed, sharp focus, clean composition, 8k';
  }

  // Map ratio to NVIDIA FLUX supported aspect ratios:
  // Supported: '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'
  let nvRatio = '1:1';
  let width = 1024, height = 1024;
  if (appliedRatio === 'landscape' || appliedRatio === '16:9' || appliedRatio === '4:3') {
    nvRatio = '4:3';
    width = 1152; height = 864;
  } else if (appliedRatio === 'portrait' || appliedRatio === '9:16' || appliedRatio === '3:4') {
    nvRatio = '3:4';
    width = 864; height = 1152;
  } else if (appliedRatio === 'wide' || appliedRatio === '21:9') {
    nvRatio = '21:9';
    width = 1344; height = 576;
  }

  const finalPrompt = raw + styleSuffix;

  try {
    const nvResponse = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        prompt: finalPrompt,
        aspect_ratio: nvRatio
      })
    });

    const data = await nvResponse.json();

    if (!nvResponse.ok) {
      const errMsg = (typeof data?.detail === 'string' ? data.detail : (data?.detail?.[0]?.msg || data?.error?.message)) || `NVIDIA API error HTTP ${nvResponse.status}`;
      console.error('NVIDIA Image Generation Error:', errMsg);
      return res.status(nvResponse.status).json({ error: { message: errMsg } });
    }

    const base64Img = data?.artifacts?.[0]?.base64 || data?.b64_json;
    if (!base64Img) {
      return res.status(502).json({ error: { message: 'No image artifact returned by NVIDIA generation model.' } });
    }

    const dataUrl = `data:image/jpeg;base64,${base64Img}`;
    res.json({
      status: 'success',
      image: dataUrl,
      meta: {
        model: 'black-forest-labs/flux.2-klein-4b (NVIDIA NIM)',
        style: detectedStyle,
        ratio: appliedRatio,
        aspect_ratio: nvRatio,
        width,
        height
      }
    });
  } catch (err) {
    console.error('Image generation proxy error:', err);
    res.status(502).json({
      error: { message: 'Gateway error: unable to reach NVIDIA Image Generation server.' }
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
  console.log(` Image Gen:    ${process.env.NVIDIA_API_KEY ? 'Ready (NVIDIA FLUX.2 Klein 4B)' : 'Waiting for NVIDIA_API_KEY'}`);
  console.log(` Auth route:   http://localhost:${PORT}/api/auth/google`);
  console.log(` Payments:     ${razorpay ? 'Ready (Razorpay)' : 'Waiting for RAZORPAY_KEY_ID & RAZORPAY_KEY_SECRET'}`);
  console.log(` Database:     ${supabase ? 'Connected (Supabase)' : 'Waiting for SUPABASE_URL'}`);
  console.log(`=========================================`);
});
