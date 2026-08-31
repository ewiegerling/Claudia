import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MAX_VOICE_AUDIO_BYTES = 1_100_000;
export const MAX_VOICE_PROMPT_CHARACTERS = 2_000;
export const MAX_VOICE_REPLY_CHARACTERS = 6_000;
export const MAX_VOICE_SPEECH_CHARACTERS = 1_500;
export const MAX_VOICE_SPEECH_BYTES = 8 * 1024 * 1024;

function voiceError(message, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode });
}

export async function readRawBody(request, maximumBytes = MAX_VOICE_AUDIO_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw voiceError('Voice recording is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function validatePcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw voiceError('Voice recording is not a valid WAV file.', 400);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE'
    || buffer.toString('ascii', 12, 16) !== 'fmt ' || buffer.toString('ascii', 36, 40) !== 'data') {
    throw voiceError('Voice recording must be canonical PCM WAV.', 400);
  }
  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataBytes = buffer.readUInt32LE(40);
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16
    || dataBytes !== buffer.length - 44) {
    throw voiceError('Voice recording must be mono 16 kHz 16-bit PCM.', 400);
  }
  const durationSeconds = dataBytes / (sampleRate * channels * (bitsPerSample / 8));
  if (durationSeconds < 0.2) throw voiceError('Voice recording is too short.', 400);
  if (durationSeconds > 32) throw voiceError('Voice recording exceeds 32 seconds.', 413);
  return { durationSeconds: Number(durationSeconds.toFixed(2)), sampleRate, channels, bitsPerSample };
}

function normalizeTranscript(value) {
  return String(value || '')
    .replace(/\[(?:blank_audio|silence|music)\]/gi, '')
    .replace(/^\s*\((?:silence|inaudible)\)\s*$/i, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VOICE_PROMPT_CHARACTERS);
}

export function normalizeSpeechText(value) {
  return String(value || '')
    .replace(/```[^]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, 'link provided on screen')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VOICE_SPEECH_CHARACTERS);
}

async function readBoundedResponse(response, maximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw voiceError('Local voice synthesis returned no audio.', 502);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximumBytes) {
      await reader.cancel();
      throw voiceError('Local voice synthesis exceeded its audio limit.', 502);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export function createLocalVoiceSynthesizer({
  endpoint = process.env.DASHBOARD_TTS_URL || 'http://127.0.0.1:4321/synthesize',
  timeoutMs = 45_000,
} = {}) {
  const synthesisUrl = new URL(endpoint);
  const statusUrl = new URL('/health', synthesisUrl);
  return Object.freeze({
    async status() {
      try {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(1_500) });
        return response.ok;
      } catch {
        return false;
      }
    },
    async synthesize(value, { signal } = {}) {
      const text = normalizeSpeechText(value);
      if (!text) throw voiceError('There is no speakable reply.', 400);
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetch(synthesisUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: combined,
        });
      } catch (error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') throw voiceError('Local voice synthesis timed out.', 504);
        throw voiceError('Local voice synthesis is unavailable.', 503);
      }
      if (!response.ok) throw voiceError('Local voice synthesis failed safely.', 502);
      const audio = await readBoundedResponse(response, MAX_VOICE_SPEECH_BYTES);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
        throw voiceError('Local voice synthesis returned malformed audio.', 502);
      }
      return audio;
    },
  });
}

export function createLocalVoiceTranscriber({
  endpoint = process.env.DASHBOARD_STT_URL || 'http://127.0.0.1:4320/inference',
  timeoutMs = 35_000,
} = {}) {
  const inferenceUrl = new URL(endpoint);
  const statusUrl = new URL('/', inferenceUrl);
  return Object.freeze({
    async status() {
      try {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(1_500) });
        return response.ok;
      } catch {
        return false;
      }
    },
    async transcribe(audio, { wake = false, signal } = {}) {
      validatePcmWav(audio);
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), wake ? 'wake.wav' : 'voice.wav');
      form.append('response_format', 'json');
      form.append('language', 'en');
      form.append('temperature', '0');
      form.append('no_speech_thold', wake ? '0.72' : '0.60');
      form.append('prompt', wake ? 'Hey Claudia.' : 'Claudia voice command.');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetch(inferenceUrl, { method: 'POST', body: form, signal: combined });
      } catch (error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') throw voiceError('Local transcription timed out.', 504);
        throw voiceError('Local transcription service is unavailable.', 503);
      }
      if (!response.ok) throw voiceError('Local transcription failed safely.', 502);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw voiceError('Local transcription returned malformed data.', 502);
      }
      return normalizeTranscript(payload?.text);
    },
  });
}

export function parseOpenClawVoiceResponse(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw voiceError('Claudia returned malformed agent data.', 502);
  }
  const text = payload?.result?.payloads
    ?.map((item) => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!text) throw voiceError('Claudia returned an empty voice response.', 502);
  return text.slice(0, MAX_VOICE_REPLY_CHARACTERS);
}

export function createOpenClawVoiceAgent({
  binary = process.env.OPENCLAW_BIN || path.join(os.homedir(), '.npm-global', 'bin', 'openclaw'),
  sessionKey = process.env.DASHBOARD_VOICE_SESSION_KEY || 'agent:main:dashboard-voice',
  timeoutMs = 180_000,
} = {}) {
  return Object.freeze({
    async status() {
      try {
        await access(binary, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async ask(input, { signal } = {}) {
      const message = normalizeTranscript(input);
      if (!message) throw voiceError('Say something first.', 400);
      const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'claudia-voice-'));
      const messagePath = path.join(temporaryDirectory, 'prompt.txt');
      const prompt = [
        '[Voice Terminal request]',
        'Reply for spoken playback in concise natural plain text. Avoid Markdown tables, long code blocks, and raw URLs unless explicitly requested.',
        '',
        `operator said: ${message}`,
      ].join('\n');
      try {
        await writeFile(messagePath, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const { stdout } = await execFileAsync(binary, [
          'agent', '--agent', 'main', '--session-key', sessionKey,
          '--message-file', messagePath, '--thinking', 'minimal', '--timeout', '150', '--json',
        ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs, signal });
        return parseOpenClawVoiceResponse(stdout);
      } catch (error) {
        if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw voiceError('Voice turn interrupted.', 499);
        if (error.killed || error.signal) throw voiceError('Claudia took too long to answer.', 504);
        if (Number.isInteger(error.statusCode)) throw error;
        throw voiceError('The OpenClaw voice bridge is unavailable.', 503);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  });
}
