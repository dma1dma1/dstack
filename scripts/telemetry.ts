#!/usr/bin/env node
import { collectTelemetryData, type TelemetryReportV1 } from "../extensions/telemetry.ts";

export function formatReportHumanReadable(report: TelemetryReportV1): string {
	const lines: string[] = [];
	lines.push(`dstack Telemetry Report (${report.schemaVersion})`);
	lines.push(`Generated: ${report.generatedAt}`);
	if (report.reportPeriod.earliestTimestamp || report.reportPeriod.latestTimestamp) {
		lines.push(`Period: ${report.reportPeriod.earliestTimestamp ?? "start"} to ${report.reportPeriod.latestTimestamp ?? "now"}`);
	}
	lines.push("");

	lines.push("1. Workflow Selections (Top-Level Owner Workflows):");
	lines.push(`   Total Top-Level Workflows: ${report.workflowSelections.totalWorkflows}`);
	lines.push(`   By Playbook: ${JSON.stringify(report.workflowSelections.byPlaybook)}`);
	lines.push(`   By Mode: ${JSON.stringify(report.workflowSelections.byMode)}`);
	lines.push(`   By Outcome: ${JSON.stringify(report.workflowSelections.byOutcome)}`);
	lines.push("");

	lines.push("2. Roles and Resolved Models by Playbook (Including Nested Spawns):");
	for (const [pb, roles] of Object.entries(report.rolesAndModels.byPlaybook)) {
		lines.push(`   Playbook [${pb}]:`);
		for (const [role, models] of Object.entries(roles)) {
			lines.push(`     - ${role}: ${JSON.stringify(models)}`);
		}
	}
	lines.push("");

	lines.push("3. Runtime Distributions (ms):");
	const formatQuantiles = (label: string, d: (typeof report.runtimeDistributions)["owner"]) => {
		lines.push(
			`   ${label.padEnd(12)} count=${d.count} min=${d.minMs.toFixed(0)} median=${d.medianMs.toFixed(0)} p75=${d.p75Ms.toFixed(0)} p90=${d.p90Ms.toFixed(0)} p95=${d.p95Ms.toFixed(0)} p99=${d.p99Ms.toFixed(0)} max=${d.maxMs.toFixed(0)} mean=${d.meanMs.toFixed(0)}`,
		);
	};
	formatQuantiles("Owner", report.runtimeDistributions.owner);
	formatQuantiles("Worker", report.runtimeDistributions.worker);
	formatQuantiles("Reviewer", report.runtimeDistributions.reviewer);
	formatQuantiles("Unassigned", report.runtimeDistributions.unassigned);
	formatQuantiles("All", report.runtimeDistributions.all);
	lines.push("");

	lines.push("4. Owner Delegation Cohorts (Observational):");
	const del = report.ownerDelegationCohorts.delegatedOwners;
	lines.push(`   Delegated Owners: count=${del.count} median=${del.runtime.medianMs.toFixed(0)}ms mean=${del.runtime.meanMs.toFixed(0)}ms`);
	const nonDel = report.ownerDelegationCohorts.nonDelegatedOwners;
	lines.push(`   Non-Delegated Owners: count=${nonDel.count} median=${nonDel.runtime.medianMs.toFixed(0)}ms mean=${nonDel.runtime.meanMs.toFixed(0)}ms`);
	lines.push(`   Limitation: ${report.ownerDelegationCohorts.causalityLimitation}`);
	lines.push("");

	lines.push("5. Provenance and Launch Failures:");
	lines.push(`   Included Workflows: ${report.provenance.includedWorkflows}`);
	lines.push(`   Excluded Test Workflows: ${report.provenance.excludedTestWorkflows}`);
	lines.push(`   Included by Provenance: ${JSON.stringify(report.provenance.byProvenance)}`);
	lines.push(`   Pre-Launch Configuration Failures: ${report.launchFailures.preLaunchConfiguration}`);
	lines.push(`   Other Pre-Launch Failures: ${report.launchFailures.preLaunchOther}`);
	lines.push(`   Execution Failures: ${report.launchFailures.execution}`);
	lines.push(`   Unknown Failure Stage: ${report.launchFailures.unknown}`);
	lines.push("");

	lines.push("6. Role & Model Associations (Launched Executions Only):");
	for (const rm of report.roleModelReliability) {
		lines.push(
			`   ${rm.role} (${rm.resolvedModel}): ${rm.totalInvocations} runs | ${rm.succeededCount} succeeded | ${rm.failedCount} failed | ${rm.abandonedCount} abandoned | repeatedDelegations=${rm.observableRepeatedDelegationCount} | failureRate=${(rm.failureRate * 100).toFixed(1)}%`,
		);
	}
	lines.push("");

	lines.push("7. Worker Economics (Direct Cost Comparison):");
	lines.push(`   Lightweight Worker Runs: ${report.workerEconomics.lightweightWorkerRuns}`);
	lines.push(`   Worker Runs With Cost: ${report.workerEconomics.lightweightWorkerRunsWithCost}`);
	lines.push(`   Worker Direct Cost: $${report.workerEconomics.lightweightWorkerDirectCost.toFixed(4)}`);
	if (report.workerEconomics.lightweightWorkerAverageCostPerRun !== null) {
		lines.push(`   Worker Average Cost Per Run: $${report.workerEconomics.lightweightWorkerAverageCostPerRun.toFixed(4)}`);
	}
	lines.push(`   Owner Runs: ${report.workerEconomics.ownerRuns}`);
	lines.push(`   Owner Runs With Cost: ${report.workerEconomics.ownerRunsWithCost}`);
	lines.push(`   Owner Direct Cost: $${report.workerEconomics.ownerDirectCost.toFixed(4)}`);
	if (report.workerEconomics.ownerAverageCostPerRun !== null) {
		lines.push(`   Owner Average Cost Per Run: $${report.workerEconomics.ownerAverageCostPerRun.toFixed(4)}`);
	}
	lines.push(`   Direct Cost Is Lower: ${report.workerEconomics.directCostIsLower}`);
	if (report.workerEconomics.costSavingsRatio !== null) {
		lines.push(`   Direct Cost Savings Ratio: ${(report.workerEconomics.costSavingsRatio * 100).toFixed(1)}%`);
	}
	lines.push(`   After-Rework Economics Supported: ${report.workerEconomics.afterReworkEconomicsSupported}`);
	lines.push(`   Note: ${report.workerEconomics.evaluationNote}`);
	lines.push("");

	lines.push("8. Durable Queue Events:");
	const queue = report.queueEvents;
	lines.push(`   Tickets Created: ${queue.ticketCreated}`);
	lines.push(`   Slots Acquired: ${queue.slotAcquired}`);
	lines.push(`   Matched Acquisitions: ${queue.matchedAcquisitions}`);
	lines.push(`   Missing Acquisitions: ${queue.missingAcquisitions}`);
	lines.push(`   Orphan Acquisitions: ${queue.orphanAcquisitions}`);
	lines.push(`   Duplicate Event IDs: ${queue.duplicateEventIds}`);
	lines.push(`   Queue Wait: count=${queue.waitTime.count} median=${queue.waitTime.medianMs.toFixed(0)}ms p95=${queue.waitTime.p95Ms.toFixed(0)}ms max=${queue.waitTime.maxMs.toFixed(0)}ms`);
	lines.push(`   By Depth: ${JSON.stringify(queue.byDepth)}`);
	lines.push(`   By Capacity Class: ${JSON.stringify(queue.byCapacityClass)}`);
	lines.push("");

	lines.push("9. Data Join Reliability:");
	const dj = report.dataJoinReliability;
	const fmtJoin = (joined: number, total: number, rate: number | null) =>
		`${joined}/${total}${rate !== null ? ` (${(rate * 100).toFixed(1)}%)` : " (n/a)"}`;
	lines.push(`   Manifest -> Pi Session: ${fmtJoin(dj.manifestToSession.joined, dj.manifestToSession.total, dj.manifestToSession.joinRate)}`);
	lines.push(`   Committed -> Result Index: ${fmtJoin(dj.committedToResultIndex.joined, dj.committedToResultIndex.totalCommitted, dj.committedToResultIndex.joinRate)}`);
	lines.push(`   Manifest -> Child Results: ${fmtJoin(dj.manifestToChildResults.joinedChildResults, dj.manifestToChildResults.totalExpectedChildren, dj.manifestToChildResults.joinRate)}`);
	lines.push(`   Bindings -> Workflows: ${fmtJoin(dj.bindingsToWorkflows.joined, dj.bindingsToWorkflows.totalBindings, dj.bindingsToWorkflows.joinRate)}`);
	lines.push(`   Queue Events -> Workflows: ${fmtJoin(dj.queueEventsToWorkflows.joined, dj.queueEventsToWorkflows.totalEvents, dj.queueEventsToWorkflows.joinRate)}`);
	lines.push(`   Overall Data Join Rate: ${fmtJoin(dj.totalJoinsSuccessful, dj.totalJoinsAttempted, dj.overallJoinRate)}`);
	lines.push("");

	lines.push("10. Workflow Outcome Reliability:");
	const outcomes = report.workflowOutcomeReliability;
	lines.push(`   Total: ${outcomes.totalWorkflows}`);
	lines.push(`   Succeeded: ${outcomes.succeeded}`);
	lines.push(`   Failed: ${outcomes.failed}`);
	lines.push(`   Cancelled: ${outcomes.cancelled}`);
	lines.push(`   Uncommitted or Abandoned: ${outcomes.uncommittedOrAbandoned}`);
	lines.push(`   Success Rate: ${outcomes.successRate === null ? "n/a" : `${(outcomes.successRate * 100).toFixed(1)}%`}`);
	lines.push(`   By Mode: ${JSON.stringify(outcomes.byMode)}`);
	lines.push("");

	lines.push("11. Data Completeness & Limitations:");
	lines.push(`   Scanned Sessions: ${report.recoverableAndMissingMetrics.scannedSessions}`);
	lines.push(`   Scanned Workflows: ${report.recoverableAndMissingMetrics.scannedWorkflows}`);
	lines.push(`   Scanned Children: ${report.recoverableAndMissingMetrics.scannedChildren}`);
	lines.push(`   Corrupt Records: ${JSON.stringify(report.recoverableAndMissingMetrics.corruptOrUnparseableRecords)}`);
	lines.push("   Unsupported / Missing Metrics:");
	for (const m of report.recoverableAndMissingMetrics.missingOrUnsupportedMetrics) {
		lines.push(`     - [${m.metric}] ${m.reason} (${m.explicitLimitation})`);
	}

	return lines.join("\n");
}

