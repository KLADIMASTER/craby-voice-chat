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

// Password for access (spoken phrase to check)
const ACCESS_PASSWORD = 'broodje biefstuk';

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Password verification endpoint
app.post('/api/verify-password', express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
  try {
    console.log('Password verification request received');
    
    const audioBuffer = req.body;
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.json({ success: false, error: 'No audio received' });
    }
    
    // Transcribe using ElevenLabs
    const audioType = detectAudioType(audioBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: audioType.mime }), `audio.${audioType.ext}`);
    formData.append('model_id', 'scribe_v2');

    const sttResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      body: formData,
    });

    if (!sttResponse.ok) {
      console.error('STT failed:', sttResponse.status);
      return res.json({ success: false, error: 'Speech recognition failed' });
    }

    const result = await sttResponse.json();
    const transcript = (result.text || '').toLowerCase().trim();
    console.log('Password attempt transcript:', transcript);

    // Check if password phrase is in transcript (flexible matching)
    let passwordMatch = false;
    if (transcript.includes('broodje') && transcript.includes('biefstuk')) {
      passwordMatch = true;
    }
    if (transcript.includes('brootje biefstuk') || transcript.includes('broodje beefstuk')) {
      passwordMatch = true;
    }

    console.log('Password match:', passwordMatch);
    res.json({ success: passwordMatch, transcript });
    
  } catch (error) {
    console.error('Password verification error:', error);
    res.json({ success: false, error: error.message });
  }
});

// Generate password prompt TTS
app.get('/api/password-prompt', async (req, res) => {
  try {
    const promptText = "Welkom! Wat is het wachtwoord?";
    const audioBuffer = await textToSpeech(promptText);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (error) {
    console.error('Password prompt TTS error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate wrong password TTS
app.get('/api/wrong-password', async (req, res) => {
  try {
    const promptText = "Verkeerd wachtwoord. Probeer het opnieuw.";
    const audioBuffer = await textToSpeech(promptText);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (error) {
    console.error('Wrong password TTS error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
// System prompt that tells Craby to respond in a voice-call-friendly way
const VOICE_SYSTEM_PROMPT = `Je bent Craby en je praat via een TELEFOONGESPREK. De gebruiker hoort je antwoord als gesproken audio.

KRITIEKE REGELS VOOR SPRAAK-OUTPUT:
- Schrijf ALLEEN vloeiende, gesproken tekst — alsof je echt aan het bellen bent
- GEEN markdown: geen ##, **, *, \`, ---, >, bullet points of nummering
- GEEN emoji's
- GEEN lijstjes of opsommingen — verwerk alles in lopende zinnen en alinea's
- GEEN speciale tekens of formatting
- Schrijf getallen uit waar logisch: "$74.000" → "vierenzeventig duizend dollar"
- Percentages: "-5%" → "min vijf procent"
- Houd het conversationeel en beknopt — max 3-4 alinea's
- Je praat Nederlands tenzij de gebruiker Engels praat
- Wees direct en informatief, geen onnodige intro's

VOORBEELD VAN GOEDE OUTPUT:
"Oké, de cryptomarkt zit behoorlijk in de min. Bitcoin staat rond de zesenzeventig duizend dollar, dat is flink gezakt van de all-time high van honderdacht duizend. De hoofdreden is de onzekerheid rond Trump's tarieven. Daar komt nog een grote commodity crash bij, goud en zilver zijn flink gedaald, en dat heeft een cascade van liquidaties veroorzaakt in crypto."

VOORBEELD VAN SLECHTE OUTPUT (DIT MAG NIET):
"## 🔥 Crypto Analyse\\n- BTC: $76K 📉\\n- SOL: -44%\\n---\\n### Oorzaken:"`;

async function getOpenClawResponse(messages) {
  // Prepend voice system prompt to messages
  const voiceMessages = [
    { role: 'system', content: VOICE_SYSTEM_PROMPT },
    ...messages
  ];

  const response = await fetch(`${OPENCLAW_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: voiceMessages,
      max_tokens: 800,
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

// Strip all markdown and formatting artifacts from text (used as pre-processing + fallback)
function stripMarkdown(text) {
  let result = text;
  // Remove code blocks
  result = result.replace(/```[\s\S]*?```/g, '');
  // Remove headers (## Title)
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Remove horizontal rules (---, ***, ___)
  result = result.replace(/^[\-\*_]{3,}\s*$/gm, '');
  // Remove blockquotes (> text)
  result = result.replace(/^>\s*/gm, '');
  // Remove bold **text** and __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  // Remove italic *text* and _text_
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  // Remove inline code `text`
  result = result.replace(/`([^`]+)`/g, '$1');
  // Remove bullet points (- item, * item, numbered lists)
  result = result.replace(/^\s*[\-\*•]\s+/gm, '');
  result = result.replace(/^\s*\d+[\.\)]\s+/gm, '');
  // Remove ALL emoji (comprehensive ranges)
  result = result.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{200D}]|[\u{20E3}]|[\u{FE0F}]/gu, '');
  // Remove leftover markdown artifacts
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [links](url) → links
  result = result.replace(/\|/g, ','); // table pipes
  // Clean up whitespace
  result = result.replace(/\n{3,}/g, '\n\n'); // max 2 newlines
  result = result.replace(/^\s+$/gm, ''); // empty lines with spaces
  result = result.replace(/\s+/g, ' ').trim(); // collapse to single spaces
  return result;
}

// Convert text to TTS-friendly format using GPT-4o-mini (safety net after system prompt)
async function makeTTSFriendly(text) {
  // First do a hard strip of any remaining markdown/emoji
  const preClean = stripMarkdown(text);
  
  // If text is already clean enough (no special chars remain), skip the API call
  const hasMarkdownArtifacts = /[#*_`>|]|^\s*-\s/m.test(preClean);
  const hasEmoji = /[\u{1F300}-\u{1FAFF}]/u.test(preClean);
  
  if (!hasMarkdownArtifacts && !hasEmoji) {
    console.log('Text already clean, skipping GPT-4o formatting');
    return preClean;
  }

  const systemPrompt = `Je bent een tekst-formatter voor text-to-speech. Je ENIGE taak is de input herschrijven zodat het natuurlijk klinkt als gesproken tekst.

REGELS:
- Verwijder ALLE emoji
- Verwijder ALLE markdown (headers, bold, italic, code, lijstjes, horizontal rules)
- Maak er vloeiende, gesproken zinnen van — geen opsommingen
- Schrijf prijzen uit: "$74.000" → "vierenzeventig duizend dollar"
- Percentages: "-5%" → "min vijf procent"
- Houd dezelfde taal als de input (Nederlands/Engels)
- Houd dezelfde betekenis en persoonlijkheid
- Output ALLEEN de geconverteerde tekst, niets anders`;

  try {
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
          { role: 'user', content: preClean }
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.error('GPT-4o TTS formatting failed:', response.status);
      return preClean; // Pre-cleaned text is already decent
    }

    const result = await response.json();
    return result.choices[0].message.content;
  } catch (err) {
    console.error('makeTTSFriendly error:', err);
    return preClean;
  }
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
