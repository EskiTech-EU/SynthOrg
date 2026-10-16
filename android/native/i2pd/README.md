# i2pd for Android (static libraries + C shim)

The I2P router (i2pd) runs inside the app process. It is linked into the Rust
`cdylib` of the Tauri 2 Android app as static libraries, and Rust calls it through
a small C ABI (`shim/i2pd_shim.h`). Only SAM v3 on `127.0.0.1` is enabled.

## Versions (pinned in `build.sh`)

| Component | Version | Source | Check |
|---|---|---|---|
| i2pd | 2.61.0 | github.com/PurpleI2P/i2pd tag `2.61.0` | sha256 pinned in the script (upstream publishes no source checksum) |
| OpenSSL | 3.5.9 (LTS, has ML-KEM) | github.com/openssl/openssl release `openssl-3.5.9` | upstream `.sha256` |
| Boost | 1.92.0 (CMake source archive) | github.com/boostorg/boost release `boost-1.92.0` | upstream `.txt` sha256 |
| Android NDK | r28c | dl.google.com | sha1 from Google's `repository2-3.xml` |
| CMake (build tool only) | 3.31.12 | github.com/Kitware/CMake | upstream `SHA-256.txt` |

Target: `minSdk 24`, ABIs `arm64-v8a` (phones) and `x86_64` (emulator), STL `c++_static`,
everything compiled with `-fPIC`. i2pd is built with `WITH_UPNP=OFF` (no miniupnpc).

## Build

Inside WSL (Ubuntu, x86_64). Needs `curl`, `bsdtar`, `tar`, `xz`, `make`, `perl`,
a host `gcc`. No root, no system packages, no environment variables to set.

```bash
bash /mnt/c/Users/samus/Documents/PROGRAMMI/SynthOrg/android/native/i2pd/build.sh            # both ABIs
bash .../build.sh x86_64                                                                        # one ABI
```

Downloads, NDK, CMake, sources and build trees go to `~/.cache/synthorg-i2pd-android`
(override with `CACHE=...`). Re-running skips what is already built; delete
`~/.cache/synthorg-i2pd-android/build/<abi>` (and `prefix/<abi>`) to force a rebuild.
Full build of both ABIs on 4 cores: see "Numbers" below.

## Output (`out/`)

```
out/
  arm64-v8a/lib/*.a        static libraries (list below)
  x86_64/lib/*.a
  <abi>/test/              link smoke test, stripped: smoke (executable), libsmoke.so (shared lib)
  include/i2pd_shim.h      the only header Rust needs
  include/i2pd/...         i2pd headers (libi2pd, libi2pd_client, i18n, daemon/Daemon.h), reference only
  certificates/reseed/*.crt, certificates/family/*.crt   to copy into the datadir
  licenses/                i2pd, OpenSSL, Boost license texts
  VERSIONS.txt
```

Libraries per ABI:

| File | What |
|---|---|
| `libi2pd_shim.a` | SynthOrg C ABI (`shim/i2pd_shim.cpp`) |
| `libi2pddaemon.a` | i2pd `daemon/` sources (Daemon, HTTPServer, I2PControl, UPnP stub) compiled with `-DANDROID`, i.e. `DaemonAndroid` as in i2pd-android |
| `libi2pdclient.a` | i2pd `libi2pd_client` (SAM, client context, ...) |
| `libi2pd.a` | i2pd core router |
| `libi2pdlang.a` | i2pd translations (`i18n`) |
| `libboost_program_options.a`, `libboost_filesystem.a`, `libboost_atomic.a` | Boost |
| `libssl.a`, `libcrypto.a` | OpenSSL |

## Linking from Rust (`build.rs`)

Order matters (each library only resolves symbols of those before it):

```
i2pd_shim  i2pddaemon  i2pdclient  i2pd  i2pdlang
boost_program_options  boost_filesystem  boost_atomic
ssl  crypto
c++_static  c++abi          (from the NDK sysroot, see below)
z  log  dl  m               (Android system libraries, dynamic)
```

```rust
// build.rs (sketch)
let abi = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
    "aarch64" => "arm64-v8a", "x86_64" => "x86_64", a => panic!("unsupported arch {a}"),
};
let dir = format!("{}/../native/i2pd/out/{abi}/lib", env!("CARGO_MANIFEST_DIR")); // adjust path
println!("cargo:rustc-link-search=native={dir}");
for l in ["i2pd_shim", "i2pddaemon", "i2pdclient", "i2pd", "i2pdlang",
          "boost_program_options", "boost_filesystem", "boost_atomic", "ssl", "crypto"] {
    println!("cargo:rustc-link-lib=static={l}");
}
// libc++ as static: the NDK linker driver (clang, C mode) does not add it by itself
println!("cargo:rustc-link-lib=static=c++_static");
println!("cargo:rustc-link-lib=static=c++abi");
for l in ["z", "log", "dl", "m"] { println!("cargo:rustc-link-lib=dylib={l}"); }
println!("cargo:rerun-if-changed={dir}");
```

`libc++_static.a` / `libc++abi.a` are found automatically by the NDK clang driver in
`<ndk>/toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/<triple>/`; if the linker does not find
them, add that directory with `rustc-link-search`. Only one copy of libc++ may exist in the
app: if another native library in the APK also uses the C++ STL, it must be the same
`c++_static` inside this `.so`, or all must switch to `c++_shared`.

