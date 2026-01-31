require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

// Config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const VOICE_ID = process.env.VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // Default: George
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT = `You are Craby, a cyber-crab AI assistant 🦀. You're chill but direct, a bit chaotic, always ready to help.
You speak Dutch and English fluently. Match the language the user speaks.
Keep responses concise for voice - aim for 1-3 sentences unless more detail is needed.
You have access to various skills like crypto trading, image generation, and more - but in this voice interface, focus on conversation.`;

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

// Get LLM response from OpenRouter
async function getLLMResponse(messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM failed: ${response.status}`);
  }

  const result = await response.json();
  return result.choices[0].message.content;
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

      // 2. Add to conversation and get LLM response
      const history = conversations.get(conversationId);
      history.push({ role: 'user', content: transcript });
      
      ws.send(JSON.stringify({ type: 'status', message: 'Thinking...' }));
      const response = await getLLMResponse(history);
      console.log('Response:', response);
      
      history.push({ role: 'assistant', content: response });
      
      // Keep history manageable
      if (history.length > 20) {
        history.splice(0, 2);
      }
      
      ws.send(JSON.stringify({ type: 'response', text: response }));

      // 3. Text to Speech
      ws.send(JSON.stringify({ type: 'status', message: 'Generating voice...' }));
      const audioBuffer = await textToSpeech(response);
      
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
  console.log(`Voice chat server running on port ${PORT}`);
});
