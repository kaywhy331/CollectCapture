package com.localclear.sellerhub

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Duration
import java.time.Instant

data class VerifiedCommand(
    val envelope: JSONObject,
    val payload: JSONObject,
    val jobId: String,
    val nonce: String,
)

class CommandReplayStore(context: Context) {
    private val preferences = context.getSharedPreferences(
        "localclear_command_replay_v1",
        Context.MODE_PRIVATE,
    )

    fun accept(jobId: String, nonce: String): Boolean {
        if (preferences.getBoolean("complete:$nonce", false)) return false
        val inFlight = preferences.getString("inflight:$jobId", null)
        if (inFlight == nonce) return true
        preferences.edit().putString("inflight:$jobId", nonce).apply()
        return true
    }

    fun complete(jobId: String, nonce: String) {
        preferences.edit()
            .remove("inflight:$jobId")
            .putBoolean("complete:$nonce", true)
            .apply()
    }

    fun clear() = preferences.edit().clear().apply()
}

class CommandVerifier(private val replayStore: CommandReplayStore) {
    fun verify(envelope: JSONObject, session: DeviceSession): VerifiedCommand {
        require(BuildConfig.COMMAND_PUBLIC_KEY_BASE64.isNotBlank()) {
            "Trusted command key is not configured"
        }
        require(envelope.getString("keyId") == BuildConfig.COMMAND_KEY_ID) {
            "Command signing key is not trusted"
        }
        val payload = envelope.getJSONObject("payload")
        require(payload.getInt("version") == 1) { "Unsupported command version" }
        require(payload.getString("deviceId") == session.deviceId) {
            "Command targets another device"
        }
        require(payload.getString("householdId") == session.householdId) {
            "Command targets another household"
        }
        val action = payload.getString("action")
        require(action in ALLOWED_ACTIONS) { "Command action is not allowed" }
        val issuedAt = Instant.parse(payload.getString("issuedAt"))
        val expiresAt = Instant.parse(payload.getString("expiresAt"))
        val now = Instant.now()
        require(!issuedAt.isAfter(now.plusSeconds(30))) { "Command is not yet valid" }
        require(expiresAt.isAfter(now)) { "Command has expired" }
        require(Duration.between(issuedAt, expiresAt) <= Duration.ofMinutes(15)) {
            "Command lifetime is too long"
        }

        val keyBytes = Base64.decode(BuildConfig.COMMAND_PUBLIC_KEY_BASE64, Base64.DEFAULT)
        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(keyBytes))
        val valid = Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey)
            update(CanonicalJson.encode(payload).toByteArray(Charsets.UTF_8))
            verify(PairingClient.decodeUrl(envelope.getString("signature")))
        }
        require(valid) { "Command signature is invalid" }
        val jobId = payload.getString("jobId")
        val nonce = payload.getString("nonce")
        require(replayStore.accept(jobId, nonce)) { "Command was already completed" }
        return VerifiedCommand(envelope, payload, jobId, nonce)
    }

    private companion object {
        val ALLOWED_ACTIONS = setOf(
            "publish",
            "update_fields",
            "mark_sold",
            "delist",
            "check_connection",
            "pause",
            "resume",
        )
    }
}
