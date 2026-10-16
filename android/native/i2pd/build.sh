#!/usr/bin/env bash
# Builds i2pd as static libraries for Android (arm64-v8a, x86_64), plus the
# SynthOrg C shim, and links a smoke-test executable to prove all symbols resolve.
# Run inside WSL/Linux x86_64:   bash android/native/i2pd/build.sh [abi...]
#
# Everything downloaded or built goes to $CACHE (default ~/.cache/synthorg-i2pd-android);
# only out/ is written next to this script. Nothing is installed system-wide.
set -euo pipefail

# ---------------------------------------------------------------- pinned versions
NDK_VER=r28c
NDK_SHA1=a7b54a5de87fecd125a17d54f73c446199e72a64          # dl.google.com repository2-3.xml
CMAKE_VER=3.31.12
CMAKE_SHA256=0dc2e9a6860f06bf10bd8fadc03e35d9eeb4df46e33763a7e480e987758f385c  # Kitware SHA-256.txt
OPENSSL_VER=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a # openssl .sha256
BOOST_VER=1.92.0
BOOST_SHA256=9bed76128d4e46755dbe818487788c6fceb6f72b378f4daa49b7e1e600d9088d  # boost-*-cmake.tar.xz.txt
I2PD_VER=2.61.0
I2PD_SHA256=409cd3c0257491286611ab6aaf690940c7248fb898377c13fadb65a836e2a0ab   # pinned (GitHub tag archive, no upstream sum)
API=24

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${CACHE:-$HOME/.cache/synthorg-i2pd-android}"
OUT="$HERE/out"
JOBS="${JOBS:-$(nproc)}"
ABIS=("${@:-arm64-v8a x86_64}")
# shellcheck disable=SC2206
ABIS=(${ABIS[*]})

DL="$CACHE/dl"; SRC="$CACHE/src"; TOOLS="$CACHE/tools"; BUILD="$CACHE/build"; PREFIX="$CACHE/prefix"
mkdir -p "$DL" "$SRC" "$TOOLS" "$BUILD" "$PREFIX"

log() { printf '\n=== %s\n' "$*"; }

# fetch <url> <file> <algo> <sum>
fetch() {
  local url="$1" f="$DL/$2" algo="$3" sum="$4"
  if [[ ! -f "$f" ]] || ! echo "$sum  $f" | "${algo}sum" -c --status; then
    log "download $url"
    curl -fL --retry 3 --connect-timeout 30 --max-time 3600 -o "$f.part" "$url"
    mv "$f.part" "$f"
  fi
  echo "$sum  $f" | "${algo}sum" -c
}

# ---------------------------------------------------------------- sources & tools
fetch "https://dl.google.com/android/repository/android-ndk-${NDK_VER}-linux.zip" \
      "android-ndk-${NDK_VER}-linux.zip" sha1 "$NDK_SHA1"
fetch "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VER}/cmake-${CMAKE_VER}-linux-x86_64.tar.gz" \
      "cmake-${CMAKE_VER}-linux-x86_64.tar.gz" sha256 "$CMAKE_SHA256"
fetch "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VER}/openssl-${OPENSSL_VER}.tar.gz" \
      "openssl-${OPENSSL_VER}.tar.gz" sha256 "$OPENSSL_SHA256"
fetch "https://github.com/boostorg/boost/releases/download/boost-${BOOST_VER}/boost-${BOOST_VER}-cmake.tar.xz" \
      "boost-${BOOST_VER}-cmake.tar.xz" sha256 "$BOOST_SHA256"
fetch "https://github.com/PurpleI2P/i2pd/archive/refs/tags/${I2PD_VER}.tar.gz" \
      "i2pd-${I2PD_VER}.tar.gz" sha256 "$I2PD_SHA256"

NDK="$TOOLS/android-ndk-${NDK_VER}"
if [[ ! -x "$NDK/ndk-build" ]]; then
  log "unpack NDK"; rm -rf "$NDK"
  bsdtar -xf "$DL/android-ndk-${NDK_VER}-linux.zip" -C "$TOOLS"   # bsdtar keeps exec bits (unzip may be absent)
fi
CMAKE_DIR="$TOOLS/cmake-${CMAKE_VER}-linux-x86_64"
[[ -x "$CMAKE_DIR/bin/cmake" ]] || tar -xzf "$DL/cmake-${CMAKE_VER}-linux-x86_64.tar.gz" -C "$TOOLS"
CMAKE="$CMAKE_DIR/bin/cmake"

unpack() { # <archive> <dirname>
  [[ -d "$SRC/$2" ]] || { log "unpack $2"; tar -xf "$DL/$1" -C "$SRC"; }
}
unpack "openssl-${OPENSSL_VER}.tar.gz" "openssl-${OPENSSL_VER}"
unpack "boost-${BOOST_VER}-cmake.tar.xz" "boost-${BOOST_VER}"
unpack "i2pd-${I2PD_VER}.tar.gz" "i2pd-${I2PD_VER}"
I2PD_SRC="$SRC/i2pd-${I2PD_VER}"

TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake"

# Boost libraries: compiled ones used by i2pd + header-only ones it includes
BOOST_LIBS="filesystem;program_options;atomic;system;asio;algorithm;dynamic_bitset;lexical_cast;property_tree;smart_ptr;static_assert"

build_abi() {
  local abi="$1" ossl_target triple
  case "$abi" in
    arm64-v8a) ossl_target=android-arm64;  triple=aarch64-linux-android ;;
    x86_64)    ossl_target=android-x86_64; triple=x86_64-linux-android ;;
    *) echo "unsupported ABI $abi" >&2; exit 1 ;;
  esac
  local P="$PREFIX/$abi" B="$BUILD/$abi"
  mkdir -p "$P" "$B"
  local CMAKE_ANDROID=(
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" -DANDROID_ABI="$abi" -DANDROID_PLATFORM="android-$API"
    -DANDROID_STL=c++_static -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  )

  # ---- OpenSSL
  if [[ ! -f "$P/openssl/lib/libcrypto.a" ]]; then
    log "[$abi] OpenSSL $OPENSSL_VER"
    rm -rf "$B/openssl"; cp -a "$SRC/openssl-${OPENSSL_VER}" "$B/openssl"
    (
      cd "$B/openssl"
      export ANDROID_NDK_ROOT="$NDK" PATH="$TC/bin:$PATH"
      ./Configure "$ossl_target" no-shared no-tests no-docs no-apps no-module \
        -D__ANDROID_API__=$API -fPIC --prefix="$P/openssl" --libdir=lib
      make -j"$JOBS" build_libs >/dev/null
      make install_dev >/dev/null
    )
  fi

  # ---- Boost (CMake build)
  if [[ ! -f "$P/boost/lib/libboost_program_options.a" ]]; then
    log "[$abi] Boost $BOOST_VER ($BOOST_LIBS)"
    rm -rf "$B/boost"
    "$CMAKE" -S "$SRC/boost-${BOOST_VER}" -B "$B/boost" "${CMAKE_ANDROID[@]}" \
      -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DBOOST_INCLUDE_LIBRARIES="$BOOST_LIBS" \
      -DBOOST_INSTALL_LAYOUT=system -DCMAKE_INSTALL_PREFIX="$P/boost" >/dev/null
    "$CMAKE" --build "$B/boost" -j"$JOBS" >/dev/null
    "$CMAKE" --install "$B/boost" >/dev/null
  fi
  local BOOST_CMAKE_DIR
  BOOST_CMAKE_DIR="$(ls -d "$P"/boost/lib/cmake/Boost-*)"

  # ---- i2pd libi2pd, libi2pdclient, libi2pdlang
  if [[ ! -f "$B/i2pd/libi2pd.a" ]]; then
    log "[$abi] i2pd $I2PD_VER"
    rm -rf "$B/i2pd"
    "$CMAKE" -S "$I2PD_SRC/build" -B "$B/i2pd" "${CMAKE_ANDROID[@]}" \
      -DWITH_STATIC=ON -DWITH_LIBRARY=ON -DWITH_BINARY=OFF -DWITH_UPNP=OFF -DWITH_HARDENING=OFF \
      -DCMAKE_CXX_FLAGS="-fPIC" \
      -DCMAKE_FIND_ROOT_PATH="$P/boost;$P/openssl" \
      -DBoost_DIR="$BOOST_CMAKE_DIR" -DBoost_NO_SYSTEM_PATHS=ON \
      -DOPENSSL_ROOT_DIR="$P/openssl" -DOPENSSL_USE_STATIC_LIBS=ON
    "$CMAKE" --build "$B/i2pd" -j"$JOBS"
  fi

  # ---- daemon sources + SynthOrg shim
  log "[$abi] shim"
  "$CMAKE" -S "$HERE/shim" -B "$B/shim" "${CMAKE_ANDROID[@]}" \
    -DI2PD_SRC="$I2PD_SRC" -DBOOST_PREFIX="$P/boost" -DOPENSSL_PREFIX="$P/openssl" >/dev/null
  "$CMAKE" --build "$B/shim" -j"$JOBS"

  # ---- collect
  local L="$OUT/$abi/lib"
  rm -rf "$OUT/$abi"; mkdir -p "$L"
  cp "$B/shim/libi2pd_shim.a" "$B/shim/libi2pddaemon.a" \
     "$B/i2pd/libi2pdclient.a" "$B/i2pd/libi2pd.a" "$B/i2pd/libi2pdlang.a" \
     "$P/boost/lib/libboost_program_options.a" "$P/boost/lib/libboost_filesystem.a" \
     "$P/boost/lib/libboost_atomic.a" \
     "$P/openssl/lib/libssl.a" "$P/openssl/lib/libcrypto.a" "$L/"
  # the NDK toolchain compiles with -g: drop DWARF from the copies in out/ (about 10x smaller);
  # the unstripped archives stay in $CACHE/build and $CACHE/prefix. KEEP_DEBUG=1 keeps it.
  if [[ "${KEEP_DEBUG:-0}" != 1 ]]; then
    for a in "$L"/*.a; do "$TC/bin/llvm-strip" --strip-debug "$a"; done
  fi

  # ---- link smoke test (same order build.rs must use)
  log "[$abi] link smoke test"
  local CC="$TC/bin/${triple}${API}-clang" CXX="$TC/bin/${triple}${API}-clang++"
  local LIBS=(-L"$L" -li2pd_shim -li2pddaemon -li2pdclient -li2pd -li2pdlang
        -lboost_program_options -lboost_filesystem -lboost_atomic -lssl -lcrypto)
  local T="$B/test"; rm -rf "$T"; mkdir -p "$T"
  # a) like a Rust cdylib: C driver + explicit static libc++
  "$CC" -I"$HERE/shim" "$HERE/test/smoke.c" "${LIBS[@]}" \
        -l:libc++_static.a -l:libc++abi.a -lz -llog -ldl -lm \
        -Wl,-z,max-page-size=16384 -Wl,--gc-sections -Wl,--no-undefined -o "$T/smoke"
  # b) C++ driver with -static-libstdc++
  "$CXX" -I"$HERE/shim" -x c "$HERE/test/smoke.c" "${LIBS[@]}" \
        -static-libstdc++ -lz -llog \
        -Wl,-z,max-page-size=16384 -Wl,--gc-sections -o "$T/smoke-cxx"
  # c) shared library, like the Rust cdylib (every shim symbol must resolve with --no-undefined)
  "$CC" -shared -Wl,--no-undefined -Wl,-z,max-page-size=16384 -Wl,--gc-sections \
        -Wl,--whole-archive "$L/libi2pd_shim.a" -Wl,--no-whole-archive \
        "${LIBS[@]}" -l:libc++_static.a -l:libc++abi.a -lz -llog -ldl -lm -o "$T/libsmoke.so"
  "$TC/bin/llvm-strip" -o "$T/smoke.stripped" "$T/smoke"
  "$TC/bin/llvm-strip" -o "$T/libsmoke.stripped.so" "$T/libsmoke.so"
  "$TC/bin/llvm-readelf" -lW "$T/libsmoke.so" | awk '$1=="LOAD"{print "  LOAD align", $NF}' | sort -u
  # only the stripped test binaries go to out/ (unstripped ones stay in $CACHE/build/<abi>/test)
  mkdir -p "$OUT/$abi/test"
  cp "$T/smoke.stripped" "$OUT/$abi/test/smoke"
  cp "$T/libsmoke.stripped.so" "$OUT/$abi/test/libsmoke.so"
}

for abi in "${ABIS[@]}"; do build_abi "$abi"; done

# ---------------------------------------------------------------- headers & certificates
log "headers, certificates, licenses"
rm -rf "$OUT/include" "$OUT/certificates" "$OUT/licenses"
mkdir -p "$OUT/include/i2pd" "$OUT/licenses"
cp "$HERE/shim/i2pd_shim.h" "$OUT/include/"
for d in libi2pd libi2pd_client i18n; do
  mkdir -p "$OUT/include/i2pd/$d"; cp "$I2PD_SRC/$d"/*.h "$OUT/include/i2pd/$d/"
done
cp "$I2PD_SRC/libi2pd/"*.hpp "$OUT/include/i2pd/libi2pd/" 2>/dev/null || true
mkdir -p "$OUT/include/i2pd/daemon"; cp "$I2PD_SRC/daemon/Daemon.h" "$OUT/include/i2pd/daemon/"
cp -a "$I2PD_SRC/contrib/certificates" "$OUT/certificates"
cp "$I2PD_SRC/LICENSE" "$OUT/licenses/i2pd-LICENSE.txt"
cp "$SRC/openssl-${OPENSSL_VER}/LICENSE.txt" "$OUT/licenses/openssl-LICENSE.txt"
cp "$SRC/boost-${BOOST_VER}/LICENSE_1_0.txt" "$OUT/licenses/boost-LICENSE_1_0.txt"

cat > "$OUT/VERSIONS.txt" <<EOF
i2pd     $I2PD_VER
OpenSSL  $OPENSSL_VER
Boost    $BOOST_VER
NDK      $NDK_VER (clang $("$TC/bin/clang" --version | head -1 | sed 's/.*version //'))
API      $API
STL      c++_static
EOF

log "sizes"
for abi in "${ABIS[@]}"; do
  echo "[$abi]"; ( cd "$OUT/$abi/lib" && ls -l *.a | awk '{printf "  %-32s %10d\n", $9, $5}' && du -cb *.a | tail -1 )
  ls -l "$BUILD/$abi/test" | awk 'NR>1{printf "  test/%-27s %10d\n", $9, $5}'
done
echo "done: $OUT"
