# Third-Party Notices

## Brain Atlas

The Claudia Dashboard Atlas module adapts the taxonomy, deterministic anatomical
layout, and rendering ideas from [Brain Atlas](https://github.com/colorpulse6/brain-atlas)
v0.2.2.

MIT License

Copyright (c) 2026 colorpulse6

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## whisper.cpp and Whisper

Local speech recognition uses the prebuilt `ggml-org/whisper.cpp` release
`b4938` and the English `base.en` model converted from OpenAI Whisper. The
installer pins and verifies both artifacts by SHA-256 before activation.

- `whisper.cpp`: <https://github.com/ggml-org/whisper.cpp> (MIT License)
- Whisper: <https://github.com/openai/whisper> (MIT License)

The runtime and model files are installed outside this repository and are not
included in either Git destination.

## Piper and the Joe voice model

Local reply synthesis uses [OHF-Voice Piper](https://github.com/OHF-Voice/piper1-gpl)
v1.4.2 under the GNU General Public License v3.0. The installer pins Piper and
keeps the runtime outside this repository.

The `en_US-joe-medium` voice is downloaded from the
[Piper voices collection](https://huggingface.co/rhasspy/piper-voices) at a fixed
revision and verified by SHA-256. Its model card identifies the source dataset
as [Nabu Casa voice-datasets](https://github.com/NabuCasa/voice-datasets) under
CC0. Model files are installed outside both Git destinations.
