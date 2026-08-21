package com.localclear.sellerhub

import org.json.JSONArray
import org.json.JSONObject

object CanonicalJson {
    fun encode(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(
            prefix = "{",
            postfix = "}",
            separator = ",",
        ) { key -> "${JSONObject.quote(key)}:${encode(value.get(key))}" }
        is JSONArray -> (0 until value.length()).joinToString(
            prefix = "[",
            postfix = "]",
            separator = ",",
        ) { index -> encode(value.get(index)) }
        is String -> JSONObject.quote(value)
        is Boolean -> value.toString()
        is Number -> {
            require(value.toDouble().isFinite()) { "JSON numbers must be finite" }
            value.toString()
        }
        else -> error("Unsupported canonical JSON value: ${value::class.java.name}")
    }
}
