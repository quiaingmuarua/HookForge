#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../" && pwd)"
lab_tools="$repo_root/.runtime/toolchain"
export ANDROID_HOME="${ANDROID_HOME:-$lab_tools/android-sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
if [[ -x "$lab_tools/node-v22.19.0-linux-x64/bin/node" ]]; then
  export PATH="$lab_tools/node-v22.19.0-linux-x64/bin:$PATH"
fi
test_python="${API33_PYTHON:-$lab_tools/python/venv/bin/python}"
if [[ ! -x "$test_python" ]]; then
  test_python=python3
fi
export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
test_abi="${API33_ABI:-x86_64}"
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  if [[ "${arguments[index]}" == --abi && $((index + 1)) -lt ${#arguments[@]} ]]; then
    test_abi="${arguments[index + 1]}"
  elif [[ "${arguments[index]}" == --abi=* ]]; then
    test_abi="${arguments[index]#--abi=}"
  fi
done
test_apk="${API33_APK:-$repo_root/.runtime/fixtures/detect-env-api33-x86_64.apk}"

test_version="$("$test_python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/frida"]["version"])' "$repo_root/package-lock.json")"
server_arch="$("$test_python" -c 'import sys; sys.path.insert(0, sys.argv[1]); from prepare import load_spec; print(load_spec(abi=sys.argv[2])["serverArch"])' "$repo_root/test/api33" "$test_abi")"
test_server="${API33_FRIDA_SERVER:-$lab_tools/python/frida-server-$test_version-android-$server_arch}"

if [[ ! -f "$test_apk" || ! -f "$test_server" ]]; then
  printf 'Missing detect-env APK or frida-server. See test/api33/README.md.\n' >&2
  exit 1
fi
if [[ "$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null || true)" != 1 ]]; then
  printf 'Emulator %s is not ready; start it and wait for sys.boot_completed=1.\n' "$ANDROID_SERIAL" >&2
  exit 1
fi
exec "$test_python" "$repo_root/test/api33/run.py" \
  --abi "$test_abi" --serial "$ANDROID_SERIAL" --apk "$test_apk" --server "$test_server" "$@"
