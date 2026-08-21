import { randomUUID } from "node:crypto";
import type { UserNotification } from "@localclear/domain";
import type { Repository } from "./repository.js";

export interface PushDeliveryProvider {
  send(
    expoPushTokens: readonly string[],
    notification: UserNotification,
  ): Promise<string[]>;
}

export class ExpoPushDeliveryProvider implements PushDeliveryProvider {
  async send(
    expoPushTokens: readonly string[],
    notification: UserNotification,
  ): Promise<string[]> {
    if (expoPushTokens.length === 0) return [];
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        expoPushTokens.map((token) => ({
          to: token,
          title: notification.title,
          body: notification.body,
          data: {
            notificationId: notification.id,
            householdId: notification.householdId,
            actionPath: notification.actionPath,
          },
          sound: "default",
        })),
      ),
    });
    if (!response.ok) {
      throw new Error(`Expo push request failed with ${response.status}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{
        status?: "ok" | "error";
        id?: string;
        message?: string;
      }>;
      errors?: Array<{ message?: string }>;
    };
    if (payload.errors?.length) {
      throw new Error(
        payload.errors[0]?.message ?? "Expo push rejected the batch",
      );
    }
    const tickets = payload.data ?? [];
    const failed = tickets.find((ticket) => ticket.status === "error");
    if (failed) throw new Error(failed.message ?? "Expo push delivery failed");
    return tickets.flatMap((ticket) => (ticket.id ? [ticket.id] : []));
  }
}

export class NotificationDispatcher {
  readonly #repository: Repository;
  readonly #provider: PushDeliveryProvider;
  readonly #workerId: string;
  readonly #now: () => Date;

  constructor(options: {
    repository: Repository;
    provider: PushDeliveryProvider;
    workerId?: string;
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#workerId = options.workerId ?? `notifications-${randomUUID()}`;
    this.#now = options.now ?? (() => new Date());
  }

  async runOnce(limit = 50): Promise<{ claimed: number; sent: number }> {
    const now = this.#now();
    const notifications = await this.#repository.claimQueuedNotifications({
      workerId: this.#workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      limit,
    });
    let sent = 0;
    for (const notification of notifications) {
      const subscriptions = await this.#repository.listPushSubscriptions(
        notification.userId,
      );
      if (subscriptions.length === 0) {
        await this.#repository.completeNotificationDelivery({
          notificationId: notification.id,
          workerId: this.#workerId,
          state: "no_subscription",
          providerTicketIds: [],
          nextDeliveryAt: now.toISOString(),
        });
        continue;
      }
      try {
        const providerTicketIds = await this.#provider.send(
          subscriptions.map((value) => value.expoPushToken),
          notification,
        );
        await this.#repository.completeNotificationDelivery({
          notificationId: notification.id,
          workerId: this.#workerId,
          state: "sent",
          providerTicketIds,
          nextDeliveryAt: now.toISOString(),
        });
        sent += 1;
      } catch {
        const attempt = notification.deliveryAttempts + 1;
        await this.#repository.completeNotificationDelivery({
          notificationId: notification.id,
          workerId: this.#workerId,
          state: attempt >= 3 ? "failed" : "queued",
          providerTicketIds: [],
          nextDeliveryAt: new Date(
            now.getTime() + Math.min(5 * 60_000, 5_000 * 2 ** (attempt - 1)),
          ).toISOString(),
        });
      }
    }
    return { claimed: notifications.length, sent };
  }
}
