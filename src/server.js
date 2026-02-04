require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

// Config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || 'http://45.76.249.108:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const VOICE_ID = process.env.VOICE_ID || 'TX3LPaxmHKxFdv7VOQHJ'; // Liam - Craby's voice
const PORT = process.env.PORT || 3000;

// Hold music URL (smooth jazz, 90 seconds)
const HOLD_MUSIC_URL = 'https://ik.imagekit.io/wurk/solana/music/solana-music-90s-1770226631075_mo4R-Lc3j.mp3';

// Quick acknowledgment phrases (rotates randomly)
const ACKNOWLEDGMENTS = [
  "Momentje, ik zoek het even voor je op.",
  "Even kijken, een momentje.",
  "Ik ga het voor je uitzoeken, momentje.",
  "Goeie vraag, even checken.",
  "Ik duik er even in, wacht.",
];

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Route for call experience (real-time conversation)
app.get('/call', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/call.html'));
});

// Route for voice message experience (hold-to-record)
app.get('/voice', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/voice.html'));
});

// Session tracking for conversation continuity
const sessions = new Map();
const conversations = new Map();

// Detect audio type from buffer
function detectAudioType(buffer) {
  // WAV starts with RIFF
  if (buffer.length > 4 && 
      buffer[0] === 0x52 && buffer[1] === 0x49 && 
      buffer[2] === 0x46 && buffer[3] === 0x46) {
    return { mime: 'audio/wav', ext: 'wav' };
  }
  // WebM starts with 0x1A45DFA3
  if (buffer.length > 4 && 
      buffer[0] === 0x1A && buffer[1] === 0x45 && 
      buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return { mime: 'audio/webm', ext: 'webm' };
  }
  // Default to webm
  return { mime: 'audio/webm', ext: 'webm' };
}

// Speech-to-Text using ElevenLabs Scribe
async function speechToText(audioBuffer) {
  const audioType = detectAudioType(audioBuffer);
  console.log(`Audio type detected: ${audioType.mime}`);
  
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: audioType.mime }), `audio.${audioType.ext}`);
  formData.append('model_id', 'scribe_v2');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`STT failed: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  return result.text;
}

// Get response from OpenClaw (the REAL Craby!)
async function getOpenClawResponse(messages) {
  const response = await fetch(`${OPENCLAW_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: messages,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenClaw error:', response.status, errorText);
    throw new Error(`OpenClaw failed: ${response.status}`);
  }

  const result = await response.json();
  return result.choices[0].message.content;
}

// Convert text to TTS-friendly format using GPT-4o
async function makeTTSFriendly(text) {
  const systemPrompt = `You are a text formatter for text-to-speech. Your ONLY job is to rewrite the input text so it sounds natural when spoken aloud.

RULES:
- Remove ALL emoji (🦀📉 etc)
- Remove ALL markdown (**bold**, *italic*, \`code\`)  
- Convert prices smartly based on size:
  * Large prices ($1000+): round to whole dollars, e.g. "$74,138.50" → "vierenzeventig duizend honderd achtendertig dollar"
  * Medium prices ($1-$999): keep max 2 decimals if relevant, e.g. "$16.33" → "zestien dollar drieëndertig"
  * Small prices ($0.01-$0.99): say cents, e.g. "$0.45" → "vijfenveertig cent"
  * Micro prices (<$0.01): keep significant decimals, e.g. "$0.000030" → "nul komma nul nul nul nul drie dollar"
- Convert "-5%" to "min 5 procent"
- Convert "(24h)" to "in de afgelopen 24 uur"
- Remove colons used as separators: "Bitcoin: $74k" → "Bitcoin, 74 duizend dollar"
- Keep the same language as input (Dutch/English)
- Keep the same meaning and personality
- Output ONLY the converted text, nothing else

Example input: "**Bitcoin:** $73.144,70 📉 (-4,62% in 24u)"
Example output: "Bitcoin, drieënzeventig duizend honderd vierenveertig dollar, min 4 komma 62 procent in de afgelopen 24 uur"

Example input: "PEPE: $0.00001234"
Example output: "PEPE, nul komma nul nul nul nul één twee drie vier dollar"`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      max_tokens: 500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    console.error('GPT-4o TTS formatting failed:', response.status);
    // Fallback to basic sanitization if GPT-4o fails
    return basicSanitize(text);
  }

  const result = await response.json();
  return result.choices[0].message.content;
}

