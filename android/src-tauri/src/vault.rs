//! What ties the pairing to this phone.
//!
//! The keys of the pairing are kept sealed with a key of the Android Keystore
//! (Vault.kt): made in the phone's secure hardware where it has one, never
//! given out. The app's files copied elsewhere hold a pairing that cannot be
//! opened.
//!
//! Sealed text starts with `v1:`; text without it is a pairing kept before
//! this was there, read as it is and sealed at the next write. Off Android
//! (the app run on a computer to try the interface) there is no Keystore: the
//! text is kept as it is.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

const MARK: &str = "v1:";

/// The text as it is kept.
pub fn seal(plain: &str) -> String {
    match imp::call("seal", plain.as_bytes()) {
        Ok(sealed) => format!("{MARK}{}", B64.encode(sealed)),
        // No Keystore to seal with: kept as it is, as before.
        Err(why) => {
            if cfg!(target_os = "android") {
                eprintln!("[vault] the pairing could not be sealed: {why}");
            }
            plain.to_string()
        }
    }
}

/// The text as it was given; `None` when it was sealed and cannot be opened here (another phone's, or changed).
pub fn open(kept: &str) -> Option<String> {
    let Some(sealed) = kept.strip_prefix(MARK) else { return Some(kept.to_string()) };
    let bytes = B64.decode(sealed).ok()?;
    String::from_utf8(imp::call("open", &bytes).ok()?).ok()
}

/// Whether the text is sealed already.
pub fn sealed(kept: &str) -> bool {
    kept.starts_with(MARK)
}

#[cfg(target_os = "android")]
mod imp {
    use jni::JavaVM;
    use jni::objects::{JByteArray, JClass, JObject, JValue};

    /// `Vault.seal` or `Vault.open`, on the bytes given.
    pub fn call(name: &str, input: &[u8]) -> Result<Vec<u8>, String> {
        let context = ndk_context::android_context();
        // The machine and the app's context are the ones the app was started with: they live as long as it does.
        let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let result = (|| -> jni::errors::Result<Vec<u8>> {
            let app = unsafe { JObject::from_raw(context.context().cast()) };
            // The app's own classes are found through its loader: a native thread sees only the system's.
            let loader = env.call_method(&app, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
            let class_name = env.new_string("org.synthorg.phone.Vault")?;
            let class = env.call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&class_name)])?.l()?;
            let class = JClass::from(class);
            let bytes = env.byte_array_from_slice(input)?;
            let out = env.call_static_method(&class, name, "([B)[B", &[JValue::Object(&bytes)])?.l()?;
            env.convert_byte_array(JByteArray::from(out))
        })();
        if result.is_err() && env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        result.map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    pub fn call(_name: &str, _input: &[u8]) -> Result<Vec<u8>, String> {
        Err("no keystore here".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_a_keystore_the_text_is_kept_as_it_is_and_a_sealed_one_is_not_opened() {
        assert_eq!(seal("{\"a\":1}"), "{\"a\":1}");
        assert_eq!(open("{\"a\":1}").as_deref(), Some("{\"a\":1}"));
        assert!(!sealed("{\"a\":1}"));
        assert!(sealed("v1:AAAA"));
        assert_eq!(open("v1:AAAA"), None);
    }
}
