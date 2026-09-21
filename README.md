# Yazan GPT-Live Train Agent

Natural full-duplex Arabic phone agent for the Georgian Railway carriage question.

It bridges a Twilio bidirectional Media Stream directly to OpenAI GPT-Live using 8 kHz PCMU audio, so interruptions and turn-taking remain live rather than using an IVR-style speech/text loop.

## Run

1. Copy `.env.example` to `.env` and fill the secrets.
2. Install dependencies with `npm install`.
3. Expose port 5050 through a public HTTPS/WSS tunnel and put its hostname in `PUBLIC_HOST`.
4. Start with `npm start`.
5. Open `https://PUBLIC_HOST/call?token=CALL_TOKEN` to place the approved test call.

Keep `/call` protected and only call numbers you own or are authorized to contact.