// Basic fallback sanitization (if GPT-4o fails)
function basicSanitize(text) {
  let result = text;
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '');
  result = result.replace(/\$\s*([\d.,]+)/g, '$1 dollar');
  result = result.replace(/([+-]?)\s*([\d.,]+)\s*%/g, (m, sign, num) => {
    const prefix = sign === '-' ? 'min ' : sign === '+' ? 'plus ' : '';
    return `${prefix}${num} procent`;
  });
  result = result.replace(/:\s+/g, ', ');
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

// Text-to-Speech using ElevenLabs
async function textToSpeech(text) {
  // Clean up text for TTS (remove markdown, emojis in code blocks, etc)
  let cleanText = text
    .replace(/```[\s\S]*?```/g, 'code block omitted') // Remove code blocks
    .replace(/\*\*/g, '') // Remove bold
    .replace(/\*/g, '') // Remove italic
    .replace(/`/g, '') // Remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links to text
    .replace(/#{1,6}\s/g, '') // Remove headers
    .trim();

  // Limit length for TTS
  if (cleanText.length > 1500) {
    cleanText = cleanText.substring(0, 1500) + '...';
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: cleanText,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`TTS failed: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  const sessionId = Date.now().toString();
  const conversationId = `conv-${sessionId}`;
  
  sessions.set(sessionId, { connected: true });
  conversations.set(conversationId, []);

  ws.on('message', async (data, isBinary) => {
    if (!isBinary) {
      const msg = data.toString();
      console.log('Received text:', msg);
      
      if (msg === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      
      if (msg === 'reset') {
        conversations.set(conversationId, []);
        ws.send(JSON.stringify({ type: 'status', message: 'Session reset' }));
        return;
      }
      return;
    }

    try {
      console.log('Received audio:', data.length, 'bytes');
      ws.send(JSON.stringify({ type: 'status', message: 'Transcribing...' }));

      // 1. Speech to Text
      const transcript = await speechToText(data);
      console.log('Transcript:', transcript);
      
      if (!transcript || transcript.trim() === '') {
        ws.send(JSON.stringify({ type: 'status', message: 'No speech detected' }));
        return;
      }
      
      ws.send(JSON.stringify({ type: 'transcript', text: transcript }));

      // 2. Send quick acknowledgment + start hold music
      const ack = ACKNOWLEDGMENTS[Math.floor(Math.random() * ACKNOWLEDGMENTS.length)];
      console.log('Sending acknowledgment:', ack);
      
      ws.send(JSON.stringify({ type: 'status', message: 'Quick response...' }));
      const ackAudio = await textToSpeech(ack);
      ws.send(JSON.stringify({ type: 'acknowledgment', text: ack }));
      ws.send(ackAudio);
      
      // Tell client to start hold music while we think
      ws.send(JSON.stringify({ type: 'hold_music', action: 'start', url: HOLD_MUSIC_URL }));

      // 3. Get response from OpenClaw (the real Craby) - this may take a while
      const history = conversations.get(conversationId);
      history.push({ role: 'user', content: transcript });
      
      ws.send(JSON.stringify({ type: 'status', message: 'Craby is thinking...' }));
      const response = await getOpenClawResponse(history);
      console.log('Craby response:', response);
      
      history.push({ role: 'assistant', content: response });
      
      // Keep history manageable
      if (history.length > 20) {
        history.splice(0, 2);
      }
      
      // Send original response to display (hold music keeps playing until TTS is ready!)
      ws.send(JSON.stringify({ type: 'response', text: response }));

      // 4. Make TTS-friendly via GPT-4o
      ws.send(JSON.stringify({ type: 'status', message: 'Formatting for voice...' }));
      const spokenText = await makeTTSFriendly(response);
      console.log('TTS text:', spokenText);

      // 5. Text to Speech
      ws.send(JSON.stringify({ type: 'status', message: 'Generating voice...' }));
      const audioBuffer = await textToSpeech(spokenText);
      
      // Signal client: main audio incoming, stop hold music NOW
      ws.send(JSON.stringify({ type: 'hold_music', action: 'stop' }));
      ws.send(audioBuffer);
      ws.send(JSON.stringify({ type: 'status', message: 'Ready' }));
      
    } catch (error) {
      console.error('Error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    sessions.delete(sessionId);
    conversations.delete(conversationId);
  });
});

server.listen(PORT, () => {
  console.log(`🦀 Craby Voice Chat running on port ${PORT}`);
  console.log(`   OpenClaw API: ${OPENCLAW_API_URL}`);
  console.log(`   TTS Formatter: GPT-4o-mini via OpenRouter`);
  console.log(`   New call UI: /call`);
});
