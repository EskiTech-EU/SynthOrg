package org.synthorg.phone

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * What ties the pairing to this phone.
 *
 * The keys of the pairing (who this phone is, for the computer) are kept in
 * the app's own folder, sealed with a key that lives in the Android Keystore:
 * made there, used there, never given out. A copy of the app's files taken to
 * another phone, or read off the storage, holds a pairing that cannot be
 * opened: that phone is not this one.
 *
 * Called from the app's native side (src-tauri/src/vault.rs).
 */
object Vault {
  private const val STORE = "AndroidKeyStore"
  private const val ALIAS = "synthorg-pairing"
  private const val CIPHER = "AES/GCM/NoPadding"
  private const val IV = 12

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(STORE).apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  /** Sealed: the nonce the Keystore chose, then the sealed bytes. */
  @JvmStatic
  fun seal(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    return cipher.iv + cipher.doFinal(plain)
  }

  /** Opened; throws when it was sealed by another phone's key, or changed. */
  @JvmStatic
  fun open(sealed: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(CIPHER)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV))
    return cipher.doFinal(sealed, IV, sealed.size - IV)
  }
}
