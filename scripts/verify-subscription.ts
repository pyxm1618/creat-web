import { featuresConfig } from "@/config/features.config";
import { routeRegistry } from "@/config/routes.config";
import { subscriptionsConfig } from "@/config/subscriptions.config";

if (!Number.isInteger(subscriptionsConfig.pastDueGraceDays) || subscriptionsConfig.pastDueGraceDays < 0) {
  throw new Error("subscription grace days must be a nonnegative integer");
}
if (!subscriptionsConfig.gracePolicyVersion.trim()) throw new Error("subscription grace policy must be versioned");
for (const route of [
  "/api/commerce/subscription/cancel",
  "/api/commerce/subscription/resume",
  "/api/commerce/refunds",
]) {
  if (routeRegistry.get(route).class !== "system") throw new Error(`commerce command route must be system-only: ${route}`);
}
if (featuresConfig.commerce.subscriptions && !featuresConfig.commerce.enabled) {
  throw new Error("subscriptions cannot be enabled without commerce");
}
console.log(JSON.stringify({
  event: "subscription_verified",
  graceDays: subscriptionsConfig.pastDueGraceDays,
  gracePolicyVersion: subscriptionsConfig.gracePolicyVersion,
}));
