import { randomUUID } from "node:crypto";

import { featuresConfig } from "@/config/features.config";
import { purgeExpiredWebhookPayloads } from "@/platform/commerce/application/purge-webhook-payloads";
import {
  reconcileStalePayments,
  type PaymentReconciliationResult,
} from "@/platform/commerce/application/reconcile-stale-payments";
import { reconcileStaleRefunds } from "@/platform/commerce/application/reconcile-stale-refunds";
import { getWebhookRetentionMetrics } from "@/platform/commerce/application/webhook-retention-metrics";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { env } from "@/platform/config/env";
import { reconcileCreditLedgerBatch } from "@/platform/credits/application/reconcile-credit-ledger";
import { db } from "@/platform/database/application-database";
import { emitOperationalAlerts, evaluateOperationalAlerts } from "@/platform/observability/alerts";
import { emitMetric } from "@/platform/observability/metrics";
import { collectOperationalAlertSnapshot } from "@/platform/observability/operational-snapshot";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";
import {
  JobRuntimeBudgetExceededError,
  runBoundedJob,
} from "@/platform/operations/run-bounded-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAYMENT_RECONCILIATION_LIMIT = 5;
const PAYMENT_RECONCILIATION_RUNTIME_MS = 5_000;
const EMPTY_PAYMENT_RECONCILIATION = {
  scanned: 0,
  applied: 0,
  retried: 0,
  operatorReview: 0,
} as const;

function isPaymentSliceAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    signal.reason instanceof JobRuntimeBudgetExceededError &&
    error === signal.reason
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });
  const expectedStoreId = env.waffoStoreId;
  if (!expectedStoreId) throw new Error("commerce runtime configuration is incomplete");

  const result = await runBoundedJob({
    batchLimit: 50,
    maxRuntimeMs: 45_000,
    run: async (job) => {
      const paymentSliceController = new AbortController();
      let paymentReconciliation: PaymentReconciliationResult = EMPTY_PAYMENT_RECONCILIATION;
      const paymentTimeoutId = setTimeout(
        () => paymentSliceController.abort(new JobRuntimeBudgetExceededError()),
        PAYMENT_RECONCILIATION_RUNTIME_MS,
      );
      try {
        paymentReconciliation = await reconcileStalePayments(commerce.database, commerce.provider, {
          owner: `payment-reconciliation:${commerce.environment}:${randomUUID()}`,
          expectedStoreId,
          limit: PAYMENT_RECONCILIATION_LIMIT,
          signal: AbortSignal.any([job.signal, paymentSliceController.signal]),
        });
      } catch (error) {
        if (job.signal.aborted) throw job.signal.reason ?? error;
        if (!isPaymentSliceAbort(error, paymentSliceController.signal)) throw error;
      } finally {
        clearTimeout(paymentTimeoutId);
      }
      job.signal.throwIfAborted();

      let remaining = job.batchLimit;
      const staleRefundsReconciled = await reconcileStaleRefunds(commerce.database, {
        limit: remaining,
      });
      remaining = Math.max(0, remaining - staleRefundsReconciled);
      job.assertWithinBudget();

      const purgedPayloads =
        remaining > 0 && job.canContinue(2_000)
          ? await purgeExpiredWebhookPayloads(commerce.database, { limit: remaining })
          : 0;
      remaining = Math.max(0, remaining - purgedPayloads);
      job.assertWithinBudget();

      const creditReconciliation =
        featuresConfig.commerce.credits && remaining > 0 && job.canContinue(2_000)
          ? await reconcileCreditLedgerBatch(db, {
              limit: remaining,
              signal: job.signal,
              canContinue: job.canContinue,
            })
          : null;
      job.assertWithinBudget();

      const [snapshot, retention] = await Promise.all([
        collectOperationalAlertSnapshot(db),
        getWebhookRetentionMetrics(commerce.database),
      ]);
      emitMetric({ name: "dead_letter_created", value: snapshot.deadLettersCreated });
      emitMetric({ name: "magic_link_requests", value: snapshot.magicLinkRequests5m });
      emitMetric({
        name: "webhook_invalid_signatures",
        value: snapshot.invalidWebhookSignatures5m,
      });
      emitMetric({ name: "webhook_retained_payloads", value: retention.retainedPayloads });
      emitMetric({
        name: "oldest_webhook_payload_age_seconds",
        value: retention.oldestRetainedPayloadAgeSeconds,
      });
      emitMetric({ name: "reconciliation_mismatches", value: snapshot.reconciliationMismatches });
      emitMetric({ name: "job_backlog", value: snapshot.jobBacklog });
      emitMetric({ name: "oldest_job_age_seconds", value: snapshot.oldestJobAgeSeconds });
      emitMetric({ name: "provider_failures", value: snapshot.providerFailures5m });
      emitOperationalAlerts(evaluateOperationalAlerts(snapshot));

      return {
        paymentScanned: paymentReconciliation.scanned,
        paymentApplied: paymentReconciliation.applied,
        paymentRetried: paymentReconciliation.retried,
        paymentOperatorReview: paymentReconciliation.operatorReview,
        staleRefundsReconciled,
        purgedPayloads,
        creditReconciliationIssues: creditReconciliation?.issues.length ?? 0,
        creditReconciliationProcessed: creditReconciliation?.processed ?? 0,
        creditReconciliationCycleComplete: creditReconciliation?.cycleComplete ?? false,
        alertsEvaluated: true,
      };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