16 KB pages: NDK r28+ links shared libraries with 16 KB alignment by default; the smoke
test also passes `-Wl,-z,max-page-size=16384` explicitly. The Rust `.so` must be linked by
an NDK r28+ clang (or get that flag through `cargo:rustc-link-arg`).

## Runtime: datadir and certificates

i2pd verifies reseed files (`.su3`) with the certificates in `<datadir>/certificates/reseed`
(and router families with `certificates/family`). They are not compiled in: the app must ship
`out/certificates/` (e.g. as APK assets) and copy it to `<datadir>/certificates/` before the
first `synthorg_i2pd_start` (and again after an app update, to pick up new certificates).
The shim refuses to start (`-3`) if `<datadir>/certificates/reseed/*.crt` is missing.
`datadir` should be app-private storage, e.g. `Context.getFilesDir() + "/i2pd"`.

## C ABI (`shim/i2pd_shim.h`)

| Function | |
|---|---|
| `int synthorg_i2pd_start(const char* datadir)` | starts the router, SAM on 127.0.0.1:7656; 0 = ok |
| `int synthorg_i2pd_start_with_port(const char* datadir, int sam_port)` | same, explicit SAM port |
| `void synthorg_i2pd_stop(void)` | stops it (blocking) |
| `int synthorg_i2pd_sam_port(void)` | SAM port while running, else 0 |
| `void synthorg_i2pd_network_changed(int online)` | from Android connectivity callbacks (`transports.SetOnline`) |
| `int synthorg_i2pd_is_running(void)` | 1/0 |
| `const char* synthorg_i2pd_last_error(void)` | message of the last failed start |

Return codes: `0` ok, `1` already running, `-1` bad arguments, `-2` datadir problem, `-3`
certificates missing, `-4` init failed, `-5` transports could not bind, `-6` fatal error from
i2pd (e.g. SAM port busy), `-7` exception.

Options given to i2pd (equivalent command line):

```
--datadir=<datadir> --log=file --logfile=<datadir>/i2pd.log --loglevel=warn
--sam.enabled=true --sam.address=127.0.0.1 --sam.port=7656
--http.enabled=false --httpproxy.enabled=false --socksproxy.enabled=false
--bob.enabled=false --i2cp.enabled=false --i2pcontrol.enabled=false --upnp.enabled=false
--reseed.verify=true
```

An `i2pd.conf` in the datadir, if present, is also read (command line wins).
i2pd parses its options once per process: after `stop`, `start` works again but must use
the same datadir and port (otherwise `-2`/`-1`).

## Licenses

- i2pd: BSD 3-Clause (`out/licenses/i2pd-LICENSE.txt`)
- OpenSSL 3.x: Apache License 2.0 (`out/licenses/openssl-LICENSE.txt`)
- Boost: Boost Software License 1.0 (`out/licenses/boost-LICENSE_1_0.txt`)
- NDK libc++ (linked statically): Apache 2.0 with LLVM exception
- shim: part of SynthOrg

BSD-3 and Apache-2.0 require the license texts (and the copyright notices) in the
distributed app, e.g. in an "open source licenses" screen; BSL-1.0 does not require it for
binaries. Apache-2.0 has no NOTICE file for OpenSSL 3.5.

## Numbers

Measured 2026-09-29 (WSL Ubuntu 26.04, 4 cores, 7 GB RAM):

- Time: about 2 min of downloads (NDK 689 MB) + 7 min to build both ABIs; a re-run with
  everything cached takes about 20 s (shim, collect, link tests). Cache: 6.0 GB.
- `.a` sizes in `out/` (debug info stripped with `llvm-strip --strip-debug`; with debug info
  they are 276 MB / 245 MB):

| Library | arm64-v8a | x86_64 |
|---|---:|---:|
| libi2pd_shim.a | 169 KB | 164 KB |
| libi2pddaemon.a | 3.9 MB | 3.7 MB |
| libi2pdclient.a | 12.7 MB | 11.8 MB |
| libi2pd.a | 16.2 MB | 15.1 MB |
| libi2pdlang.a | 1.7 MB | 1.6 MB |
| libboost_program_options.a | 1.2 MB | 1.1 MB |
| libboost_filesystem.a | 391 KB | 370 KB |
| libboost_atomic.a | 21 KB | 22 KB |
| libssl.a | 2.1 MB | 2.1 MB |
| libcrypto.a | 11.5 MB | 11.6 MB |
| **total** | **49.9 MB** | **47.7 MB** |

- Linked (with `--gc-sections`, libc++ static), stripped:
  test executable 11.3 MB (arm64) / 11.8 MB (x86_64);
  test shared library 14.2 MB (arm64) / 14.8 MB (x86_64). This is roughly what the router adds
  to the Rust `.so` (less once `--gc-sections` drops unused exports).
- `LOAD` segments of the test `.so`: alignment `0x4000` (16 KB) on both ABIs.

Run on the x86_64 emulator (API 37 system image with 16 KB pages; `smoke <datadir> 90` with `out/certificates` copied into the datadir): `synthorg_i2pd_start` returned 0,
SAM answered `HELLO REPLY RESULT=OK VERSION=3.3` on 127.0.0.1:7656, reseed succeeded with
signature verification (first server returned 403, next one worked), stop returned cleanly.
