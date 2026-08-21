package com.localclear.sellerhub

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class DeviceKeyStore {
    private val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    fun keyPair(): KeyPair {
        val existingPrivate = keyStore.getKey(SIGNING_ALIAS, null)
        val existingPublic = keyStore.getCertificate(SIGNING_ALIAS)?.publicKey
        if (existingPrivate != null && existingPublic != null) {
            return KeyPair(existingPublic, existingPrivate as java.security.PrivateKey)
        }
        val generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            ANDROID_KEY_STORE,
        )
        generator.initialize(
            KeyGenParameterSpec.Builder(
                SIGNING_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKeyPair()
    }

    fun publicKeyPem(): String {
        val encoded = Base64.encodeToString(keyPair().public.encoded, Base64.NO_WRAP)
        return "-----BEGIN PUBLIC KEY-----\n${encoded.chunked(64).joinToString("\n")}\n-----END PUBLIC KEY-----"
    }

    fun sign(content: ByteArray): String {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(keyPair().private)
        signature.update(content)
        return Base64.encodeToString(
            signature.sign(),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
    }

    fun clear() {
        if (keyStore.containsAlias(SIGNING_ALIAS)) keyStore.deleteEntry(SIGNING_ALIAS)
    }

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val SIGNING_ALIAS = "localclear_seller_hub_device_signing_v1"
    }
}
