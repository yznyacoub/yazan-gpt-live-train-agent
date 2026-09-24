const SAFE_HOST = /^[a-z0-9.-]+(?::\d+)?$/i;

export function buildSessionUpdate({ model, voice, instructions }) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          turn_detection: {
            type: 'semantic_vad',            eagerness: 'medium',
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: 'audio/pcmu' },
          voice,
        },
      },
      instructions,
    },
  };
}

export function buildInitialConversationEvents(opening) {
  return [
    {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: opening }],
      },
    },
    { type: 'response.create' },
  ];
}

export function buildTwilioMediaEvent(streamSid, payload) {
  return { event: 'media', streamSid, media: { payload } };
}

export function createInterruptionEvents({ streamSid, itemId, responseStartedAtMs, latestMediaTimestampMs }) {
  const elapsedMs = Math.max(0, latestMediaTimestampMs - responseStartedAtMs);
  return {
    openai: {
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: elapsedMs,
    },
    twilio: { event: 'clear', streamSid },
  };
}

export function buildTwiml(host) {
  if (!host || !SAFE_HOST.test(host)) throw new Error('Invalid public host');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`;
}
