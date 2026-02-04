require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

// Config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || 'http://45.76.249.108:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const VOICE_ID = process.env.VOICE_ID || 'TX3LPaxmHKxFdv7VOQHJ'; // Liam - Craby's voice
const PORT = process.env.PORT || 3000;

// Voice-specific system instruction (prepended to EVERY message)
const VOICE_CONTEXT = `[VOICE CALL - TTS OUTPUT]
CRITICAL: Your response will be READ ALOUD. Follow these rules STRICTLY:
- NO emoji (🦀📉 etc) - they sound terrible when read aloud
- NO markdown (**bold**, *italic*) - TTS reads the asterisks
- NO symbols ($, %, :) - say "74 dollar" not "$74", say "5 procent" not "5%"  
- NO data formatting like "(24h)" - say "in the last 24 hours"
- Talk naturally like in a phone call, 1-3 sentences max
- Example BAD: "**BTC:** $74,138 📉 (-5%)"
- Example GOOD: "Bitcoin staat op 74 duizend dollar, min 5 procent vandaag"`;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Conversation history per connection
const conversations = new Map();

// Speech-to-Text using ElevenLabs Scribe
async function speechToText(audioBuffer) {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/webm' }), 'audio.webm');
  formData.append('model_id', 'scribe_v2');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`STT failed: ${response.status}`);
  }

  const result = await response.json();
  return result.text;
}

// Get response from OpenClaw (the REAL Craby!)
async function getOpenClawResponse(messages) {
  // Prepare messages for OpenClaw - add voice context to EVERY user message
  const openclawMessages = messages.map((msg) => {
    if (msg.role === 'user') {
      return {
        role: 'user',
        content: `${VOICE_CONTEXT}\n\n${msg.content}`
      };
    }
    return msg;
  });

  const response = await fetch(`${OPENCLAW_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: openclawMessages,
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

// Sanitize text for TTS - remove symbols, emojis, make it speakable
function sanitizeForTTS(text) {
  let result = text;
  
  // Remove markdown formatting
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1'); // **bold** -> bold
  result = result.replace(/\*([^*]+)\*/g, '$1');     // *italic* -> italic
  result = result.replace(/__([^_]+)__/g, '$1');     // __underline__ -> underline
  result = result.replace(/_([^_]+)_/g, '$1');       // _italic_ -> italic
  result = result.replace(/`([^`]+)`/g, '$1');       // `code` -> code
  result = result.replace(/~~([^~]+)~~/g, '$1');     // ~~strike~~ -> strike
  
  // Remove all emojis (comprehensive unicode ranges)
  result = result.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B50}]|[\u{203C}-\u{3299}]/gu, '');
  
  // Handle currency before numbers: $74.138 -> 74.138 dollar
  result = result.replace(/\$\s*([\d.,]+)/g, '$1 dollar');
  result = result.replace(/€\s*([\d.,]+)/g, '$1 euro');
  
  // Handle percentages: -8.77% -> min 8.77 procent, 5% -> 5 procent
  result = result.replace(/([+-]?)\s*([\d.,]+)\s*%/g, (match, sign, num) => {
    const prefix = sign === '-' ? 'min ' : sign === '+' ? 'plus ' : '';
    return `${prefix}${num} procent`;
  });
  
  // Remove parentheses but keep content
  result = result.replace(/\(([^)]+)\)/g, ', $1,');
  
  // Clean up colons in data readouts: "Bitcoin: $74" -> "Bitcoin, 74 dollar"
  result = result.replace(/:\s+/g, ', ');
  
  // Clean up arrows and special chars
  result = result.replace(/[→←↑↓➜►▶•·]/g, '');
  
  // Clean up multiple spaces and punctuation
  result = result.replace(/\s+/g, ' ');
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/\s+([.,!?])/g, '$1');
  result = result.replace(/,\s*$/g, ''); // trailing comma
  
  return result.trim();
}

// Text-to-Speech using ElevenLabs
async function textToSpeech(text) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text,
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
  const conversationId = Date.now().toString();
  conversations.set(conversationId, []);

  ws.on('message', async (data, isBinary) => {
    if (!isBinary) {
      // Text message (could be control commands)
      const msg = data.toString();
      console.log('Received text:', msg);
      
      if (msg === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      
      if (msg === 'reset') {
        conversations.set(conversationId, []);
        ws.send(JSON.stringify({ type: 'status', message: 'Conversation reset' }));
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

      // 2. Add to conversation and get OpenClaw response
      const history = conversations.get(conversationId);
      history.push({ role: 'user', content: transcript });
      
      ws.send(JSON.stringify({ type: 'status', message: 'Thinking...' }));
      const response = await getOpenClawResponse(history);
      console.log('Response:', response);
      
      history.push({ role: 'assistant', content: response });
      
      // Keep history manageable (10 exchanges = 20 messages)
      if (history.length > 20) {
        history.splice(0, 2);
      }
      
      ws.send(JSON.stringify({ type: 'response', text: response }));

      // 3. Sanitize and Text to Speech
      ws.send(JSON.stringify({ type: 'status', message: 'Generating voice...' }));
      const spokenText = sanitizeForTTS(response);
      console.log('TTS text:', spokenText);
      const audioBuffer = await textToSpeech(spokenText);
      
      // Send audio as binary
      ws.send(audioBuffer);
      ws.send(JSON.stringify({ type: 'status', message: 'Ready' }));
      
    } catch (error) {
      console.error('Error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    conversations.delete(conversationId);
  });
});

server.listen(PORT, () => {
  console.log(`🦀 Craby Voice Chat running on port ${PORT}`);
  console.log(`   OpenClaw API: ${OPENCLAW_API_URL}`);
});
