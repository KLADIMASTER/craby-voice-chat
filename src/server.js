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
async function getOpenClawResponse(messages) {
  const response = await fetch(`${OPENCLAW_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: messages,
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

// ============================================================
// TTS CLEANUP PIPELINE
// Flow: raw markdown → stripMarkdown() → GPT-4o-mini rewrite → textToSpeech()
// ============================================================

// Step 1: Hard regex strip of all markdown, emoji, and formatting artifacts
function stripMarkdown(text) {
  let r = text;

  // --- Block-level elements ---
  r = r.replace(/```[\s\S]*?```/g, '');                    // code blocks
  r = r.replace(/^#{1,6}\s+(.*)/gm, '$1.');                // ## Header → Header. (add period for pause)
  r = r.replace(/^[\-\*_]{3,}\s*$/gm, '');                 // horizontal rules (---, ***, ___)
  r = r.replace(/^>\s*/gm, '');                             // blockquotes

  // --- Inline elements ---
  r = r.replace(/\*\*([^*]+)\*\*/g, '$1');                  // **bold**
  r = r.replace(/__([^_]+)__/g, '$1');                      // __bold__
  r = r.replace(/\*([^*]+)\*/g, '$1');                      // *italic*
  r = r.replace(/_([^_\s][^_]*)_/g, '$1');                  // _italic_ (but not snake_case)
  r = r.replace(/`([^`]+)`/g, '$1');                        // `inline code`
  r = r.replace(/~~([^~]+)~~/g, '$1');                      // ~~strikethrough~~

  // --- Lists → sentences ---
  r = r.replace(/^\s*[\-\*•]\s+/gm, '');                   // - bullet / * bullet / • bullet
  r = r.replace(/^\s*\d+[\.\)]\s+/gm, '');                 // 1. numbered / 1) numbered

  // --- Links and images ---
  r = r.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');          // ![alt](url) → alt
  r = r.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');           // [text](url) → text
  r = r.replace(/https?:\/\/\S+/g, '');                    // bare URLs

  // --- Tables ---
  r = r.replace(/^\|.*\|$/gm, (line) => {                  // | col | col | → col, col
    if (/^[\|\s\-:]+$/.test(line)) return '';               // skip separator rows
    return line.replace(/\|/g, ',').replace(/^,|,$/g, '').trim();
  });

  // --- Emoji (comprehensive) ---
  r = r.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{FE0F}\u{2194}-\u{21AA}\u{231A}-\u{23F3}\u{25AA}-\u{25FE}\u{2934}-\u{2935}\u{23CF}\u{23E9}-\u{23EA}\u{23ED}-\u{23EF}\u{23F0}\u{23F8}-\u{23FA}]/gu, '');

  // --- Special characters that sound bad in TTS ---
  r = r.replace(/←|→|↑|↓|↔|⇒|⇐/g, '');                   // arrows
  r = r.replace(/\*+/g, '');                                // leftover asterisks
  r = r.replace(/#{1,6}/g, '');                             // leftover hashes

  // --- Whitespace cleanup ---
  r = r.replace(/,\s*,/g, ',');                             // double commas
  r = r.replace(/\.\s*\./g, '.');                           // double periods
  r = r.replace(/\n{2,}/g, '\n');                           // collapse multiple newlines
  r = r.replace(/^\s*\n/gm, '');                            // remove empty lines
  r = r.replace(/[ \t]+/g, ' ');                            // collapse spaces
  r = r.trim();

  return r;
}

// Step 2: GPT-4o-mini rewrites the cleaned text into natural spoken Dutch/English
async function makeTTSFriendly(text) {
  // Always run stripMarkdown first
  const preClean = stripMarkdown(text);
  console.log('Pre-cleaned text length:', preClean.length);
  console.log('Pre-cleaned preview:', preClean.substring(0, 200));

  const systemPrompt = `Je bent een specialist in het omzetten van tekst naar natuurlijk gesproken taal voor text-to-speech.

JE TAAK: Herschrijf de input als vloeiende, gesproken tekst. Alsof iemand het aan de telefoon vertelt.

KRITIEKE REGELS:
1. ALLEEN lopende zinnen en alinea's. Geen lijstjes, geen opsommingen, geen nummering.
2. Verwerk ALLE informatie in een samenhangend verhaal met goede overgangen.
3. Gebruik verbindingswoorden: "Daarnaast", "Verder", "Wat ook meespeelt", "Een andere factor", "Tot slot".
4. Schrijf getallen uit als woorden:
   - "$74.000" of "$74K" → "vierenzeventig duizend dollar"
   - "$2.5 miljard" → "twee en een half miljard dollar"  
   - "0.44 SOL" → "nul komma vierenveertig SOL"
   - "-44%" → "min vierenveertig procent"
   - "$0.000030" → "nul komma nul nul nul nul drie dollar"
5. Verwijder ALLE overgebleven formatting: hashes, sterretjes, underscores, backticks, streepjes als opsommingsteken.
6. Als er nog emoji of speciale tekens instaan, verwijder ze.
7. Maak het beknopt — max 4-5 alinea's. Vat samen als het te lang is.
8. Houd dezelfde taal als de input.
9. Output ALLEEN de omgezette tekst. Geen uitleg, geen meta-commentaar.

VOORBEELD INPUT:
"Bitcoin staat rond 76.000 dollar, dat is flink gezakt van de all-time high van 108.000. De hoofdreden is Trump's tarieven chaos. Daarnaast was er een grote commodity crash, goud min 18%, zilver min 30%. Dit veroorzaakte liquidaties in crypto, 2.5 miljard in 24 uur. SOL staat rond 93 dollar, min 44% in 90 dagen."

VOORBEELD OUTPUT:
"Bitcoin staat momenteel rond de zesenzeventig duizend dollar, en dat is behoorlijk gezakt van de all-time high van honderdacht duizend. De belangrijkste reden is de chaos rond Trump's tarieven, wat voor veel onzekerheid zorgt op de markten. Daarnaast was er een flinke commodity crash. Goud daalde met achttien procent en zilver crashte met dertig procent. Dat heeft een cascade van liquidaties veroorzaakt in crypto, goed voor twee en een half miljard dollar aan liquidaties in slechts vierentwintig uur. Solana staat nu rond de drieënnegentig dollar, een daling van vierenveertig procent in negentig dagen."`;

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
        max_tokens: 1200,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.error('GPT-4o TTS formatting failed:', response.status);
      return preClean;
    }

    const result = await response.json();
    const ttsText = result.choices[0].message.content;
    
    // Final safety pass: strip any formatting the model snuck in
    const finalClean = ttsText
      .replace(/\*+/g, '')
      .replace(/#+/g, '')
      .replace(/`/g, '')
      .replace(/_/g, ' ')
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log('TTS-friendly text length:', finalClean.length);
    console.log('TTS-friendly preview:', finalClean.substring(0, 200));
    return finalClean;
  } catch (err) {
    console.error('makeTTSFriendly error:', err);
    return preClean;
  }
}

// Text-to-Speech using ElevenLabs
async function textToSpeech(text) {
  // Text should already be clean when coming through the TTS pipeline
  // This is a final safety net + length limiter
  let cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*+/g, '')
    .replace(/#+/g, '')
    .replace(/`/g, '')
    .trim();

  // Limit length for TTS (ElevenLabs has limits)
  if (cleanText.length > 2500) {
    // Cut at last sentence boundary before limit
    const cutPoint = cleanText.lastIndexOf('.', 2400);
    cleanText = cutPoint > 1500 ? cleanText.substring(0, cutPoint + 1) : cleanText.substring(0, 2500);
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
