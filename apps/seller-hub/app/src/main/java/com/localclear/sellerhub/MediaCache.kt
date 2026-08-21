package com.localclear.sellerhub

import android.content.Context
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest

class MediaCache(private val context: Context) {
    fun materialize(jobId: String, media: JSONArray): List<File> {
        require(media.length() in 1..12) { "A publish command needs 1–12 images" }
        val directory = File(context.cacheDir, "localclear-command/$jobId")
        directory.deleteRecursively()
        require(directory.mkdirs()) { "Could not create temporary media directory" }
        return try {
            (0 until media.length()).map { index ->
                val asset = media.getJSONObject(index)
                val downloadUrl = asset.getString("downloadUrl")
                val uri = URI(downloadUrl)
                require(uri.scheme == "https" || (BuildConfig.DEBUG && uri.host in PairingClient.LOCAL_HOSTS)) {
                    "Media download requires HTTPS"
                }
                require(java.time.Instant.parse(asset.getString("expiresAt")).isAfter(java.time.Instant.now())) {
                    "Media URL has expired"
                }
                val target = File(directory, "${asset.getInt("order")}-${asset.getString("assetId")}.image")
                download(downloadUrl, target)
                val digest = MessageDigest.getInstance("SHA-256")
                    .digest(target.readBytes())
                    .joinToString("") { byte -> "%02x".format(byte) }
                require(digest == asset.getString("sha256")) { "Media hash mismatch" }
                target
            }
        } catch (error: Throwable) {
            directory.deleteRecursively()
            throw error
        }
    }

    fun clear(jobId: String) {
        File(context.cacheDir, "localclear-command/$jobId").deleteRecursively()
    }

    fun purgeExpired(retentionMinutes: Int) {
        require(retentionMinutes in 0..1_440) { "Media retention must be 0–1440 minutes" }
        val root = File(context.cacheDir, "localclear-command")
        val cutoff = System.currentTimeMillis() - retentionMinutes * 60_000L
        root.listFiles()?.forEach { directory ->
            if (directory.lastModified() <= cutoff) directory.deleteRecursively()
        }
    }

    fun clearAll() {
        File(context.cacheDir, "localclear-command").deleteRecursively()
    }

    private fun download(downloadUrl: String, target: File) {
        val connection = URL(downloadUrl).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            require(connection.responseCode in 200..299) { "Media download failed" }
            val declaredLength = connection.contentLengthLong
            require(declaredLength in -1L..MAX_ASSET_BYTES) { "Media asset is too large" }
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= MAX_ASSET_BYTES) { "Media asset is too large" }
                        output.write(buffer, 0, count)
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val MAX_ASSET_BYTES = 20L * 1024 * 1024
    }
}
