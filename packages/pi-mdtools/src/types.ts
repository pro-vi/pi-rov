export type MdToolStatus = "ok" | "ambiguous" | "failed";
export type TaskStatus = "pending" | "done";
export type MovePlacement = "after" | "before" | "into";
export type SectionLeveling = "auto" | "keep";

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
}

export interface MdErrorInfo {
	message: string;
	exitCode?: number | null;
	stderr?: string;
	hint?: string;
}

export interface MdCandidate {
	role?: "target" | "source" | "destination";
	heading?: string;
	occurrence?: number;
	level?: number;
	blockIndex?: number;
	etag?: string;
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

export interface MdResultEnvelope<TData = unknown> {
	status: MdToolStatus;
	command: string;
	file?: string;
	data?: TData;
	candidates?: MdCandidate[];
	error?: MdErrorInfo;
	meta: MdResultMeta;
}

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
