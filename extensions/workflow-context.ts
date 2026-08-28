import { dirname, isAbsolute, join, normalize } from "node:path";
import type { ChildDepth, WorkflowArtifact, WorkflowAssignment, WorkflowContext } from "./types.ts";
import { WORKFLOW_ASSIGNMENTS } from "./types.ts";

const slugPattern = /^[a-z][a-z0-9-]*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function workflowArtifact(value: unknown, index: number): WorkflowArtifact | { error: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { error: `workflow.artifacts[${index}] must be an object.` };
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || !slugPattern.test(raw.name)) {
		return { error: `workflow.artifacts[${index}].name must be a lowercase slug.` };
	}
	if (typeof raw.path !== "string" || !isAbsolute(raw.path) || normalize(raw.path) !== raw.path) {
		return { error: `workflow.artifacts[${index}].path must be an absolute normalized path.` };
	}
	if (raw.sha256 !== undefined && (typeof raw.sha256 !== "string" || !sha256Pattern.test(raw.sha256))) {
		return { error: `workflow.artifacts[${index}].sha256 must be 64 lowercase hexadecimal characters.` };
	}
	return { name: raw.name, path: raw.path, ...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}) };
}

export function parseWorkflowContext(value: unknown): WorkflowContext | { error: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { error: "workflow must be an object." };
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.playbook !== "string" || !slugPattern.test(raw.playbook)) {
		return { error: "workflow.playbook must be a lowercase slug." };
	}
	if (!WORKFLOW_ASSIGNMENTS.includes(raw.assignment as WorkflowAssignment)) {
		return { error: `workflow.assignment must be one of ${WORKFLOW_ASSIGNMENTS.join(", ")}.` };
	}
	if (typeof raw.phase !== "string" || !slugPattern.test(raw.phase)) {
		return { error: "workflow.phase must be a lowercase slug." };
	}
	if (!Array.isArray(raw.completedPhases) || raw.completedPhases.length > 32) {
		return { error: "workflow.completedPhases must be an array of at most 32 phase slugs." };
	}
	if (!raw.completedPhases.every((phase) => typeof phase === "string" && slugPattern.test(phase))) {
		return { error: "workflow.completedPhases must contain only lowercase phase slugs." };
	}
	if (new Set(raw.completedPhases).size !== raw.completedPhases.length) {
		return { error: "workflow.completedPhases must not contain duplicates." };
	}
	if (!Array.isArray(raw.artifacts) || raw.artifacts.length > 32) {
		return { error: "workflow.artifacts must be an array of at most 32 artifacts." };
	}
	const artifacts: WorkflowArtifact[] = [];
	for (const [index, value] of raw.artifacts.entries()) {
		const artifact = workflowArtifact(value, index);
		if ("error" in artifact) return artifact;
		artifacts.push(artifact);
	}
	return {
		playbook: raw.playbook,
		assignment: raw.assignment as WorkflowAssignment,
		phase: raw.phase,
		completedPhases: [...raw.completedPhases] as string[],
		artifacts,
	};
}

function workflowFacts(workflow: WorkflowContext): string[] {
	const completed = workflow.completedPhases.length > 0 ? workflow.completedPhases.join(", ") : "none";
	const artifacts = workflow.artifacts.length > 0
		? workflow.artifacts.map((artifact) => `- ${artifact.name}: ${artifact.path}${artifact.sha256 ? ` (sha256 ${artifact.sha256})` : ""}`)
		: ["- none"];
	return [
		`Playbook: ${workflow.playbook}.`,
		`Current phase: ${workflow.phase}.`,
		`Completed phases: ${completed}.`,
		"Artifacts:",
		...artifacts,
	];
}

export function workflowSystemPrompt(skillPath: string, depth: ChildDepth, workflow: WorkflowContext): string {
	const facts = workflowFacts(workflow);
	if (workflow.assignment === "owner") {
		const playbookPath = join(dirname(skillPath), "playbooks", `${workflow.playbook}.md`);
		return [
			`You are the depth-${depth} task owner.`,
			`Read the owner rules in ${skillPath} and the selected playbook in ${playbookPath}.`,
			...facts,
			"Run the playbook end to end. You own grounding, phase transitions, worker briefs, integration, diff review, and verification.",
			"Pass workflow metadata to every child. Workers may be launched in as many bounded batches as the task needs.",
			"Never return a final response with an uncollected child task. After independent work, call dstack_result with its task id; nested results wait for completion instead of requiring polling.",
			"Return one concise, evidence-backed result to the root. Do not forward worker transcripts.",
		].join("\n");
	}
	if (workflow.assignment === "worker") {
		return [
			`You are a terminal depth-${depth} worker.`,
			...facts,
			"Complete only the assigned phase against the supplied artifacts.",
			"Do not read dmode or a playbook, reopen a completed phase, or spawn children.",
			"If an artifact contradicts the task, stop and report the contradiction to the owner.",
			"Return a concise summary with changed paths and verification results, not a transcript.",
		].join("\n");
	}
	return [
		`You are a terminal depth-${depth} reviewer.`,
		...facts,
		"Review only the assigned artifact and return a concise verdict with concrete findings.",
		"Do not modify files, reopen completed phases, or spawn children.",
	].join("\n");
}
