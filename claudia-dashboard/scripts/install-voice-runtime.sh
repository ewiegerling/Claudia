#!/usr/bin/env bash
set -euo pipefail

voice_version='b4938'
voice_archive_sha256='f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061'
voice_model_sha256='a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002'
voice_data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
voice_root="$voice_data_home/claudia-voice"
voice_release_dir="$voice_root/whisper-$voice_version"
voice_model_dir="$voice_root/models"
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

printf 'Voice runtime installed under %s\n' "$voice_root"
