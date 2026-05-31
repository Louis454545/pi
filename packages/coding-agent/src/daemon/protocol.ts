export interface DaemonStatus {
	pid: number;
	childPid?: number;
	socketPath: string;
	cwd: string;
	startedAt: string;
	uptimeMs: number;
}

export type DaemonAdminCommand = { id?: string; type: "daemon_status" } | { id?: string; type: "daemon_shutdown" };

export type DaemonAdminResponse =
	| { id?: string; type: "daemon_response"; command: "daemon_status"; success: true; data: DaemonStatus }
	| { id?: string; type: "daemon_response"; command: "daemon_shutdown"; success: true }
	| { id?: string; type: "daemon_response"; command: string; success: false; error: string };
