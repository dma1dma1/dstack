import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function testMcpExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "mcp",
		label: "test MCP",
		description: "Test-only MCP gateway used to verify child extension propagation.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "test MCP" }], details: {} };
		},
	});
}
