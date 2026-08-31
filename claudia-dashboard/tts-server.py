#!/usr/bin/env python3
"""Bounded loopback-only HTTP adapter for Claudia's pinned Piper voice."""

from __future__ import annotations

import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice, SynthesisConfig


HOST = os.environ.get("CLAUDIA_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLAUDIA_TTS_PORT", "4321"))
MODEL_PATH = os.environ.get(
    "CLAUDIA_TTS_MODEL",
    os.path.expanduser(
        "~/.local/share/claudia-voice/piper-1.4.2/models/en_US-joe-medium.onnx"
    ),
)
MAX_REQUEST_BYTES = 8_192
MAX_TEXT_CHARACTERS = 1_500
voice = PiperVoice.load(MODEL_PATH)
synthesis_lock = threading.Lock()
synthesis_config = SynthesisConfig(length_scale=1.0, volume=1.0, normalize_audio=True)


class ClaudiaTtsServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "ClaudiaTTS/1"
    sys_version = ""

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"tts {self.client_address[0]} {format_string % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_json(404, {"error": "Not found."})
            return
        self.send_json(200, {"ok": True, "engine": "piper", "voice": "en_US-joe-medium"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/synthesize":
            self.send_json(404, {"error": "Not found."})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "JSON is required."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid content length."})
            return
        if content_length < 2 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Synthesis request is too large."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Malformed JSON."})
            return
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip():
            self.send_json(400, {"error": "Speakable text is required."})
            return
        text = text.strip()
        if len(text) > MAX_TEXT_CHARACTERS:
            self.send_json(413, {"error": "Speakable text is too long."})
            return
        try:
            output = io.BytesIO()
            with synthesis_lock, wave.open(output, "wb") as wav_file:
                voice.synthesize_wav(text, wav_file, syn_config=synthesis_config)
            audio = output.getvalue()
        except Exception as error:  # Piper/ONNX failure boundary
            print(f"tts synthesis error: {type(error).__name__}", flush=True)
            self.send_json(500, {"error": "Synthesis failed safely."})
            return
        self.send_response(200)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


if __name__ == "__main__":
    server = ClaudiaTtsServer((HOST, PORT), Handler)
    print(f"Claudia local voice is online at http://{HOST}:{PORT}", flush=True)
    server.serve_forever(poll_interval=0.5)
