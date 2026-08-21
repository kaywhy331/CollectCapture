import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  InvalidItemTransitionError,
  InvalidPublishingTransitionError,
  type ConnectorEnvironment,
} from "@localclear/domain";
import {
  DeviceCommandVerificationError,
  verifyDeviceReceipt,
} from "@localclear/device-protocol";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { ZodError, z } from "zod";
import {
  LocalClearApplication,
  type ApplicationOptions,
} from "./application.js";
import {
  createAuthenticationHook,
  createDeviceAuthenticationHook,
  type AuthPrincipal,
  type TokenVerifier,
} from "./auth.js";
import {
  AdminConnectorUpdateRequestSchema,
  AdminFeatureFlagUpdateRequestSchema,
  BatchCaptureRequestSchema,
  BatchPublishRequestSchema,
  BuyerTaskActionRequestSchema,
  BuyerTaskDecisionRequestSchema,
  CapturedItemInputSchema,
  CloseItemRequestSchema,
  CompletePairingRequestSchema,
  CompleteImportRequestSchema,
  CreateProductionReleaseRequestSchema,
  CreateMeetupRequestSchema,
  CreateHouseholdRequestSchema,
  CreateDiagnosticArtifactRequestSchema,
  CreateSupportGrantRequestSchema,
  CreateListingRequestSchema,
  DeleteAccountRequestSchema,
  DeleteItemRequestSchema,
  DeviceCheckInRequestSchema,
  IngestBuyerMessageRequestSchema,
  ItemLifecycleActionRequestSchema,
  PriceRecommendationRequestSchema,
  PropagateListingRequestSchema,
  RegisterPushSubscriptionRequestSchema,
  ReplaceMediaAssetRequestSchema,
  ReviewMediaPrivacyRequestSchema,
  ReviewProductionReleaseRequestSchema,
  PublishRequestSchema,
  UserPublishingJobControlRequestSchema,
  UpdateBackupBuyerRequestSchema,
  UpdateHouseholdRequestSchema,
  UpdateMeetupRequestSchema,
} from "./contracts.js";
import { ApplicationError } from "./errors.js";
import { registerHttpObservability } from "./observability.js";
import type { Repository } from "./repository.js";

const HouseholdParamsSchema = z.object({
  householdId: z.string().trim().min(1),
});
const ItemParamsSchema = HouseholdParamsSchema.extend({
  itemId: z.string().trim().min(1),
});
const MediaParamsSchema = ItemParamsSchema.extend({
  mediaAssetId: z.string().trim().min(1),
});
const JobParamsSchema = HouseholdParamsSchema.extend({
  jobId: z.string().trim().min(1),
});
const DeviceParamsSchema = HouseholdParamsSchema.extend({
  deviceId: z.string().trim().min(1),
});
const BuyerTaskParamsSchema = HouseholdParamsSchema.extend({
  taskId: z.string().trim().min(1),
});
const MeetupParamsSchema = HouseholdParamsSchema.extend({
  meetupId: z.string().trim().min(1),
});
const BackupBuyerParamsSchema = ItemParamsSchema.extend({
  entryId: z.string().trim().min(1),
});
const DeviceJobParamsSchema = z.object({
  jobId: z.string().trim().min(1),
});
const AdminConnectorParamsSchema = z.object({
  connectorId: z.string().trim().min(1).max(128),
});
const AdminFeatureFlagParamsSchema = z.object({
  key: z.string().trim().min(1).max(80),
});
const ProductionReleaseParamsSchema = z.object({
  releaseId: z.string().trim().min(1).max(128),
});
const SupportGrantParamsSchema = HouseholdParamsSchema.extend({
  grantId: z.string().trim().min(1).max(128),
});
const AdminSupportGrantParamsSchema = z.object({
  grantId: z.string().trim().min(1).max(128),
});
const NotificationParamsSchema = HouseholdParamsSchema.extend({
  notificationId: z.string().trim().min(1).max(128),
});

