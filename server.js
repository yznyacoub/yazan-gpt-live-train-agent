import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';
import {
  buildInitialConversationEvents,
  buildSessionUpdate,
  buildTwilioMediaEvent,
  buildTwiml,
  createInterruptionEvents,
} from './realtime-bridge.js';

dotenv.config();

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PHONE_NUMBER_FROM,
  PHONE_NUMBER_TO,
  PUBLIC_HOST,
  CALL_TOKEN,
  REALTIME_MODEL = 'gpt-realtime-2.1',
  REALTIME_VOICE = 'marin',
  PORT = 5050,
} = process.env;

if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const configuredHost = PUBLIC_HOST?.replace(/^https?:\/\//, '').replace(/\/$/, '');
const app = Fastify({ logger: true });
await app.register(websocket);
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(body)));
});

const OPENING = 'مرحبا، معك مساعد يزن يعقوب الشخصي. عندي استفسار صغير عن ترتيب قطار تبليسي إلى باتومي، إذا سمحت.';

const INSTRUCTIONS = `
أنت مساعد يزن يعقوب الشخصي في مكالمة هاتفية حقيقية. تحدث بالعربية الطبيعية الهادئة، وبجمل قصيرة، ويمكنك الانتقال إلى الإنجليزية إن لم يفهم الطرف الآخر العربية. لا تتحدث كنظام رد آلي، ولا تسرد قائمة أسئلة دفعة واحدة. اسأل سؤالا واحدا، استمع، ثم تابع بذكاء. اسمح للطرف الآخر بمقاطعتك وتوقف فوراً عندما يتكلم.

هدف المكالمة التدريبية هو سؤال موظف Georgian Railway عن الرحلة 808 من Tbilisi إلى Batumi يوم 26 سبتمبر 2026 الساعة 10:15 صباحا. نريد معرفة:
1) هل Carriage 4 تكون في مقدمة القطار أم مؤخرته عند الانطلاق من تبليسي؟
2) هل يمكن معرفة رقم طقم القطار مسبقا: GRS-011 أو GRS-012 أو GRS-013 أو GRS-014؟
3) إن لم تكن المعلومة مؤكدة الآن، متى ومن أي جهة يمكن تأكيدها في يوم الرحلة؟

لا تفترض إجابة ولا تخترع معلومة. ميز بوضوح بين المؤكد والمعتاد والمتوقع. إذا قال الشخص إنه لا يعرف، اسأله بلطف عمن يمكنه التأكد منه أو هل موظف الرصيف يعرف قبل الصعود. في النهاية لخص ما فهمته في جملة قصيرة للتأكد، اشكره، وقل وداعا. لا تذكر تفاصيل تقنية عن OpenAI أو Twilio إلا إذا سئلت مباشرة، وعندها قل بوضوح إنك مساعد صوتي بالذكاء الاصطناعي يتصل نيابة عن يزن.
`;

function safeClose(socket) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
}

function sendJson(socket, event) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

app.get('/health', async () => ({ ok: true }));

app.all('/twiml', async (request, reply) => {
  const host = configuredHost || request.headers.host;
  app.log.info({ host }, 'serving TwiML');
  reply.type('text/xml').send(buildTwiml(host));
});

app.get('/call', async (request, reply) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !CALL_TOKEN || !PHONE_NUMBER_FROM || !PHONE_NUMBER_TO) {
    return reply.code(501).send({ ok: false, error: 'Twilio REST calling is not configured.' });
  }
  if (request.query?.token !== CALL_TOKEN) return reply.code(403).send({ ok: false });

  const host = configuredHost || request.headers.host;
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const call = await client.calls.create({
    from: PHONE_NUMBER_FROM,
    to: PHONE_NUMBER_TO,
    url: `https://${host}/twiml`,
  });
  return { ok: true, callSid: call.sid };
});

app.get('/media-stream', { websocket: true }, (twilioSocket) => {
  let streamSid;
  let realtimeReady = false;
  let greeted = false;
  let latestMediaTimestampMs = 0;
  let responseStartedAtMs = null;
  let lastAssistantItemId = null;
  let pendingMarks = 0;

  app.log.info('Twilio media stream connected');

  const openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': 'yazan-train-agent',
      'User-Agent': 'yazan-train-assistant/node 1.1.0',
    },
  });

  const maybeGreet = () => {
    if (!streamSid || !realtimeReady || greeted) return;
    greeted = true;
    for (const event of buildInitialConversationEvents(OPENING)) sendJson(openai, event);
  };

  openai.on('open', () => {
    app.log.info({ model: REALTIME_MODEL }, 'OpenAI Realtime socket opened');
    sendJson(openai, buildSessionUpdate({
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      instructions: INSTRUCTIONS,
    }));
  });

  openai.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (error) {
      app.log.error({ raw: raw.toString(), error }, 'Could not parse OpenAI event');
      return;
    }

    if (event.type === 'session.created' || event.type === 'session.updated') {
      realtimeReady = true;
      app.log.info({ type: event.type }, 'OpenAI Realtime session ready');
      maybeGreet();
    } else if (event.type === 'response.output_audio.delta' && streamSid && twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.send(JSON.stringify(buildTwilioMediaEvent(streamSid, event.delta)));
      if (responseStartedAtMs === null) responseStartedAtMs = latestMediaTimestampMs;
      if (event.item_id) lastAssistantItemId = event.item_id;
      twilioSocket.send(JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: `audio-${++pendingMarks}` },
      }));
    } else if (event.type === 'response.output_audio_transcript.delta') {
      process.stdout.write(event.delta || '');
    } else if (event.type === 'input_audio_buffer.speech_started' && streamSid && lastAssistantItemId) {
      const interruption = createInterruptionEvents({
        streamSid,
        itemId: lastAssistantItemId,
        responseStartedAtMs,
        latestMediaTimestampMs,
      });
      sendJson(openai, interruption.openai);
      sendJson(twilioSocket, interruption.twilio);
      responseStartedAtMs = null;
      lastAssistantItemId = null;
      pendingMarks = 0;
    } else if (event.type === 'error') {
      app.log.error({ error: event.error }, 'OpenAI Realtime error');
    }
  });

  twilioSocket.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (error) {
      app.log.error({ raw: raw.toString(), error }, 'Could not parse Twilio event');
      return;
    }

    if (event.event === 'start') {
      streamSid = event.start.streamSid;
      latestMediaTimestampMs = 0;
      responseStartedAtMs = null;
      app.log.info({ streamSid }, 'Twilio media stream started');
      maybeGreet();
    } else if (event.event === 'media' && realtimeReady) {
      latestMediaTimestampMs = Number(event.media.timestamp || latestMediaTimestampMs);
      sendJson(openai, { type: 'input_audio_buffer.append', audio: event.media.payload });
    } else if (event.event === 'mark') {
      pendingMarks = Math.max(0, pendingMarks - 1);
    } else if (event.event === 'stop') {
      app.log.info('Twilio media stream stopped');
      safeClose(openai);
    }
  });

  const closeBoth = () => {
    safeClose(openai);
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
  };

  twilioSocket.on('close', () => safeClose(openai));
  twilioSocket.on('error', (error) => {
    app.log.error({ error }, 'Twilio socket error');
    closeBoth();
  });
  openai.on('close', (code, reason) => {
    app.log.info({ code, reason: reason.toString() }, 'OpenAI Realtime socket closed');
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close();
  });
  openai.on('error', (error) => {
    app.log.error({ error }, 'OpenAI Realtime socket error');
    closeBoth();
  });
});

await app.listen({ host: '0.0.0.0', port: Number(PORT) });
app.log.info(`Ready on ${PORT}`);
