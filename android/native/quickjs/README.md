# QuickJS for the phone's archive

The phone keeps the archive whole and runs the same rules as the computer on
it: the JavaScript files of `computer/server` (database.js, personal.js,
memory-tree.js, usage.js, replica.js, archive-api.js), as they are. They run
in QuickJS, inside the app's process (`src-tauri/src/archive.rs`), on the
app's own SQLite.

## What is here

`rquickjs-sys` is the crate `rquickjs-sys` 0.14.0 from crates.io (MIT,
github.com/DelSkayn/rquickjs), unchanged but for two files added:

- `src/bindings/aarch64-linux-android.rs`
- `src/bindings/x86_64-linux-android.rs`

The crate ships the bindings to the C interface of QuickJS for a list of
targets that does not include Android, and makes them with `bindgen`
otherwise, which needs a `libclang` the Android NDK for Windows does not
have. The two files are copies of the crate's own
`aarch64-unknown-linux-gnu.rs` and `x86_64-unknown-linux-gnu.rs`: the C
types of the interface have the same size and layout on Android (LP64, same
architectures), and the two Linux files are equal to each other already.

`src-tauri/Cargo.toml` points the dependency to this folder (`[patch.crates-io]`).

## Updating

Copy the new version of the crate from the cargo registry over this folder,
then copy the two Linux bindings to the two Android names again.
