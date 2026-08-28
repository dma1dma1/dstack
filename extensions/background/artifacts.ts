import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type Sha256 = string & { readonly __brand: "Sha256" };

export type OutputArtifactSeal = Readonly<{
	path: string;
	sha256: string;
	bytes: number;
}>;

export type DeclaredArtifact = Readonly<{
	name: string;
	path: string;
	sha256?: string;
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

export async function atomicWriteFile(path: string, bytes: string | Buffer): Promise<void> {
	if (!isAbsolute(path) || normalize(path) !== path) throw new Error("atomic write path must be absolute and normalized");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		const directory = await open(dirname(path), constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		if (handle !== undefined) await handle.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
	}
}

export function sealBytes(path: string, bytes: Buffer): OutputArtifactSeal {
	return {
		path,
		bytes: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

export async function writeSealedArtifact(path: string, bytes: string | Buffer): Promise<OutputArtifactSeal> {
	const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
	await atomicWriteFile(path, buffer);
	return sealBytes(path, buffer);
}

export async function verifyDeclaredArtifacts(artifacts: readonly DeclaredArtifact[]): Promise<void> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	for (const artifact of artifacts) {
		if (!isAbsolute(artifact.path) || normalize(artifact.path) !== artifact.path) {
			throw new Error(`declared artifact ${artifact.name} has an invalid path`);
		}
		const handle = await open(artifact.path, constants.O_RDONLY | noFollow);
		try {
			const opened = await handle.stat();
			const linked = await lstat(artifact.path);
			if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()) {
				throw new Error(`declared artifact ${artifact.name} is not a regular file`);
			}
			if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
				throw new Error(`declared artifact ${artifact.name} changed identity while reading`);
			}
			if (artifact.sha256 !== undefined) {
				if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error(`declared artifact ${artifact.name} has an invalid sha256`);
				const digest = createHash("sha256").update(await handle.readFile()).digest("hex");
				if (digest !== artifact.sha256) throw new Error(`declared artifact ${artifact.name} sha256 mismatch`);
			}
		} finally {
			await handle.close();
		}
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
