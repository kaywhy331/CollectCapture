package com.localclear.sellerhub

import android.content.Context
import org.json.JSONObject

data class SyncResult(
    val received: Int,
    val completed: Int,
    val needsAction: Int,
    val lastState: String,
)

class CommandExecutor(context: Context) {
    private val keyStore = DeviceKeyStore()
    private val replayStore = CommandReplayStore(context)
    private val verifier = CommandVerifier(replayStore)
    private val api = SellerHubApi(context, keyStore)
    private val mediaCache = MediaCache(context)

    fun sync(session: DeviceSession): SyncResult {
        mediaCache.purgeExpired(BuildConfig.TEMP_MEDIA_RETENTION_MINUTES)
        api.checkIn(session)
        val envelopes = api.commands(session)
        var completed = 0
        var needsAction = 0
        var lastState = "idle"
        for (index in 0 until envelopes.length()) {
            val command = verifier.verify(envelopes.getJSONObject(index), session)
            val platform = command.payload.getString("platform")
            val version = command.payload.getString("connectorVersion")
            val platformAppVersion = command.payload.getString("platformAppVersion")
            if (
                platform != SANDBOX_PLATFORM ||
                version != SANDBOX_VERSION ||
                platformAppVersion != SANDBOX_APP_VERSION
            ) {
                val response = api.sendReceipt(
                    session,
                    command,
                    sequence = 1,
                    event = JSONObject()
                        .put("type", "pause")
                        .put("state", "NEEDS_USER_CONFIRMATION")
                        .put("reasonCode", "CONNECTOR_NOT_INSTALLED")
                        .put("detail", "No reviewed connector module matches this platform/version"),
                )
                lastState = response.getJSONObject("job").getString("currentState")
                replayStore.complete(command.jobId, command.nonce)
                needsAction += 1
                continue
            }
            lastState = executeSandbox(session, command)
            replayStore.complete(command.jobId, command.nonce)
            if (lastState == "PUBLISHED") completed += 1 else needsAction += 1
        }
        return SyncResult(envelopes.length(), completed, needsAction, lastState)
    }

    fun clearLocalData() {
        replayStore.clear()
        mediaCache.clearAll()
    }

    private fun executeSandbox(
        session: DeviceSession,
        command: VerifiedCommand,
    ): String {
        val action = command.payload.getString("action")
        var cached = false
        try {
            if (action == "publish") {
                mediaCache.materialize(
                    command.jobId,
                    command.payload.getJSONObject("parameters").getJSONArray("media"),
                )
                cached = true
            }
            val result = if (action == "publish") {
                val parameters = command.payload.getJSONObject("parameters")
                JSONObject()
                    .put("externalListingId", "sandbox-${command.jobId}")
                    .put(
                        "externalUrl",
                        "https://sandbox-seller-hub.invalid/listing/${command.jobId}",
                    )
                    .put("platformTitle", parameters.getString("title"))
                    .put(
                        "platformPrice",
                        JSONObject()
                            .put("amountCents", parameters.getInt("priceCents"))
                            .put("currency", parameters.getString("currency")),
                    )
            } else {
                null
            }
            var state = "QUEUED"
            for (sequence in 1..16) {
                val response = api.sendReceipt(
                    session,
                    command,
                    sequence,
                    event = JSONObject().put("type", "advance"),
                    result = result,
                )
                state = response.getJSONObject("job").getString("currentState")
                if (
                    state == "PUBLISHED" ||
                    state == "FAILED_FINAL" ||
                    state == "CANCELLED" ||
                    state.startsWith("NEEDS_")
                ) {
                    return state
                }
            }
            error("Seller Hub command exceeded the bounded transition count")
        } finally {
            if (cached) mediaCache.clear(command.jobId)
        }
    }

    private companion object {
        const val SANDBOX_PLATFORM = "Sandbox Seller Hub"
        const val SANDBOX_VERSION = "1.0.0"
        const val SANDBOX_APP_VERSION = "1.0.0"
    }
}
