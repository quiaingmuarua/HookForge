#!/usr/bin/env bash
set -euo pipefail

# Install system-images;android-33;default;<API33_ABI> before starting this owner.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../" && pwd)"
lab_tools="$repo_root/.runtime/toolchain"
export ANDROID_HOME="${ANDROID_HOME:-$lab_tools/android-sdk}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$lab_tools/android-avd}"
test_python="${API33_PYTHON:-python3}"
output="${API33_EMULATOR_OUTPUT:-$repo_root/.runtime/frida-api33/emulator/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  if [[ "${arguments[index]}" == --output && $((index + 1)) -lt ${#arguments[@]} ]]; then
    output="${arguments[index + 1]}"
  elif [[ "${arguments[index]}" == --output=* ]]; then
    output="${arguments[index]#--output=}"
  fi
done
printf 'Emulator evidence: %s\nStop with: %q %q stop --output %q\n' "$output" "$test_python" "$repo_root/test/api33/emulator.py" "$output"
exec "$test_python" "$repo_root/test/api33/emulator.py" start \
  --sdk-root "$ANDROID_HOME" --avd-home "$ANDROID_AVD_HOME" \
  --avd-name "${API33_AVD_NAME:-agentforge_api33}" \
  --port "${API33_EMULATOR_PORT:-5554}" --abi "${API33_ABI:-x86_64}" \
  --output "$output" "$@"
