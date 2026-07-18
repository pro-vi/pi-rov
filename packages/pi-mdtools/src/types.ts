export type MdToolStatus = "ok" | "ambiguous" | "failed";
export type TaskStatus = "pending" | "done";
export type MovePlacement = "after" | "before" | "into";
export type SectionLeveling = "auto" | "keep";

export type MdErrorCode =
	| "E_MD_BINARY_MISSING"
	| "E_MD_COMMAND_ABORTED"
	| "E_MD_COMMAND_FAILED"
	| "E_MD_JSON_PARSE"
	| "E_MD_SCHEMA_MISMATCH"
	| "E_ETAG_MISMATCH"
	| "E_ETAG_UNAVAILABLE"
	| "E_HEADING_NOT_FOUND"
	| "E_AMBIGUOUS_HEADING"
	| "E_OCCURRENCE_OUT_OF_RANGE"
	| "E_ETAG_AMBIGUOUS"
	| "E_MD_VERSION_UNSUPPORTED"
	| "E_BAD_LOC";

/// Handshake verdict from probing `md schema --json` once per runtime.
/// "current" requires schema_version mdtools.v1 AND the required capability
/// set; a version match with a missing capability is "legacy".
export interface MdHandshake {
	verdict: "current" | "legacy" | "missing";
	binaryVersion?: string;
	capabilities?: string[];
	schemaVersion?: string;
}

export interface MdCommandRequest {
	binary: string;
	args: string[];
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface MdCommandExecution {
	binary: string;
	args: string[];
	cwd: string;
	code: number | null;
	stdout: string;
	stderr: string;
	killed: boolean;
}

export type MdCommandRunner = (request: MdCommandRequest) => Promise<MdCommandExecution>;

export interface MdBinaryResolution {
	found: boolean;
	path?: string;
	source?: "explicit" | "env" | "path" | "fallback";
	searched: string[];
}

export interface MdtoolsStatus {
	binary: MdBinaryResolution;
	cwd: string;
	handshake?: MdHandshake;
}

export interface MdErrorInfo {
	code: MdErrorCode;
	message: string;
	nextAction: string;
	exitCode?: number | null;
	stderr?: string;
	hint?: string;
	/// Structured etag/loc context projected from the binary's envelope.
	expectedEtag?: string;
	foundEtag?: string;
	loc?: string;
}

export interface MdCandidate {
	role?: "target" | "source" | "destination" | "task";
	heading?: string;
	occurrence?: number;
	level?: number;
	blockIndex?: number;
	line?: number;
	etag?: string;
	loc?: string;
	status?: TaskStatus;
	taskIndex?: number;
	span?: unknown;
	snippet?: string;
}

export interface MdResultMeta {
	binary?: string;
	args: string[];
	cwd: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

interface MdResultBase {
	command: string;
	file?: string;
	meta: MdResultMeta;
}

export type MdResultEnvelope<TData = unknown> =
	| (MdResultBase & {
			status: "ok";
			data?: TData;
			candidates?: never;
			error?: never;
	  })
	| (MdResultBase & {
			status: "ambiguous";
			candidates?: MdCandidate[];
			error: MdErrorInfo;
			data?: never;
	  })
	| (MdResultBase & {
			status: "failed";
			candidates?: MdCandidate[];
			error: MdErrorInfo;
			data?: never;
	  });

export interface OutlineParams {
	file: string;
}

export interface SectionParams {
	file: string;
	heading: string;
	ignoreCase?: boolean;
	occurrence?: number;
}

export interface TasksParams {
	file: string;
	status?: TaskStatus;
}

export interface TableParams {
	file: string;
	index?: number;
	select?: string;
	where?: string[];
}

export interface BlocksParams {
	file: string;
}

export interface BlockParams {
	file: string;
	index: number;
}

export interface SetTaskParams {
	file: string;
	loc: string;
	status: TaskStatus;
	expectEtag?: string;
}

export interface MoveSectionParams {
	file: string;
	source: string;
	destination: string;
	placement: MovePlacement;
	leveling?: SectionLeveling;
	ignoreCase?: boolean;
	sourceOccurrence?: number;
	destinationOccurrence?: number;
}

export interface ReplaceSectionParams {
	file: string;
	heading: string;
	content: string;
	expectEtag?: string;
	ignoreCase?: boolean;
	occurrence?: number;
}