export interface BuildAppOptions {
  repository: Repository;
  tokenVerifier: TokenVerifier;
  application?: LocalClearApplication;
  environment?: ConnectorEnvironment;
  allowedOrigins?: readonly string[];
  logger?: FastifyServerOptions["logger"];
  applicationOptions?: Omit<ApplicationOptions, "environment">;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: "x-request-id",
    trustProxy: false,
  });
  const application =
    options.application ??
    new LocalClearApplication(options.repository, {
      ...options.applicationOptions,
      environment: options.environment ?? "internal",
    });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  registerHttpObservability(app);

  await app.register(helmet, { global: true });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Origin is not allowed"), false);
      }
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      error: "rate_limited",
      message: "Too many requests. Please try again shortly.",
    }),
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "LocalClear API",
        version: "0.1.0",
        description:
          "Canonical inventory and policy-gated local publishing API",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({
        error: "invalid_request",
        message: "The request contains invalid fields",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof ApplicationError) {
      await reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    if (
      error instanceof InvalidPublishingTransitionError ||
      error instanceof InvalidItemTransitionError
    ) {
      await reply
        .code(409)
        .send({ error: "invalid_transition", message: error.message });
      return;
    }
    if (error instanceof DeviceCommandVerificationError) {
      await reply.code(401).send({
        error: "device_receipt_rejected",
        message: "The Seller Hub receipt is invalid, expired, or already used",
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      await reply.code(error.statusCode).send({
        error: "request_rejected",
        message:
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Request rejected",
      });
      return;
    }
    request.log.error({ err: error }, "Unhandled request error");
    await reply.code(500).send({
      error: "internal_error",
      message: "The request could not be completed",
    });
  });

  app.get("/health", async () => ({ status: "ok", service: "localclear-api" }));

  app.post(
    "/v1/seller-devices/pairing/complete",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = CompletePairingRequestSchema.parse(request.body);
      const result = await application.completeSellerHubPairing(input);
      return reply.code(201).send(result);
    },
  );

  await app.register(async (deviceRoutes) => {
    deviceRoutes.addHook(
      "preHandler",
      createDeviceAuthenticationHook(options.repository),
    );

    deviceRoutes.post("/v1/device/check-in", async (request) => {
      const input = DeviceCheckInRequestSchema.parse(request.body);
      return {
        device: await application.checkInSellerDevice(
          request.devicePrincipal,
          input,
        ),
      };
    });

    deviceRoutes.get("/v1/device/commands", async (request) =>
      application.listSellerDeviceCommands(request.devicePrincipal),
    );

    deviceRoutes.post("/v1/device/jobs/:jobId/receipts", async (request) => {
      const { jobId } = DeviceJobParamsSchema.parse(request.params);
      const now = options.applicationOptions?.now?.() ?? new Date();
      const receipt = await verifyDeviceReceipt(request.body, {
        publicKey: request.devicePrincipal.publicKey,
        expectedDeviceId: request.devicePrincipal.id,
        expectedHouseholdId: request.devicePrincipal.householdId,
        now,
        nonceStore: {
          consume: (deviceId, nonce, expiresAt) =>
            options.repository.consumeDeviceNonce(
              deviceId,
              nonce,
              expiresAt,
              now.toISOString(),
            ),
        },
      });
      if (receipt.jobId !== jobId) {
        throw new ApplicationError(
          409,
          "receipt_scope_mismatch",
          "The receipt does not match this job",
        );
      }
      if (
        !(await options.repository.isIssuedDeviceCommandActive(
          request.devicePrincipal.id,
          jobId,
          receipt.commandNonce,
          now.toISOString(),
        ))
      ) {
        throw new ApplicationError(
          409,
          "command_expired",
          "The referenced Seller Hub command is missing or expired",
        );
      }
      return application.transitionPublishingJobFromDevice(
        request.devicePrincipal,
        jobId,
        {
          event: receipt.event,
          ...(receipt.result ? { result: receipt.result } : {}),
        },
      );
    });
  });

  await app.register(async (protectedRoutes) => {
    protectedRoutes.addHook(
      "preHandler",
      createAuthenticationHook(options.tokenVerifier),
    );

    protectedRoutes.get("/v1/account/export", async (request, reply) => {
      const payload = await application.exportAccount(request.principal.userId);
      return reply
        .header(
          "content-disposition",
          `attachment; filename="localclear-export-${payload.generatedAt.slice(0, 10)}.json"`,
        )
        .send({ export: payload });
    });

    protectedRoutes.post("/v1/push-subscriptions", async (request, reply) => {
      const input = RegisterPushSubscriptionRequestSchema.parse(request.body);
      const result = await application.registerPushSubscription(
        request.principal.userId,
        input,
      );
      return reply.code(201).send(result);
    });

    protectedRoutes.delete("/v1/account", async (request) => {
      DeleteAccountRequestSchema.parse(request.body);
      return application.deleteAccount(request.principal.userId);
    });

    protectedRoutes.get("/v1/households", async (request) => ({
      households: await application.listHouseholds(request.principal.userId),
    }));

    protectedRoutes.get(
      "/v1/households/:householdId/notifications",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return application.listNotifications(
          request.principal.userId,
          householdId,
        );
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/notifications/:notificationId/read",
      async (request) => {
        const { householdId, notificationId } = NotificationParamsSchema.parse(
          request.params,
        );
        return application.markNotificationRead(
          request.principal.userId,
          householdId,
          notificationId,
        );
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/support-grants",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          grants: await application.listSupportGrants(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/support-grants",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const input = CreateSupportGrantRequestSchema.parse(request.body);
        const grant = await application.createSupportGrant(
          request.principal.userId,
          householdId,
          input,
        );
        return reply.code(201).send({ grant });
      },
    );

    protectedRoutes.delete(
      "/v1/households/:householdId/support-grants/:grantId",
      async (request) => {
        const { householdId, grantId } = SupportGrantParamsSchema.parse(
          request.params,
        );
        return {
          grant: await application.revokeSupportGrant(
            request.principal.userId,
            householdId,
            grantId,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/diagnostic-artifacts",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const input = CreateDiagnosticArtifactRequestSchema.parse(request.body);
        const artifact = await application.createDiagnosticArtifact(
          request.principal.userId,
          householdId,
          input,
        );
        return reply.code(201).send({ artifact });
      },
    );

    protectedRoutes.post("/v1/households", async (request, reply) => {
      const input = CreateHouseholdRequestSchema.parse(request.body);
      const household = await application.createHousehold(
        request.principal.userId,
        input,
      );
      return reply.code(201).send({ household });
    });

    protectedRoutes.get("/v1/households/:householdId", async (request) => {
      const { householdId } = HouseholdParamsSchema.parse(request.params);
      return {
        household: await application.getHousehold(
          request.principal.userId,
          householdId,
        ),
      };
    });

    protectedRoutes.get(
      "/v1/households/:householdId/progress",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return application.getHouseholdProgress(
          request.principal.userId,
          householdId,
        );
      },
    );

    protectedRoutes.patch("/v1/households/:householdId", async (request) => {
      const { householdId } = HouseholdParamsSchema.parse(request.params);
      const input = UpdateHouseholdRequestSchema.parse(request.body);
      return {
        household: await application.updateHousehold(
          request.principal.userId,
          householdId,
          input,
        ),
      };
    });

    protectedRoutes.post(
      "/v1/households/:householdId/seller-devices/pairing",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const qr = await application.beginSellerHubPairing(
          request.principal.userId,
          householdId,
        );
        return reply.code(201).send({ qr });
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/seller-devices",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          devices: await application.listSellerDevices(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/platform-connections",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          connections: await application.listPlatformConnections(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/seller-devices/:deviceId/unpair",
      async (request) => {
        const { householdId, deviceId } = DeviceParamsSchema.parse(
          request.params,
        );
        return {
          device: await application.unpairSellerDevice(
            request.principal.userId,
            householdId,
            deviceId,
          ),
          localInstructions:
            "Open Seller Hub on the device and choose Clear local data, then log out of marketplace apps directly if desired.",
        };
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          items: await application.listItems(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items/publish-candidates",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          candidates: await application.listPublishCandidates(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/buyer-tasks",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          tasks: await application.listBuyerTasks(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/buyer-tasks/ingest",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const input = IngestBuyerMessageRequestSchema.parse(request.body);
        const task = await application.ingestBuyerMessage(
          request.principal.userId,
          householdId,
          input,
        );
        return reply.code(201).send({ task });
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/buyer-tasks/:taskId/decision",
      async (request) => {
        const { householdId, taskId } = BuyerTaskParamsSchema.parse(
          request.params,
        );
        const input = BuyerTaskDecisionRequestSchema.parse(request.body);
        return {
          task: await application.decideBuyerTask(
            request.principal.userId,
            householdId,
            taskId,
            input,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/buyer-tasks/:taskId/actions",
      async (request) => {
        const { householdId, taskId } = BuyerTaskParamsSchema.parse(
          request.params,
        );
        const input = BuyerTaskActionRequestSchema.parse(request.body);
        return application.draftBuyerTaskAction(
          request.principal.userId,
          householdId,
          taskId,
          input,
        );
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/buyer-tasks/:taskId/meetups",
      async (request, reply) => {
        const { householdId, taskId } = BuyerTaskParamsSchema.parse(
          request.params,
        );
        const input = CreateMeetupRequestSchema.parse(request.body);
        const meetup = await application.createMeetup(
          request.principal.userId,
          householdId,
          taskId,
          input,
        );
        return reply.code(201).send({ meetup });
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/meetups",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          meetups: await application.listMeetups(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.patch(
      "/v1/households/:householdId/meetups/:meetupId",
      async (request) => {
        const { householdId, meetupId } = MeetupParamsSchema.parse(
          request.params,
        );
        const input = UpdateMeetupRequestSchema.parse(request.body);
        return {
          meetup: await application.updateMeetup(
            request.principal.userId,
            householdId,
            meetupId,
            input,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/buyer-tasks/:taskId/backup",
      async (request, reply) => {
        const { householdId, taskId } = BuyerTaskParamsSchema.parse(
          request.params,
        );
        const entry = await application.enqueueBackupBuyer(
          request.principal.userId,
          householdId,
          taskId,
        );
        return reply.code(201).send({ entry });
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items/:itemId/backup-buyers",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        return {
          entries: await application.listBackupBuyers(
            request.principal.userId,
            householdId,
            itemId,
          ),
        };
      },
    );

    protectedRoutes.patch(
      "/v1/households/:householdId/items/:itemId/backup-buyers/:entryId",
      async (request) => {
        const { householdId, itemId, entryId } = BackupBuyerParamsSchema.parse(
          request.params,
        );
        const input = UpdateBackupBuyerRequestSchema.parse(request.body);
        return {
          entry: await application.updateBackupBuyer(
            request.principal.userId,
            householdId,
            itemId,
            entryId,
            input,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const input = CapturedItemInputSchema.parse(request.body);
        const result = await application.captureItem(
          request.principal.userId,
          householdId,
          input,
        );
        return reply.code(201).send(result);
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/batch",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const input = BatchCaptureRequestSchema.parse(request.body);
        const results = await application.captureBatch(
          request.principal.userId,
          householdId,
          input.items,
        );
        return reply.code(201).send({ results });
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items/:itemId",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const item = await application.getItem(
          request.principal.userId,
          householdId,
          itemId,
        );
        return { item };
      },
    );

    protectedRoutes.delete(
      "/v1/households/:householdId/items/:itemId",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = DeleteItemRequestSchema.parse(request.body);
        return application.deleteItem(
          request.principal.userId,
          householdId,
          itemId,
          input.confirmTitle,
        );
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items/:itemId/details",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        return application.getItemDetails(
          request.principal.userId,
          householdId,
          itemId,
        );
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/enrich",
      { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const result = await application.enrichItem(
          request.principal.userId,
          householdId,
          itemId,
        );
        return reply.code(result.reused ? 200 : 201).send(result);
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/pricing",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = PriceRecommendationRequestSchema.parse(request.body);
        return application.recommendPrices(
          request.principal.userId,
          householdId,
          itemId,
          input,
        );
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items/:itemId/enrichment",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        return {
          enrichment: await application.getLatestItemEnrichment(
            request.principal.userId,
            householdId,
            itemId,
          ),
        };
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/items/:itemId/bundle-suggestions",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        return {
          suggestions: await application.getBundleSuggestions(
            request.principal.userId,
            householdId,
            itemId,
          ),
        };
      },
    );

    protectedRoutes.put(
      "/v1/households/:householdId/items/:itemId/media/:mediaAssetId",
      async (request) => {
        const { householdId, itemId, mediaAssetId } = MediaParamsSchema.parse(
          request.params,
        );
        const input = ReplaceMediaAssetRequestSchema.parse(request.body);
        return {
          item: await application.replaceMediaAsset(
            request.principal.userId,
            householdId,
            itemId,
            mediaAssetId,
            input,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/media/:mediaAssetId/privacy-review",
      async (request) => {
        const { householdId, itemId, mediaAssetId } = MediaParamsSchema.parse(
          request.params,
        );
        const input = ReviewMediaPrivacyRequestSchema.parse(request.body);
        return {
          item: await application.reviewMediaPrivacy(
            request.principal.userId,
            householdId,
            itemId,
            mediaAssetId,
            input,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/listings",
      async (request, reply) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = CreateListingRequestSchema.parse(request.body);
        const listing = await application.createListing(
          request.principal.userId,
          householdId,
          itemId,
          input,
        );
        return reply.code(201).send({ listing });
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/publish",
      async (request, reply) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = PublishRequestSchema.parse(request.body);
        const result = await application.publish(
          request.principal.userId,
          householdId,
          itemId,
          input,
        );
        return reply.code(202).send(result);
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/batch-publish",
      async (request, reply) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        const input = BatchPublishRequestSchema.parse(request.body);
        const result = await application.publishBatch(
          request.principal.userId,
          householdId,
          input,
        );
        return reply.code(202).send(result);
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/actions",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = ItemLifecycleActionRequestSchema.parse(request.body);
        return application.changeItemLifecycle(
          request.principal.userId,
          householdId,
          itemId,
          input,
        );
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/propagate",
      async (request, reply) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = PropagateListingRequestSchema.parse(request.body);
        const result = await application.propagateListingEdits(
          request.principal.userId,
          householdId,
          itemId,
          input.listingVersion,
        );
        return reply.code(202).send(result);
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/publishing-jobs/:jobId",
      async (request) => {
        const { householdId, jobId } = JobParamsSchema.parse(request.params);
        return application.getPublishingJob(
          request.principal.userId,
          householdId,
          jobId,
        );
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/publishing-jobs/:jobId/export",
      async (request, reply) => {
        const { householdId, jobId } = JobParamsSchema.parse(request.params);
        const result = await application.getListingExport(
          request.principal.userId,
          householdId,
          jobId,
        );
        return reply
          .header(
            "content-disposition",
            `attachment; filename="localclear-listing-export-${jobId}.json"`,
          )
          .send(result);
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/publishing-jobs/:jobId/complete-import",
      async (request) => {
        const { householdId, jobId } = JobParamsSchema.parse(request.params);
        const input = CompleteImportRequestSchema.parse(request.body);
        return application.completeListingImport(
          request.principal.userId,
          householdId,
          jobId,
          input,
        );
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/publishing-jobs/:jobId/transitions",
      async (request) => {
        const { householdId, jobId } = JobParamsSchema.parse(request.params);
        const input = UserPublishingJobControlRequestSchema.parse(request.body);
        return application.transitionPublishingJob(
          request.principal.userId,
          householdId,
          jobId,
          input,
        );
      },
    );

    protectedRoutes.post(
      "/v1/households/:householdId/items/:itemId/close",
      async (request) => {
        const { householdId, itemId } = ItemParamsSchema.parse(request.params);
        const input = CloseItemRequestSchema.parse(request.body);
        return application.closeItem(
          request.principal.userId,
          householdId,
          itemId,
          input,
        );
      },
    );

    protectedRoutes.get(
      "/v1/households/:householdId/exception-tasks",
      async (request) => {
        const { householdId } = HouseholdParamsSchema.parse(request.params);
        return {
          tasks: await application.listExceptionTasks(
            request.principal.userId,
            householdId,
          ),
        };
      },
    );

    protectedRoutes.get("/v1/connectors", async (request) => ({
      connectors: await application.listConnectors(request.principal.userId),
    }));

    protectedRoutes.get("/v1/admin/operations", async (request) => {
      requireOperationsRole(request.principal, options.environment);
      return application.getOperationsDashboard();
    });

    protectedRoutes.patch(
      "/v1/admin/connectors/:connectorId",
      async (request) => {
        requireAdminRole(request.principal, options.environment);
        const { connectorId } = AdminConnectorParamsSchema.parse(
          request.params,
        );
        const input = AdminConnectorUpdateRequestSchema.parse(request.body);
        return {
          connector: await application.updateConnectorDefinition(
            request.principal.userId,
            connectorId,
            input,
          ),
        };
      },
    );

    protectedRoutes.patch("/v1/admin/feature-flags/:key", async (request) => {
      requireAdminRole(request.principal, options.environment);
      const { key } = AdminFeatureFlagParamsSchema.parse(request.params);
      const input = AdminFeatureFlagUpdateRequestSchema.parse(request.body);
      return {
        featureFlag: await application.updateFeatureFlag(
          request.principal.userId,
          key,
          input,
        ),
      };
    });

    protectedRoutes.get("/v1/admin/releases", async (request) => {
      requireOperationsRole(request.principal, options.environment);
      return {
        releases: await options.repository.listProductionReleases(100),
      };
    });

    protectedRoutes.post("/v1/admin/releases", async (request, reply) => {
      requireAdminRole(request.principal, options.environment);
      const input = CreateProductionReleaseRequestSchema.parse(request.body);
      const release = await application.createProductionRelease(
        request.principal.userId,
        input,
      );
      return reply.code(201).send({ release });
    });

    protectedRoutes.post(
      "/v1/admin/releases/:releaseId/submit",
      async (request) => {
        requireAdminRole(request.principal, options.environment);
        const { releaseId } = ProductionReleaseParamsSchema.parse(
          request.params,
        );
        return {
          release: await application.submitProductionRelease(
            request.principal.userId,
            releaseId,
          ),
        };
      },
    );

    protectedRoutes.post(
      "/v1/admin/releases/:releaseId/review",
      async (request) => {
        requireAdminRole(request.principal, options.environment);
        const { releaseId } = ProductionReleaseParamsSchema.parse(
          request.params,
        );
        const input = ReviewProductionReleaseRequestSchema.parse(request.body);
        return {
          release: await application.reviewProductionRelease(
            request.principal.userId,
            releaseId,
            input,
          ),
        };
      },
    );

    protectedRoutes.get("/v1/admin/support-grants", async (request) => {
      requireOperationsRole(request.principal, options.environment);
      return {
        grants: await application.listMyActiveSupportGrants(
          request.principal.userId,
        ),
      };
    });

    protectedRoutes.get(
      "/v1/admin/support-grants/:grantId/session",
      async (request) => {
        requireOperationsRole(request.principal, options.environment);
        const { grantId } = AdminSupportGrantParamsSchema.parse(request.params);
        return application.getSupportSession(request.principal.userId, grantId);
      },
    );
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply
      .code(404)
      .send({ error: "not_found", message: "Route was not found" });
  });

  app.addHook("onClose", async () => {
    await options.repository.close();
  });

  return app;
}

function requireOperationsRole(
  principal: AuthPrincipal,
  environment: ConnectorEnvironment | undefined,
): void {
  if (
    !principal.roles.some((role) => role === "admin" || role === "operator")
  ) {
    throw new ApplicationError(
      403,
      "admin_forbidden",
      "Operations access is required",
    );
  }
  requireOperationsMfa(principal, environment);
}

function requireAdminRole(
  principal: AuthPrincipal,
  environment: ConnectorEnvironment | undefined,
): void {
  if (!principal.roles.includes("admin")) {
    throw new ApplicationError(
      403,
      "admin_forbidden",
      "Administrator access is required",
    );
  }
  requireOperationsMfa(principal, environment);
}

function requireOperationsMfa(
  principal: AuthPrincipal,
  environment: ConnectorEnvironment | undefined,
): void {
  if (
    environment === "production" &&
    principal.authenticationAssuranceLevel !== "aal2"
  ) {
    throw new ApplicationError(
      403,
      "admin_mfa_required",
      "Multi-factor authentication is required for operations access",
    );
  }
}
