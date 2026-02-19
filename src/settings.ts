export const DEFAULT_TODOIST_TOKEN_SECRET_NAME = 'todoist-api';

export type ArchiveMode = 'none' | 'move-to-archive-folder' | 'mark-local-done';
export type ImportProjectScope = 'all-projects' | 'allow-list-by-name';

export interface TaskTodoistSettings {
	tasksFolderPath: string;
	defaultTaskTag: string;
	autoRenameTaskFiles: boolean;
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	showScheduledSyncNotices: boolean;
	archiveMode: ArchiveMode;
	archiveFolderPath: string;
	autoImportEnabled: boolean;
	autoImportProjectScope: ImportProjectScope;
	autoImportAllowedProjectNames: string;
	autoImportRequiredLabel: string;
	autoImportAssignedToMeOnly: boolean;
	todoistTokenSecretName: string;
}

export const DEFAULT_SETTINGS: TaskTodoistSettings = {
	tasksFolderPath: 'Tasks',
	defaultTaskTag: 'tasks',
	autoRenameTaskFiles: true,
	autoSyncEnabled: true,
	autoSyncIntervalMinutes: 5,
	showScheduledSyncNotices: false,
	archiveMode: 'move-to-archive-folder',
	archiveFolderPath: 'Tasks/_archive',
	autoImportEnabled: true,
	autoImportProjectScope: 'allow-list-by-name',
	autoImportAllowedProjectNames: '',
	autoImportRequiredLabel: 'obsidian',
	autoImportAssignedToMeOnly: true,
	todoistTokenSecretName: DEFAULT_TODOIST_TOKEN_SECRET_NAME,
};
