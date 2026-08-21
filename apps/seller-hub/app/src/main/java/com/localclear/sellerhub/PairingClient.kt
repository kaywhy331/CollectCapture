package com.localclear.sellerhub

import android.os.Build
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class PairingResult(val session: DeviceSession, val displayName: String)

class PairingClient(private val keyStore: DeviceKeyStore) {
    fun complete(scannedValue: String): PairingResult {
        val qr = JSONObject(scannedValue)
        require(qr.getInt("version") == 1) { "Unsupported pairing QR version" }
        val challengeId = qr.getString("challengeId")
        val householdId = qr.getString("householdId")
        val apiBaseUrl = qr.getString("apiBaseUrl").trimEnd('/')
        val secret = qr.getString("secret")
        require(java.time.Instant.parse(qr.getString("expiresAt")).isAfter(java.time.Instant.now())) {
            "Pairing QR has expired"
        }
        val uri = URI(apiBaseUrl)
        require(uri.scheme == "https" || (BuildConfig.DEBUG && uri.host in LOCAL_HOSTS)) {
            "Seller Hub requires HTTPS"
        }

        val displayName = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(120)
        val device = JSONObject()
            .put("displayName", displayName)
            .put("publicKey", keyStore.publicKeyPem())
            .put("androidVersion", androidMajorVersion())
            .put("appVersion", BuildConfig.VERSION_NAME)
        val binding = JSONObject()
            .put("challengeId", challengeId)
            .put("householdId", householdId)
            .put("device", device)
        val canonicalBinding = CanonicalJson.encode(binding).toByteArray(Charsets.UTF_8)
        val hmac = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(decodeUrl(secret), "HmacSHA256"))
        }
        val response = JSONObject()
            .put("secret", secret)
            .put(
                "response",
                JSONObject()
                    .put("challengeId", challengeId)
                    .put("householdId", householdId)
                    .put("device", device)
                    .put("proof", encodeUrl(hmac.doFinal(canonicalBinding)))
                    .put("keyProof", keyStore.sign(canonicalBinding)),
            )

        val result = requestJson(
            method = "POST",
            url = "$apiBaseUrl/v1/seller-devices/pairing/complete",
            body = response,
        )
        val pairedDevice = result.getJSONObject("device")
        return PairingResult(
            session = DeviceSession(
                deviceId = pairedDevice.getString("id"),
                householdId = pairedDevice.getString("householdId"),
                apiBaseUrl = apiBaseUrl,
                deviceToken = result.getString("deviceToken"),
            ),
            displayName = pairedDevice.getString("displayName"),
        )
    }

    companion object {
        val LOCAL_HOSTS = setOf("127.0.0.1", "10.0.2.2", "localhost")

        fun requestJson(
            method: String,
            url: String,
            body: JSONObject? = null,
            deviceToken: String? = null,
        ): JSONObject {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = method
                connection.connectTimeout = 10_000
                connection.readTimeout = 20_000
                connection.setRequestProperty("Accept", "application/json")
                if (deviceToken != null) {
                    connection.setRequestProperty("Authorization", "Device $deviceToken")
                }
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { output ->
                        output.write(body.toString().toByteArray(Charsets.UTF_8))
                    }
                }
                val stream = if (connection.responseCode in 200..299) {
                    connection.inputStream
                } else {
                    connection.errorStream
                }
                val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = if (text.isBlank()) JSONObject() else JSONObject(text)
                if (connection.responseCode !in 200..299) {
                    error(json.optString("message", "Request failed (${connection.responseCode})"))
                }
                return json
            } finally {
                connection.disconnect()
            }
        }

        fun encodeUrl(value: ByteArray): String = Base64.encodeToString(
            value,
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )

        fun decodeUrl(value: String): ByteArray = Base64.decode(
            value,
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )

        fun androidMajorVersion(): Int = Build.VERSION.RELEASE
            .substringBefore('.')
            .toIntOrNull()
            ?.coerceAtLeast(11)
            ?: 11
    }
}
