package com.localclear.sellerhub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class DeviceSession(
    val deviceId: String,
    val householdId: String,
    val apiBaseUrl: String,
    val deviceToken: String,
)

class SessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    fun save(session: DeviceSession) {
        val plain = JSONObject()
            .put("deviceId", session.deviceId)
            .put("householdId", session.householdId)
            .put("apiBaseUrl", session.apiBaseUrl)
            .put("deviceToken", session.deviceToken)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val encrypted = cipher.doFinal(plain)
        val encoded = ByteArray(cipher.iv.size + encrypted.size)
        cipher.iv.copyInto(encoded)
        encrypted.copyInto(encoded, cipher.iv.size)
        preferences.edit().putString(
            SESSION,
            Base64.encodeToString(encoded, Base64.NO_WRAP),
        ).apply()
    }

    fun load(): DeviceSession? {
        val encoded = preferences.getString(SESSION, null) ?: return null
        return runCatching {
            val combined = Base64.decode(encoded, Base64.NO_WRAP)
            require(combined.size > IV_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                encryptionKey(),
                GCMParameterSpec(128, combined.copyOfRange(0, IV_BYTES)),
            )
            val json = JSONObject(
                String(cipher.doFinal(combined.copyOfRange(IV_BYTES, combined.size))),
            )
            DeviceSession(
                deviceId = json.getString("deviceId"),
                householdId = json.getString("householdId"),
                apiBaseUrl = json.getString("apiBaseUrl"),
                deviceToken = json.getString("deviceToken"),
            )
        }.getOrNull()
    }

    fun clear() {
        preferences.edit().clear().apply()
        if (keyStore.containsAlias(ENCRYPTION_ALIAS)) keyStore.deleteEntry(ENCRYPTION_ALIAS)
    }

    private fun encryptionKey(): SecretKey {
        val existing = keyStore.getKey(ENCRYPTION_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEY_STORE,
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                ENCRYPTION_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val PREFERENCES = "localclear_device_session"
        const val SESSION = "encrypted_session"
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val ENCRYPTION_ALIAS = "localclear_seller_hub_session_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
