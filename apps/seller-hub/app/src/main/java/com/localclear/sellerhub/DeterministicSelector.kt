package com.localclear.sellerhub

/**
 * Connector modules may resolve only predeclared targets. Resolution always
 * prefers stable semantic selectors and permits a coordinate only when the
 * reviewed screen fingerprint matches exactly.
 */
enum class SelectorKind(val priority: Int) {
    RESOURCE_ID(0),
    CONTENT_DESCRIPTION(1),
    TEXT(2),
    COORDINATE(3),
}

data class ScreenNode(
    val resourceId: String?,
    val contentDescription: String?,
    val text: String?,
    val centerX: Int,
    val centerY: Int,
)

data class ScreenSnapshot(
    val packageName: String,
    val fingerprint: String,
    val nodes: List<ScreenNode>,
)

data class SelectorCandidate(
    val kind: SelectorKind,
    val value: String,
    val x: Int? = null,
    val y: Int? = null,
)

data class ReviewedUiStep(
    val id: String,
    val expectedPackage: String,
    val expectedScreenFingerprint: String,
    val selectors: List<SelectorCandidate>,
    val coordinateFallbackReviewed: Boolean = false,
)

data class ResolvedUiTarget(
    val strategy: SelectorKind,
    val x: Int,
    val y: Int,
)

class UnexpectedScreenException(message: String) : SecurityException(message)

class DeterministicSelectorResolver {
    fun resolve(step: ReviewedUiStep, screen: ScreenSnapshot): ResolvedUiTarget {
        if (screen.packageName != step.expectedPackage) {
            throw UnexpectedScreenException("Unexpected marketplace package")
        }
        val candidates = step.selectors.sortedBy { it.kind.priority }
        for (candidate in candidates) {
            if (candidate.kind == SelectorKind.COORDINATE) continue
            val matches = screen.nodes.filter { node -> candidate.matches(node) }
            if (matches.size > 1) {
                throw UnexpectedScreenException(
                    "Selector ${candidate.kind} for ${step.id} was ambiguous",
                )
            }
            val match = matches.singleOrNull() ?: continue
            return ResolvedUiTarget(candidate.kind, match.centerX, match.centerY)
        }

        val coordinate = candidates.firstOrNull {
            it.kind == SelectorKind.COORDINATE
        }
        if (
            coordinate != null &&
            step.coordinateFallbackReviewed &&
            screen.fingerprint == step.expectedScreenFingerprint &&
            coordinate.x != null &&
            coordinate.y != null
        ) {
            return ResolvedUiTarget(
                SelectorKind.COORDINATE,
                coordinate.x,
                coordinate.y,
            )
        }
        throw UnexpectedScreenException(
            "Reviewed selectors did not match the expected screen",
        )
    }

    private fun SelectorCandidate.matches(node: ScreenNode): Boolean = when (kind) {
        SelectorKind.RESOURCE_ID -> node.resourceId == value
        SelectorKind.CONTENT_DESCRIPTION -> node.contentDescription == value
        SelectorKind.TEXT -> node.text == value
        SelectorKind.COORDINATE -> false
    }
}
