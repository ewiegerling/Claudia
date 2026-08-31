import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_VOICE_AUDIO_BYTES,
  MAX_VOICE_SPEECH_CHARACTERS,
  normalizeSpeechText,
  parseOpenClawVoiceResponse,
  validatePcmWav,
} from '../voice.mjs';

export function makePcmWav(durationSeconds = 0.25) {
  const dataBytes = Math.round(16_000 * durationSeconds) * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

test('canonical local voice WAV validation is strict and bounded', () => {
  const info = validatePcmWav(makePcmWav());
  assert.deepEqual(info, { durationSeconds: 0.25, sampleRate: 16_000, channels: 1, bitsPerSample: 16 });

  assert.throws(() => validatePcmWav(Buffer.alloc(43)), /valid WAV/);
  assert.throws(() => validatePcmWav(makePcmWav(0.1)), /too short/);
  assert.throws(() => validatePcmWav(makePcmWav(32.1)), /exceeds 32 seconds/);
  const stereo = makePcmWav();
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => validatePcmWav(stereo), /mono 16 kHz 16-bit PCM/);
  assert.ok(MAX_VOICE_AUDIO_BYTES < 1_200_000);
});

test('OpenClaw bridge parser returns only bounded assistant payload text', () => {
  const payload = JSON.stringify({ result: { payloads: [{ text: 'Normal spoken answer.' }] }, ignored: 'private metadata' });
  assert.equal(parseOpenClawVoiceResponse(payload), 'Normal spoken answer.');
  assert.throws(() => parseOpenClawVoiceResponse('not json'), /malformed agent data/);
  assert.throws(() => parseOpenClawVoiceResponse('{}'), /empty voice response/);
});

test('local speech text is sanitized and bounded before Piper synthesis', () => {
  const text = normalizeSpeechText('**Status:** [dashboard](https://private.invalid) `healthy`. https://example.com');
  assert.equal(text, 'Status: dashboard healthy. link provided on screen');
  assert.equal(normalizeSpeechText('x'.repeat(MAX_VOICE_SPEECH_CHARACTERS + 50)).length, MAX_VOICE_SPEECH_CHARACTERS);
  assert.equal(normalizeSpeechText('```sh\nsecret command\n```'), 'code block omitted');
});
