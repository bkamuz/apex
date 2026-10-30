#!/usr/bin/env bash
# Reproducible build of the SMLib kernel WebAssembly module used by the web
# app's geometry worker. Output: apps/web/src/kernel/smlib/apex_smlib.{mjs,wasm}
#
# Requires emsdk; the committed artefact was built with emscripten 6.0.13:
#   git clone https://github.com/emscripten-core/emsdk && cd emsdk
#   ./emsdk install 6.0.13 && ./emsdk activate 6.0.13 && source emsdk_env.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$root/apps/web/src/kernel/smlib"
obj="${SMLIB_OBJ_DIR:-$here/build/wasm}"
jobs="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
mkdir -p "$obj" "$out"

flags=(-std=c++17 -Oz -flto -fwasm-exceptions -DNDEBUG -DNOMINMAX -DSM_NO_DEBUG_CODE
  -DSM_NO_GFX_OUTPUT_CODE -DSM_API_EXPORTS -ffp-contract=off -w
  -I"$here/shim" -I"$here/SMLib/inc" -I"$here/SM_API/inc" -include SmApiGeneral.h)

compile() {
  local f="$1" o
  o="$obj/$(basename "$(dirname "$(dirname "$f")")")_$(basename "$f" .cpp).o"
  [ -f "$o" ] || em++ "${flags[@]}" -c "$f" -o "$o"
}
running=0
for f in "$here"/SMLib/src/*.cpp "$here"/SM_API/src/*.cpp; do
  case "$f" in *StdAfx.cpp | *SmDllMain.cpp) continue ;; esac
  compile "$f" &
  running=$((running + 1))
  if [ "$running" -ge "$jobs" ]; then wait -n; running=$((running - 1)); fi
done
wait

em++ "${flags[@]}" "$here/bridge/apex_smlib.cpp" "$obj"/*.o \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH \
  -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=1048576 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_apex_sm_run,_apex_sm_points,_apex_sm_npoints,_apex_sm_tris,_apex_sm_ntris,_apex_sm_volume,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPF64,HEAP32 \
  -o "$out/apex_smlib.mjs"
ls -l "$out"
