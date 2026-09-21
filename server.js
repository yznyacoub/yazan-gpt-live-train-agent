import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PHONE_NUMBER_FROM = '+17372508034',
  PHONE_NUMBER_TO = '+971544999727',
  PUBLIC_HOST,
  CALL_TOKEN,
  PORT = 5050,
} = process.env;

const required = { OPENAI_API_KEY };
for (const [name, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing ${name}`);
}

const configuredHost = PUBLIC_HOST?.replace(/^https?:\/\//, '').replace(/\/$/, '');
const app = Fastify({ logger: true });
await app.register(websocket);

const OPENING = 'مرحباً، معك مساعد يزن يعقوب الشخصي. عندي استفسار صغير عن ترتيب قطار تبليسي إلى باتومي، إذا سمحت.';

const INSTRUCTIONS = `
أنت مساعد يزن يعقوب الشخصي في مكالمة هاتفية حقيقية. تحدث بالعربية الطبيعية الهادئة، وبجمل قصيرة، ويمكنك الانتقال إلى الإنجليزية إن لم يفهم الطرف الآخر العربية. لا تتحدث كنظام رد آلي، ولا تسرد قائمة أسئلة دفعة واحدة. اسأل سؤالاً واحداً، استمع، ثم تابع بذكاء. اسمح للطرف الآخر بمقاطعتك وتوقف فوراً عندما يتكلم.

هدف المكالمة التدريبية هو سؤال موظف Georgian Railway عن الرحلة 808 من Tbilisi إلى Batumi يوم 26 سبتمبر 2026 الساعة 10:15 صباحاً. نريد معرفة:
1) هل Carriage 4 تكون في مقدمة القطار أم مؤخرته عند الانطلاق من تبليسي؟
2) هل يمكن معرفة رقم طقم القطار مسبقاً: GRS-011 أو GRS-012 أو GRS-013 أو GRS-014؟
3) إن لم تكن المعلومة مؤكدة الآن، متى ومن أي جهة يمكن تأكيدها في يوم الرحلة؟

لا تفترض إجابة ولا تخترع معلومة. ميّز بوضوح بين المؤكد والمعتاد والمتوقع. إذا قال الشخص إنه لا يعرف، اسأله بلطف عمن يمكنه التأكد منه أو هل موظف الرصيف يعرف قبل الصعود. في النهاية لخّص ما فهمته في جملة قصيرة للتأكد، اشكره، وقل وداعاً. لا تذكر تفاصيل تقنية عن OpenAI أو Twilio إلا إذا سُئلت مباشرة، وعندها قل بوضوح إنك مساعد صوتي بالذكاء الاصطناعي يتصل نيابة عن يزن.
`;

function safeClose(socket) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
}

app.get('/health', async () => ({ ok: true }));

app.get('/twiml', async (request, reply) => {
  const host = configuredHost || request.headers.host;
  reply.type('text/xml').send(
    `<Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`,
  );
});

app.get('/call', async (request, reply) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !CALL_TOKEN) {
    return reply.code(501).send({ ok: false, error: 'Twilio REST calling is not configured. Use /twiml from Twilio Console.' });
  }
  if (request.query?.token !== CALL_TOKEN) return reply.code(403).send({ ok: false });
  const host = configuredHost || request.headers.host;
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const call = await client.calls.create({
    from: PHONE_NUMBER_FROM,
    to: PHONE_NUMBER_TO,
    twiml: `<Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`,
  });
  return { ok: true, callSid: call.sid };
});

app.get('/media-stream', { websocket: true }, (twilioSocket) => {
  let streamSid;
  let sessionStarted = false;
  let sessionReady = false;

  const openai = new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'User-Agent': 'yazan-train-assistant/node 1.0.0',
    },
  });

  const sendOpenAI = (event) => {
    if (openai.readyState === WebSocket.OPEN) openai.send(JSON.stringify(event));
  };

  const startSession = () => {
    if (sessionStarted || !streamSid || openai.readyState !== WebSocket.OPEN) return;
    sessionStarted = true;
    sendOpenAI({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        instructions: INSTRUCTIONS,
        audio: {
          format: { type: 'audio/pcmu', rate: 8000 },
          output: { voice: 'marin' },
        },
      },
    });
  };

  openai.on('open', startSession);
  openai.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.started') {
      sessionReady = true;
      app.log.info({ sessionId: event.session?.id }, 'GPT-Live session started');
      sendOpenAI({
        type: 'session.instructions.append',
        delegation_id: null,
        content: `قل هذه الجملة أولاً حرفياً: "${OPENING}"`,
      });
      sendOpenAI({ type: 'session.commentary.append', delegation_id: null, content: OPENING });
    } else if (event.type === 'session.output_audio.delta' && streamSid && twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
    } else if (event.type === 'session.output_transcript.delta') {
      process.stdout.write(event.delta || '');
    } else if (event.type === 'error') {
      app.log.error({ error: event.error }, 'GPT-Live error');
    }
  });

  twilioSocket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.event === 'start') {
      streamSid = event.start.streamSid;
      startSession();
    } else if (event.event === 'media' && sessionReady) {
      sendOpenAI({ type: 'session.input_audio.append', audio: event.media.payload });
    } else if (event.event === 'stop') {
      safeClose(openai);
    }
  });

  const closeBoth = () => {
    safeClose(openai);
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
  };
  twilioSocket.on('close', () => safeClose(openai));
  twilioSocket.on('error', closeBoth);
  openai.on('close', closeBoth);
  openai.on('error', closeBoth);
});

await app.listen({ host: '0.0.0.0', port: Number(PORT) });
app.log.info(`Ready on ${PORT}`);