export async function runTelemetryCli(argv: readonly string[]): Promise<number> {
	let jsonOutput = false;
	let prettyOutput = false;
	let backgroundRoot: string | undefined;
	let sessionsDir: string | undefined;
	let from: string | undefined;
	let to: string | undefined;
	let includeTests = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			jsonOutput = true;
		} else if (arg === "--pretty") {
			jsonOutput = true;
			prettyOutput = true;
		} else if (arg === "--background-root" && i + 1 < argv.length) {
			backgroundRoot = argv[++i];
		} else if (arg === "--sessions-dir" && i + 1 < argv.length) {
			sessionsDir = argv[++i];
		} else if (arg === "--from" && i + 1 < argv.length) {
			from = argv[++i];
		} else if (arg === "--to" && i + 1 < argv.length) {
			to = argv[++i];
		} else if (arg === "--include-tests") {
			includeTests = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`Usage: telemetry [options]\n\n`);
			process.stdout.write(`Options:\n`);
			process.stdout.write(`  --json                  Output raw JSON\n`);
			process.stdout.write(`  --pretty                Output pretty-printed JSON\n`);
			process.stdout.write(`  --background-root <dir> Path to background task artifacts directory\n`);
			process.stdout.write(`  --sessions-dir <dir>    Path to Pi sessions directory\n`);
			process.stdout.write(`  --from <timestamp>      Include workflows at or after this ISO timestamp\n`);
			process.stdout.write(`  --to <timestamp>        Include workflows at or before this ISO timestamp\n`);
			process.stdout.write(`  --include-tests         Include workflows marked or inferred as tests\n`);
			process.stdout.write(`  --help, -h              Show this help message\n`);
			return 0;
		}
	}

	for (const [name, value] of [["--from", from], ["--to", to]] as const) {
		if (value !== undefined && !Number.isFinite(Date.parse(value))) {
			throw new Error(`${name} must be a valid timestamp`);
		}
	}

	const report = await collectTelemetryData({
		backgroundRoot,
		sessionsDir,
		timeWindow: { from, to },
		includeTests,
	});

	if (jsonOutput) {
		process.stdout.write(`${JSON.stringify(report, null, prettyOutput ? 2 : undefined)}\n`);
	} else {
		process.stdout.write(`${formatReportHumanReadable(report)}\n`);
	}

	return 0;
}

if (process.argv[1]?.endsWith("telemetry.ts") || process.argv[1]?.endsWith("telemetry.js")) {
	runTelemetryCli(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(err: unknown) => {
			process.stderr.write(`telemetry error: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 1;
		},
	);
}
