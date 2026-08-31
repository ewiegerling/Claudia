#!/usr/bin/env bash
set -euo pipefail

voice_version='b4938'
voice_archive_sha256='f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061'
voice_model_sha256='a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002'
piper_version='1.4.2'
piper_pip_zip_sha256='91d5fd9f6f25549fd839c60536c6f1b945316ce3588d34a605635b6071c91526'
piper_voice_revision='de3dcfdf1912bb49726dc4aa11c26017ce2ac62a'
piper_model_sha256='58afce0321b8d9c46d7cdf9c16500cc55a793b4220212dba6b70fb788b3baf06'
piper_config_sha256='3d6d5410b3795cb1950595247ef8f06190719e6fdbfa3a2356d8ec368e1aad33'
voice_data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
voice_root="$voice_data_home/claudia-voice"
voice_release_dir="$voice_root/whisper-$voice_version"
voice_model_dir="$voice_root/models"
piper_release_dir="$voice_root/piper-$piper_version"
piper_model_dir="$piper_release_dir/models"
voice_tmp="$(mktemp -d)"

cleanup_voice_tmp() {
  rm -rf "$voice_tmp"
}
trap cleanup_voice_tmp EXIT

mkdir -p "$voice_release_dir" "$voice_model_dir"
curl -fL --retry 3 --output "$voice_tmp/whisper.tar.gz" \
  "https://github.com/ggml-org/whisper.cpp/releases/download/$voice_version/whisper-bin-ubuntu-x64.tar.gz"
printf '%s  %s\n' "$voice_archive_sha256" "$voice_tmp/whisper.tar.gz" | sha256sum --check
tar -xzf "$voice_tmp/whisper.tar.gz" -C "$voice_release_dir"

curl -fL --retry 3 --output "$voice_tmp/ggml-base.en.bin" \
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'
printf '%s  %s\n' "$voice_model_sha256" "$voice_tmp/ggml-base.en.bin" | sha256sum --check
install -m 0644 "$voice_tmp/ggml-base.en.bin" "$voice_model_dir/ggml-base.en.bin"
ln -sfn "$voice_release_dir" "$voice_root/whisper-current"

mkdir -p "$piper_release_dir/site-packages" "$piper_model_dir"
curl -fL --retry 3 --output "$voice_tmp/pip.pyz" 'https://bootstrap.pypa.io/pip/pip.pyz'
printf '%s  %s\n' "$piper_pip_zip_sha256" "$voice_tmp/pip.pyz" | sha256sum --check
python3 "$voice_tmp/pip.pyz" install --disable-pip-version-check --no-input --upgrade \
  --target "$piper_release_dir/site-packages" "piper-tts==$piper_version"

piper_voice_base="https://huggingface.co/rhasspy/piper-voices/resolve/$piper_voice_revision/en/en_US/joe/medium/en_US-joe-medium"
curl -fL --retry 3 --output "$voice_tmp/en_US-joe-medium.onnx" "$piper_voice_base.onnx"
curl -fL --retry 3 --output "$voice_tmp/en_US-joe-medium.onnx.json" "$piper_voice_base.onnx.json"
printf '%s  %s\n' "$piper_model_sha256" "$voice_tmp/en_US-joe-medium.onnx" | sha256sum --check
printf '%s  %s\n' "$piper_config_sha256" "$voice_tmp/en_US-joe-medium.onnx.json" | sha256sum --check
install -m 0644 "$voice_tmp/en_US-joe-medium.onnx" "$piper_model_dir/en_US-joe-medium.onnx"
install -m 0644 "$voice_tmp/en_US-joe-medium.onnx.json" "$piper_model_dir/en_US-joe-medium.onnx.json"

printf 'Voice runtime installed under %s\n' "$voice_root"
