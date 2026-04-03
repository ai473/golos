import 'dotenv/config';
import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import { ElevenLabsClient } from "elevenlabs";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

// ─── КОНФІГ ──────────────────────────────────────────────────────────────────
const CONFIG = {
  twilio: {
    accountSid: process.env.TWILIO_SID,       // з twilio.com/console
    authToken: process.env.TWILIO_TOKEN,       // з twilio.com/console
    fromNumber: process.env.TWILIO_FROM,       // твій Twilio номер, напр. +12015551234
  },
  elevenlabs: {
    apiKey: process.env.ELEVEN_KEY,            // з elevenlabs.io/profile
    voiceId: process.env.ELEVEN_VOICE_ID,      // ID голосу артиста
  },
  server: {
    baseUrl: process.env.SERVER_URL,           // напр. https://promo.railway.app
    port: process.env.PORT || 3000,
  },
};

// ─── КЛІЄНТИ ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic(); // читає ANTHROPIC_API_KEY з env автоматично
const twilioClient = twilio(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
const eleven = new ElevenLabsClient({ apiKey: CONFIG.elevenlabs.apiKey });

// ─── ПРОМПТИ ПО НАСТРОЮ ──────────────────────────────────────────────────────
const moodPrompts = {
  ironic: `Ти — відомий артист. Тон: іронічний, дотепний, трохи саркастичний але без злоби.
Ти телефонуєш людині яка пропустила важливу подію. Підтримуєш її з легкою іронією.
Говори як живий, не пафосно. 3-4 речення. Українською.`,

  angry: `Ти — відомий артист. Тон: трохи злий, нетерплячий, перебільшено драматичний — але по-смішному.
Ти телефонуєш людині яка пропустила важливу подію. Картаєш її з любов'ю.
Говори емоційно, коротко. 3-4 речення. Українською.`,

  chill: `Ти — відомий артист. Тон: повний пофігізм, спокій, тебе нічого не хвилює.
Ти телефонуєш людині яка пропустила важливу подію. Кажеш що це взагалі не важливо.
Говори повільно і спокійно. 3-4 речення. Українською.`,
};

// ─── КРОК 1: CLAUDE ГЕНЕРУЄ ТЕКСТ ───────────────────────────────────────────
async function generateArtistText(event, reason, mood) {
  const systemPrompt = moodPrompts[mood] || moodPrompts.ironic;

  const message = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Людина пропустила подію: "${event}"\nПричина: "${reason || "не сказав"}"`,
      },
    ],
  });

  return message.content[0].text;
}

// ─── КРОК 2: ELEVENLABS ГЕНЕРУЄ АУДІО ───────────────────────────────────────
async function generateAudio(text) {
  const audioBuffer = await eleven.textToSpeech.convert(
    CONFIG.elevenlabs.voiceId,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }
  );
  const filename = `call_${Date.now()}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);
  const chunks = [];
  for await (const chunk of audioBuffer) { chunks.push(chunk); }
  fs.writeFileSync(filepath, Buffer.concat(chunks));
  const publicUrl = `${CONFIG.server.baseUrl}/audio/${filename}`;
  setTimeout(() => fs.unlink(filepath, () => {}), 5 * 60 * 1000);
  return publicUrl;
}

// ─── КРОК 3: TWILIO РОБИТЬ ДЗВІНОК ──────────────────────────────────────────
async function makeCall(phone, audioUrl) {
  // нормалізуємо номер: прибираємо пробіли, додаємо +38
  const normalized = "+38" + phone.replace(/\D/g, "").replace(/^38/, "");

  const call = await twilioClient.calls.create({
    to: normalized,
    from: CONFIG.twilio.fromNumber,
    twiml: `<Response>
      <Pause length="1"/>
      <Play>${audioUrl}</Play>
      <Pause length="1"/>
    </Response>`,
  });

  return call.sid;
}

// ─── ГОЛОВНИЙ ЕНДПОІНТ ───────────────────────────────────────────────────────
app.post("/call", async (req, res) => {
  const { phone, event, reason, mood } = req.body;

  if (!phone || !event) {
    return res.status(400).json({ error: "phone і event обов'язкові" });
  }

  try {
    console.log(`[1/3] Генеруємо текст для "${event}" (настрій: ${mood})`);
    const text = await generateArtistText(event, reason, mood);
    console.log(`[1/3] Текст: ${text}`);

    console.log(`[2/3] Генеруємо аудіо через ElevenLabs...`);
    const audioUrl = await generateAudio(text);
    console.log(`[2/3] Аудіо: ${audioUrl}`);

    console.log(`[3/3] Дзвонимо на ${phone}...`);
    const callSid = await makeCall(phone, audioUrl);
    console.log(`[3/3] Дзвінок створено: ${callSid}`);

    res.json({
      ok: true,
      callSid,
      preview: text, // показуємо текст у UI поки чекають дзвінка
    });
  } catch (err) {
    console.error("Помилка:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── РОЗДАЄМО АУДІО ФАЙЛИ ────────────────────────────────────────────────────
app.use("/audio", express.static(AUDIO_DIR));

// ─── СТАРТ ───────────────────────────────────────────────────────────────────
app.listen(CONFIG.server.port, () => {
  console.log(`Сервер запущено на порті ${CONFIG.server.port}`);
  console.log(`Публічна URL: ${CONFIG.server.baseUrl}`);
});
