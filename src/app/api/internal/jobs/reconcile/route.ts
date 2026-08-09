import { featuresConfig } from "@/config/features.config";
import { purgeExpiredWebhookPayloads } from "@/platform/commerce/application/purge-webhook-payloads";
import { reconcileStaleRefunds } from "@/platform/commerce/application/reconcile-stale-refunds";
import { getCommerceRuntime } from "@/platform/commerce/commerce-runtime";
import { env } from "@/platform/config/env";
import { reconcileCreditLedger } from "@/platform/credits/application/reconcile-credit-ledger";
import { db } from "@/platform/database/application-database";
import {
  emitOperationalAlerts,
  evaluateOperationalAlerts,
} from "@/platform/observability/alerts";
import { emitMetric } from "@/platform/observability/metrics";
import { collectOperationalAlertSnapshot } from "@/platform/observability/operational-snapshot";
import {
  authenticateInternalRequest,
  unauthorizedInternalResponse,
} from "@/platform/operations/authenticate-internal-request";
import { runBoundedJob } from "@/platform/operations/run-bounded-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!authenticateInternalRequest(request, env.cronSecret)) return unauthorizedInternalResponse();
  const commerce = await getCommerceRuntime();
  if (!commerce) return new Response("Not Found", { status: 404 });

  const result = await runBoundedJob({
    batchLimit: 50,
    maxRuntimeMs: 45_000,
    run: async (job) => {
      const staleRefundsReconciled = await reconcileStaleRefunds(commerce.database, {
        limit: job.batchLimit,
      });
      job.assertWithinBudget();
      const purgedPayloads = job.canContinue(2_000)
        ? await purgeExpiredWebhookPayloads(commerce.database, { limit: job.batchLimit })
        : 0;
      job.assertWithinBudget();
      const creditIssues =
        featuresConfig.commerce.credits && job.canContinue(2_000)
          ? await reconcileCreditLedger(db)
          : [];
      job.assertWithinBudget();

      const snapshot = await collectOperationalAlertSnapshot(db);
      emitMetric({ name: "dead_letter_created", value: snapshot.deadLettersCreated });
      emitMetric({ name: "magic_link_requests", value: snapshot.magicLinkRequests5m });
      emitMetric({
        name: "webhook_invalid_signatures",
        value: snapshot.invalidWebhookSignatures5m,
      });
      emitMetric({ name: "reconciliation_mismatches", value: snapshot.reconciliationMismatches });
      emitMetric({ name: "job_backlog", value: snapshot.jobBacklog });
      emitMetric({ name: "oldest_job_age_seconds", value: snapshot.oldestJobAgeSeconds });
      emitMetric({ name: "provider_failures", value: snapshot.providerFailures5m });
      emitOperationalAlerts(evaluateOperationalAlerts(snapshot));

      return {
        staleRefundsReconciled,
        purgedPayloads,
        creditReconciliationIssues: creditIssues.length,
        alertsEvaluated: true,
      };
    },
  });

  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
