package com.localclear.sellerhub

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class SellerHubApi(
    private val context: Context,
    private val keyStore: DeviceKeyStore,
) {
    fun checkIn(session: DeviceSession): JSONObject {
        val battery = context.getSystemService(BatteryManager::class.java)
        val status = JSONObject()
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("androidVersion", PairingClient.androidMajorVersion())
            .put(
                "batteryPercent",
                battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                    ?.takeIf { it in 0..100 } ?: JSONObject.NULL,
            )
            .put("isCharging", JSONObject.NULL)
            .put("networkType", networkType())
            .put("capabilities", JSONArray(listOf("signed_commands", "sandbox_connector_v1")))
            .put(
                "platformConnections",
                JSONArray().put(
                    JSONObject()
                        .put("platform", "Sandbox Seller Hub")
                        .put("appVersion", "1.0.0")
                        .put("displayAlias", "Local deterministic sandbox")
                        .put("connectionStatus", "connected")
                        .put(
                            "supportedCapabilities",
                            JSONArray(listOf("publish", "edit", "delist", "mark_sold")),
                        ),
                ),
            )
        return PairingClient.requestJson(
            method = "POST",
            url = "${session.apiBaseUrl}/v1/device/check-in",
            body = status,
            deviceToken = session.deviceToken,
        )
    }

    fun commands(session: DeviceSession): JSONArray = PairingClient.requestJson(
        method = "GET",
        url = "${session.apiBaseUrl}/v1/device/commands",
        deviceToken = session.deviceToken,
    ).getJSONArray("commands")

    fun sendReceipt(
        session: DeviceSession,
        command: VerifiedCommand,
        sequence: Int,
        event: JSONObject,
        result: JSONObject? = null,
    ): JSONObject {
        val payload = JSONObject()
            .put("version", 1)
            .put("deviceId", session.deviceId)
            .put("householdId", session.householdId)
            .put("jobId", command.jobId)
            .put("commandNonce", command.nonce)
            .put(
                "receiptNonce",
                "receipt_${UUID.randomUUID().toString().replace("-", "")}",
            )
            .put("sequence", sequence)
            .put("occurredAt", java.time.Instant.now().toString())
            .put("event", event)
        if (result != null) payload.put("result", result)
        val envelope = JSONObject()
            .put("payload", payload)
            .put(
                "signature",
                keyStore.sign(CanonicalJson.encode(payload).toByteArray(Charsets.UTF_8)),
            )
        return PairingClient.requestJson(
            method = "POST",
            url = "${session.apiBaseUrl}/v1/device/jobs/${command.jobId}/receipts",
            body = envelope,
            deviceToken = session.deviceToken,
        )
    }

    private fun networkType(): String {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "offline"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "unknown"
        }
    }
}
