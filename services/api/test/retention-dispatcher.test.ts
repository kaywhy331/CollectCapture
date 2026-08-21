import {
  DiagnosticArtifactSchema,
  SupportAccessGrantSchema,
} from "@localclear/domain";
import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/memory-repository.js";
import { RetentionDispatcher } from "../src/retention-dispatcher.js";

describe("retention dispatcher", () => {
  it("deletes expired diagnostics from storage before purging ephemeral rows", async () => {
    const repository = new MemoryRepository();
    const expiredGrant = SupportAccessGrantSchema.parse({
      id: "expired-grant",
      householdId: "household-1",
      grantedBy: "user-1",
      supportActorId: "operator-1",
      reasonCode: "publishing_failure_review",
      scope: ["diagnostic_artifacts"],
      diagnosticConsent: true,
      expiresAt: "2026-08-20T11:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-08-20T10:30:00.000Z",
    });
    const activeGrant = SupportAccessGrantSchema.parse({
      ...expiredGrant,
      id: "active-grant",
      expiresAt: "2026-08-20T13:00:00.000Z",
    });
    await repository.createSupportGrant(expiredGrant);
    await repository.createSupportGrant(activeGrant);
    const artifact = (id: string, grantId: string) =>
      DiagnosticArtifactSchema.parse({
        id,
        householdId: "household-1",
        grantId,
        submittedBy: "user-1",
        kind: "publishing_screen",
        storagePath: `household-1/diagnostics/${id}.jpg`,
        contentSha256: "a".repeat(64),
        redacted: true,
        privacyScanPassed: true,
        consentedAt: "2026-08-20T10:45:00.000Z",
        createdAt: "2026-08-20T10:45:00.000Z",
      });
    await repository.createDiagnosticArtifact(
      artifact("expired-artifact", expiredGrant.id),
    );
    await repository.createDiagnosticArtifact(
      artifact("active-artifact", activeGrant.id),
    );
    await repository.upsertListingExportArtifact({
      id: "export-1",
      householdId: "household-1",
      itemId: "item-1",
      publishingJobId: "job-1",
      platform: "Import",
      format: "json",
      payload: {},
      createdAt: "2026-08-19T10:00:00.000Z",
      expiresAt: "2026-08-20T10:00:00.000Z",
      consumedAt: null,
    });
    await repository.createPairingChallenge({
      id: "pairing-1",
      householdId: "household-1",
      secretHash: "a".repeat(64),
      expiresAt: "2026-08-20T10:00:00.000Z",
      consumedAt: null,
    });
    expect(
      await repository.consumeDeviceNonce(
        "device-1",
        "nonce-1",
        "2026-08-20T10:00:00.000Z",
        "2026-08-20T09:00:00.000Z",
      ),
    ).toBe(true);
    const deletedPaths: string[] = [];
    const dispatcher = new RetentionDispatcher({
      repository,
      mediaLifecycleProvider: {
        async deleteObjects(paths) {
          deletedPaths.push(...paths);
        },
      },
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });

    expect(await dispatcher.runOnce()).toEqual({
      diagnosticArtifacts: 1,
      listingExportArtifacts: 1,
      issuedDeviceCommands: 0,
      pairingChallenges: 1,
      deviceNonces: 1,
    });
    expect(deletedPaths).toEqual([
      "household-1/diagnostics/expired-artifact.jpg",
    ]);
    expect(await repository.listDiagnosticArtifacts(expiredGrant.id)).toEqual(
      [],
    );
    expect(
      await repository.listDiagnosticArtifacts(activeGrant.id),
    ).toHaveLength(1);
    expect(
      await repository.getListingExportArtifact("household-1", "job-1"),
    ).toBeNull();
  });
});
