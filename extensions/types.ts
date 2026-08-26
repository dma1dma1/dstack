export const ROLE_NAMES = [
	"feature",
	"refactoring",
	"bug-fix",
	"perf-issue",
	"hillclimb",
	"judgment",
	"prose",
	"hardest-tasks",
	"how-explorer",
	"how-explainer",
	"how-critics",
	"why-investigators",
	"why-synthesizer",
	"reflect-tooling",
	"reflect-judgment",
	"reflect-divergent",
	"reflect-synthesizer",
	"arena-runners",
	"arena-cross-judge-pool",
	"swarm-workers",
	"architect-runners",
	"interrogate-reviewers",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export const LIST_ROLES = [
	"how-critics",
	"arena-runners",
	"arena-cross-judge-pool",
	"architect-runners",
	"interrogate-reviewers",
] as const;

export type ListRoleName = (typeof LIST_ROLES)[number];

export const MODEL_ALIASES = ["inherit-parent", "auto"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];
export type ModelRef = ModelAlias | string;
export type RoleValue = ModelRef | ModelRef[];

export type WorktreeFrom = "HEAD" | "origin/main";

export type DstackConfig = {
	roles: Record<string, RoleValue>;
	worktree: {
		base: string;
		from: WorktreeFrom;
	};
};

export type BuiltInAgent = "poteto-agent" | "general-purpose" | "comment-sicko";

export type NestingDepth = 0 | 1 | 2;
export type SpawnableDepth = 0 | 1;
export type ChildDepth = 1 | 2;

export const WORKFLOW_ASSIGNMENTS = ["owner", "worker", "reviewer"] as const;
export type WorkflowAssignment = (typeof WORKFLOW_ASSIGNMENTS)[number];

export type WorkflowArtifact = Readonly<{
	name: string;
	path: string;
	sha256?: string;
}>;

export type WorkflowContext = Readonly<{
	playbook: string;
	assignment: WorkflowAssignment;
	phase: string;
	completedPhases: readonly string[];
	artifacts: readonly WorkflowArtifact[];
}>;

export type ActiveWorkflow = Readonly<{
	taskId: string;
	playbook: string;
}>;

export type TaskSpec = {
	agent: string;
	task: string;
	model?: string;
	role?: string;
	overrideReason?: string;
	tools?: string;
	cwd?: string;
	worktree?: boolean;
	dmode?: boolean;
	workflow?: WorkflowContext;
};

export type TaskRequest =
	| { kind: "single"; spec: TaskSpec }
	| { kind: "parallel"; specs: TaskSpec[] }
	| { kind: "chain"; specs: TaskSpec[] };

export type ModeState = {
	on: boolean;
};

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
	id: string;
	content: string;
	status: TodoStatus;
};

export type TodoState = {
	items: TodoItem[];
};

export const COMMENT_SICKO_TOOLS = "read,grep,find,ls";
export const EXPLORER_TOOLS = "read,grep,find,ls";
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
export const NESTING_ENV = "DSTACK_NESTING";
export const ASSIGNMENT_ENV = "DSTACK_ASSIGNMENT";
export const MODE_ENTRY = "dstack-mode";
export const TODO_ENTRY = "dstack-todos";
export const ACTIVE_WORKFLOW_ENTRY = "dstack-active-workflow";
export const DEFAULT_WORKTREE_BASE = "~/.dma/worktrees";
