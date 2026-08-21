package com.localclear.sellerhub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DeterministicSelectorTest {
    private val resolver = DeterministicSelectorResolver()
    private val screen = ScreenSnapshot(
        packageName = "com.marketplace.official",
        fingerprint = "reviewed-screen-v3",
        nodes = listOf(
            ScreenNode("com.marketplace:id/title", "Listing title", "Title", 100, 200),
        ),
    )

    @Test
    fun `prefers resource id over weaker selectors`() {
        val target = resolver.resolve(
            step(
                SelectorCandidate(SelectorKind.TEXT, "Title"),
                SelectorCandidate(SelectorKind.RESOURCE_ID, "com.marketplace:id/title"),
            ),
            screen,
        )
        assertEquals(SelectorKind.RESOURCE_ID, target.strategy)
    }

    @Test
    fun `allows reviewed coordinate only on exact screen fingerprint`() {
        val coordinate = SelectorCandidate(
            SelectorKind.COORDINATE,
            "reviewed fallback",
            x = 50,
            y = 75,
        )
        assertEquals(
            SelectorKind.COORDINATE,
            resolver.resolve(
                step(coordinate, coordinateReviewed = true),
                screen.copy(nodes = emptyList()),
            ).strategy,
        )
        assertThrows(UnexpectedScreenException::class.java) {
            resolver.resolve(
                step(coordinate, coordinateReviewed = true),
                screen.copy(fingerprint = "changed-screen", nodes = emptyList()),
            )
        }
    }

    @Test
    fun `rejects wrong package and ambiguous semantics`() {
        assertThrows(UnexpectedScreenException::class.java) {
            resolver.resolve(step(), screen.copy(packageName = "untrusted.app"))
        }
        assertThrows(UnexpectedScreenException::class.java) {
            resolver.resolve(
                step(SelectorCandidate(SelectorKind.TEXT, "Title")),
                screen.copy(nodes = listOf(screen.nodes[0], screen.nodes[0])),
            )
        }
    }

    private fun step(
        vararg selectors: SelectorCandidate,
        coordinateReviewed: Boolean = false,
    ) = ReviewedUiStep(
        id = "listing-title",
        expectedPackage = "com.marketplace.official",
        expectedScreenFingerprint = "reviewed-screen-v3",
        selectors = selectors.toList(),
        coordinateFallbackReviewed = coordinateReviewed,
    )
}
