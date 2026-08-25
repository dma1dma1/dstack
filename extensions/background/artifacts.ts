import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type Sha256 = string & { readonly __brand: "Sha256" };

export type OutputArtifactSeal = Readonly<{
	path: string;
	sha256: string;
	bytes: number;
}>;

export function toAbsolutePath(value: string): AbsolutePath {
	if (!isAbsolute(value) || normalize(value) !== value) throw new Error("path must be absolute and normalized");
	return value as AbsolutePath;
}

export function toSha256(value: string): Sha256 {
	if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("sha256 must contain 64 lowercase hexadecimal characters");
	return value as Sha256;
}

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
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(seal.path, constants.O_RDONLY | noFollow);
	try {
		const openedStats = await handle.stat();
		if (!openedStats.isFile()) throw new Error("artifact path integrity check failed");

		const pathStats = await lstat(seal.path);
		if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
			throw new Error("artifact path integrity check failed");
		}
		if (pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino) {
			throw new Error("artifact identity integrity check failed");
		}
		if (openedStats.size !== seal.bytes) {
			throw new Error("artifact byte length integrity check failed");
		}

		const bytes = await handle.readFile();
		if (bytes.byteLength !== seal.bytes) {
			throw new Error("artifact byte length integrity check failed");
		}
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== seal.sha256) {
			throw new Error("artifact sha256 integrity check failed");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}
