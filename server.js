require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all incoming origins (GitHub Pages, localhost, mobile browsers)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse JSON request bodies up to 10MB (to support base64 photos/attachments)
app.use(express.json({ limit: '10mb' }));

// Rate limiter: 60 requests per minute per IP to protect the Groq API quota
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Bharat Voice AI Gateway',
    time: new Date().toISOString(),
    hasApiKey: !!process.env.GROQ_API_KEY,
    defaultModel: process.env.DEFAULT_MODEL || 'openai/gpt-oss-20b'
  });
});

// Core AI Proxy endpoint
app.post('/api/chat', chatLimiter, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;

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

  // Pick requested model or fall back to default
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
      // If the selected model was decommissioned or not found, try fallback to default
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

    // Return standard OpenAI-compatible response to frontend
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
  console.log(` Chat endpoint: http://localhost:${PORT}/api/chat`);
  console.log(` Default Model: ${process.env.DEFAULT_MODEL || 'openai/gpt-oss-20b'}`);
  console.log(` API Key: ${process.env.GROQ_API_KEY ? 'Configured (Protected)' : 'MISSING'}`);
  console.log(`=========================================`);
});
