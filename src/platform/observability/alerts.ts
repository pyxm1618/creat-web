export type OperationalAlertCode =
  | "dead_letter_created"
  | "magic_link_volume_spike"
  | "webhook_invalid_signature_spike"
  | "reconciliation_mismatch"
  | "job_backlog_stale"
  | "provider_outage_repeated";

export type OperationalAlert = Readonly<{
  event: "operational_alert";
  code: OperationalAlertCode;
  severity: "warning" | "critical";
  observedValue: number;
  threshold: number;
}>;

export type OperationalAlertSnapshot = Readonly<{
  deadLettersCreated: number;
  magicLinkRequests5m: number;
  invalidWebhookSignatures5m: number;
  reconciliationMismatches: number;
  jobBacklog: number;
  oldestJobAgeSeconds: number;
  providerFailures5m: number;
}>;

export type OperationalAlertThresholds = Readonly<{
  magicLinkRequests5m: number;
  invalidWebhookSignatures5m: number;
  jobBacklog: number;
  oldestJobAgeSeconds: number;
  providerFailures5m: number;
}>;

export const DEFAULT_OPERATIONAL_ALERT_THRESHOLDS: OperationalAlertThresholds = {
  magicLinkRequests5m: 100,
  invalidWebhookSignatures5m: 20,
  jobBacklog: 100,
  oldestJobAgeSeconds: 15 * 60,
  providerFailures5m: 10,
};

function alert(
  code: OperationalAlertCode,
  severity: OperationalAlert["severity"],
  observedValue: number,
  threshold: number,
): OperationalAlert {
  return { event: "operational_alert", code, severity, observedValue, threshold };
}

export function evaluateOperationalAlerts(
  snapshot: OperationalAlertSnapshot,
  thresholds: OperationalAlertThresholds = DEFAULT_OPERATIONAL_ALERT_THRESHOLDS,
): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  if (snapshot.deadLettersCreated > 0) {
    alerts.push(alert("dead_letter_created", "critical", snapshot.deadLettersCreated, 1));
  }
  if (snapshot.magicLinkRequests5m >= thresholds.magicLinkRequests5m) {
    alerts.push(
      alert(
        "magic_link_volume_spike",
        "warning",
        snapshot.magicLinkRequests5m,
        thresholds.magicLinkRequests5m,
      ),
    );
  }
  if (snapshot.invalidWebhookSignatures5m >= thresholds.invalidWebhookSignatures5m) {
    alerts.push(
      alert(
        "webhook_invalid_signature_spike",
        "warning",
        snapshot.invalidWebhookSignatures5m,
        thresholds.invalidWebhookSignatures5m,
      ),
    );
  }
  if (snapshot.reconciliationMismatches > 0) {
    alerts.push(
      alert("reconciliation_mismatch", "critical", snapshot.reconciliationMismatches, 1),
    );
  }
  if (
    snapshot.jobBacklog >= thresholds.jobBacklog ||
    snapshot.oldestJobAgeSeconds >= thresholds.oldestJobAgeSeconds
  ) {
    const backlogRatio = snapshot.jobBacklog / thresholds.jobBacklog;
    const ageRatio = snapshot.oldestJobAgeSeconds / thresholds.oldestJobAgeSeconds;
    alerts.push(
      alert(
        "job_backlog_stale",
        "critical",
        Math.max(backlogRatio, ageRatio),
        1,
      ),
    );
  }
  if (snapshot.providerFailures5m >= thresholds.providerFailures5m) {
    alerts.push(
      alert(
        "provider_outage_repeated",
        "critical",
        snapshot.providerFailures5m,
        thresholds.providerFailures5m,
      ),
    );
  }
  return alerts;
}

export function emitOperationalAlerts(
  alerts: readonly OperationalAlert[],
  write: (line: string) => void = console.error,
): void {
  for (const item of alerts) write(JSON.stringify(item));
}
