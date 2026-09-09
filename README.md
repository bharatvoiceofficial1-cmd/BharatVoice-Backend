# Bharat Voice — AI Backend Proxy

A lightweight, secure Node.js & Express proxy server that manages AI conversations for **Bharat Voice**. It keeps your Groq API keys completely secure on the backend while allowing students to use the study companion from GitHub Pages or mobile browsers without needing their own API keys.

---

## 🚀 Quick Start (Local)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Your `.env` file is already created. It should contain:
```env
PORT=3000
GROQ_API_KEY=your_groq_api_key_here
DEFAULT_MODEL=llama-3.3-70b-versatile
```

### 3. Start the Server
```bash
npm start
```
The server will start at `http://localhost:3000`.
* Health check: `http://localhost:3000/api/health`
* Chat route: `http://localhost:3000/api/chat`

---

## 🌐 Deploy to Render.com (Free 24/7 Hosting)

To connect your live GitHub Pages frontend to this backend, host it on Render for free:

1. **Create a GitHub Repository for the Backend:**
   * Create a new private repository on GitHub named `BharatVoice-Backend`.
   * Push this folder to that repository:
     ```bash
     cd BharatVoice-Backend
     git init
     git add .
     git commit -m "Initial commit of Bharat Voice Backend"
     git branch -M main
     git remote add origin https://github.com/<your-username>/BharatVoice-Backend.git
     git push -u origin main
     ```
     *(Note: `.env` is gitignored so your key will NEVER be pushed).*

2. **Deploy on Render:**
   * Sign up at [Render.com](https://render.com) (free).
   * Click **New +** -> **Web Service**.
   * Select your `BharatVoice-Backend` repository.
   * Settings:
     * **Environment:** Node
     * **Build Command:** `npm install`
     * **Start Command:** `npm start`
     * **Plan:** Free
   * Scroll down to **Environment Variables** and add:
     * `GROQ_API_KEY` = *(Your Groq API key)*
     * `DEFAULT_MODEL` = `llama-3.3-70b-versatile`
   * Click **Deploy Web Service**.

3. **Copy your Live Backend URL:**
   Render will give you a live URL like `https://bharatvoice-backend.onrender.com`.
   You then paste this URL into your frontend settings or default config!

---

## 🛡️ Security Features
* **Zero Client Key Exposure:** Frontend never sees the API key.
* **CORS Configured:** Accepts requests from your GitHub Pages domain (`palankit003.github.io`).
* **Rate Limiting:** Built-in rate limiter (60 requests/minute per IP) prevents quota abuse.
* **Vision & Photo Support:** Accepts payloads up to 10MB to support base64 study question photos.
