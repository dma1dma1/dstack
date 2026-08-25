import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type Sha256 = string & { readonly __brand: "Sha256" };

export type OutputArtifactSeal = Readonly<{
	path: string;
	sha256: string;
	bytes: number;
}>;

function validateSeal(seal: OutputArtifactSeal): void {
	if (!isAbsolute(seal.path) || normalize(seal.path) !== seal.path) {
		throw new Error("artifact path integrity check failed");
	}
	if (!Number.isSafeInteger(seal.bytes) || seal.bytes < 0) {
		throw new Error("artifact byte length integrity check failed");
	}
	if (!/^[a-f0-9]{64}$/u.test(seal.sha256)) {
		throw new Error("artifact sha256 integrity check failed");
	}
}

export async function readOutputArtifact(seal: OutputArtifactSeal): Promise<Buffer> {
	validateSeal(seal);
	const stats = await lstat(seal.path);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error("artifact path integrity check failed");
	}
	if (stats.size !== seal.bytes) {
		throw new Error("artifact byte length integrity check failed");
	}

	const bytes = await readFile(seal.path);
	if (bytes.byteLength !== seal.bytes) {
		throw new Error("artifact byte length integrity check failed");
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== seal.sha256) {
		throw new Error("artifact sha256 integrity check failed");
	}
	return bytes;
}
