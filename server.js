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

const CONFIG = {
  twilio: {
    accountSid: process.env.TWILIO_SID,
    authToken: process.env.TWILIO_TOKEN,
    fromNumber: process.env.TWILIO_FROM,
  },
  elevenlabs: {
    apiKey: process.env.ELEVEN_KEY,
    voiceId: process.env.ELEVEN_VOICE_ID,
  },
  server: {
    baseUrl: process.env.SERVER_URL,
    port: process.env.PORT || 3000,
  },
};

const anthropic = new Anthropic();
const twilioClient = twilio(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
const eleven = new ElevenLabsClient({ apiKey: CONFIG.elevenlabs.apiKey });

const moodPrompts = {
  ironic: `Ти — відомий артист на ім'я Отой. Тон: іронічний, дотепний, трохи саркастичний але без злоби.
Починай ЗАВЖДИ з: "Привіт. Це Отой... отримав заявку від тебе."
Потім іронічно коментуй ситуацію. Говори повільно, з паузами "...".
Не використовуй описи дій типу *зітхає* або *сміється* — тільки текст який можна вимовити.
Не використовуй слова з жіночими або чоловічими закінченнями — говори універсально.
3-4 речення після привітання. Українською.`,

  angry: `Ти — відомий артист на ім'я Отой. Тон: злий, драматичний, але по-смішному.
Починай ЗАВЖДИ з: "Привіт. Це Отой... отримав заявку від тебе."
Потім емоційно картай людину за ситуацію. Говори з паузами "..." для драми.
Не використовуй описи дій типу *зітхає* або *сміється* — тільки текст який можна вимовити.
Не використовуй слова з жіночими або чоловічими закінченнями — говори універсально.
3-4 речення після привітання. Українською.`,

  chill: `Ти — відомий артист на ім'я Отой. Тон: повний пофігізм, спокій.
Починай ЗАВЖДИ з: "Привіт. Це Отой... отримав заявку від тебе."
Потім спокійно кажи що все ок. Говори повільно з довгими паузами "...".
Не використовуй описи дій типу *зітхає* або *сміється* — тільки текст який можна вимовити.
Не використовуй слова з жіночими або чоловічими закінченнями — говори універсально.
3-4 речення після привітання. Українською.`,
};

async function generateArtistText(event, reason, mood) {
  const systemPrompt = moodPrompts[mood] || moodPrompts.ironic;
  const message = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: "user", content: `Людина пропустила подію: "${event}"\nПричина: "${reason || "не сказав"}"` }],
  });
  return message.content[0].text;
}

async function generateAudio(text) {
  const audioBuffer = await eleven.textToSpeech.convert(
    CONFIG.elevenlabs.voiceId,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.2,
        similarity_boost: 0.85,
        style: 0.7,
        use_speaker_boost: true,
      },
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

async function makeCall(phone, audioUrl) {
  const normalized = "+38" + phone.replace(/\D/g, "").replace(/^38/, "");
  const call = await twilioClient.calls.create({
    to: normalized,
    from: CONFIG.twilio.fromNumber,
    twiml: `<Response><Pause length="1"/><Play>${audioUrl}</Play><Pause length="1"/></Response>`,
  });
  return call.sid;
}

app.post("/call", async (req, res) => {
  const { phone, event, reason, mood } = req.body;
  if (!phone || !event) return res.status(400).json({ error: "phone і event обов'язкові" });
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
    res.json({ ok: true, callSid, preview: text });
  } catch (err) {
    console.error("Помилка:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use("/audio", express.static(AUDIO_DIR));

app.listen(CONFIG.server.port, () => {
  console.log(`Сервер запущено на порті ${CONFIG.server.port}`);
  console.log(`Публічна URL: ${CONFIG.server.baseUrl}`);
});
