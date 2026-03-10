import { Editor, MarkdownView, Notice, Plugin, TAbstractFile, TFile, getFrontMatterInfo, normalizePath, parseYaml } from 'obsidian';
import {
	DEFAULT_TODOIST_TOKEN_SECRET_NAME,
	DEFAULT_SETTINGS,
	type TaskTodoistSettings,
} from './settings';
import { TaskTodoistSettingTab } from './settings-tab';
import { TodoistClient, type TodoistProjectSectionLookup } from './todoist-client';
import { SyncService } from './sync-service';
import { CreateTaskModal, type TaskModalTaskData } from './create-task-modal';
import { createLocalTaskNote, type LocalTaskNoteInput } from './task-note-factory';
import { registerInlineTaskConverter } from './inline-task-converter';
import { createTaskConvertOverlayExtension } from './editor-task-convert-overlay';
import { formatDueForDisplay, parseInlineTaskDirectives } from './task-directives';
import { applyStandardTaskFrontmatter, setTaskStatus, setTaskTitle, touchModifiedDate } from './task-frontmatter';

export default class TaskTodoistPlugin extends Plugin {
	settings: TaskTodoistSettings;
	private todoistApiToken: string | null = null;
	private lastConnectionCheckMessage = 'No check run yet.';
	private lastSyncMessage = 'No sync run yet.';
	private readonly recentTaskMetaByLink = new Map<string, {
		projectName?: string;
		sectionName?: string;
		dueDate?: string;
		dueString?: string;
		isRecurring?: boolean;
	}>();
	private scheduledSyncIntervalId: number | null = null;
	private syncInProgress = false;
	private syncQueued = false;
	private lookupCache: { expiresAt: number; value: TodoistProjectSectionLookup } | null = null;
	private pendingTaskLinkInteraction: { linkTarget: string; sourcePath: string; timeoutId: number } | null = null;
	private static readonly UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[\s\]\s+)(.+)$/;
	private static readonly TASK_LINK_DOUBLE_CLICK_DELAY_MS = 260;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.loadTodoistApiToken();
		this.addSettingTab(new TaskTodoistSettingTab(this.app, this));
		this.registerCommands();
		this.registerVaultTaskDirtyTracking();
		this.registerTaskLinkDoubleClickHandler();
		registerInlineTaskConverter(this);
		this.registerEditorExtension(createTaskConvertOverlayExtension(this));
		this.configureScheduledSync();
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Partial<TaskTodoistSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	isSecretStorageAvailable(): boolean {
		return Boolean(this.app.secretStorage);
	}

	getTodoistApiToken(): string | null {
		return this.todoistApiToken;
	}

	getLastConnectionCheckMessage(): string {
		return this.lastConnectionCheckMessage;
	}

	getLastSyncMessage(): string {
		return this.lastSyncMessage;
	}

	async getTodoistProjectSectionLookup(forceRefresh = false): Promise<TodoistProjectSectionLookup> {
		const now = Date.now();
		if (!forceRefresh && this.lookupCache && this.lookupCache.expiresAt > now) {
			return this.lookupCache.value;
		}

		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;
		if (!token) {
			return { projects: [], sections: [] };
		}

		const client = new TodoistClient(token);
		const value = await client.fetchProjectSectionLookup();
		this.lookupCache = {
			expiresAt: now + (5 * 60 * 1000),
			value,
		};
		return value;
	}

	async testTodoistConnection(): Promise<{ ok: boolean; message: string }> {
		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;

		if (!token) {
			const result = {
				ok: false,
				message: 'No todoist API token is configured.',
			};
			this.setLastConnectionCheck(result.message);
			return result;
		}

		try {
			const client = new TodoistClient(token);
			const result = await client.testConnection();
			this.setLastConnectionCheck(result.message);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			const result = {
				ok: false,
				message: `Todoist connection check failed: ${message}`,
			};
			this.setLastConnectionCheck(result.message);
			return result;
		}
	}

	async runImportSync(): Promise<{ ok: boolean; message: string }> {
		if (this.syncInProgress) {
			this.syncQueued = true;
			return { ok: false, message: 'Sync already running. Queued another run.' };
		}

		this.syncInProgress = true;
		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;
		if (!token) {
			const result = { ok: false, message: 'No todoist API token is configured.' };
			this.setLastSync(result.message);
			this.finishSyncRun();
			return result;
		}

		try {
			const service = new SyncService(this.app, this.settings, token);
			const result = await service.runImportSync();
			this.setLastSync(result.message);
			return result;
		} finally {
			this.finishSyncRun();
		}
	}

	async createTaskNote(input: LocalTaskNoteInput) {
		const created = await createLocalTaskNote(this.app, this.settings, input);
		const linkTarget = created.path.replace(/\.md$/i, '');
		this.recentTaskMetaByLink.set(linkTarget, {
			projectName: input.todoistProjectName?.trim() || undefined,
			sectionName: input.todoistSectionName?.trim() || undefined,
			dueDate: input.todoistDueDate?.trim() || undefined,
			dueString: input.todoistDueString?.trim() || undefined,
			isRecurring: Boolean(input.todoistDueString?.trim()),
		});
		return created;
	}

	openCreateTaskModal(initialTitle = ''): void {
		new CreateTaskModal(this.app, this, initialTitle).open();
	}

	async openEditTaskModalByLink(linkTarget: string, sourcePath = ''): Promise<void> {
		const taskFile = this.resolveTaskFileByLink(linkTarget, sourcePath);
		if (!taskFile) {
			new Notice('Task note could not be resolved from the clicked link.', 5000);
			return;
		}

		const taskData = await this.getTaskModalData(taskFile);
		new CreateTaskModal(this.app, this, '', taskData).open();
	}

	async convertEditorChecklistLineToTaskNote(editor: Editor): Promise<{ ok: boolean; message: string }> {
		const lineNumber = editor.getCursor().line;
		return this.convertChecklistLineByEditorLine(editor, lineNumber);
	}

	async convertChecklistLineInActiveEditor(lineNumberOneBased: number, expectedTitle?: string): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (!editor) {
			new Notice('No active Markdown editor found.', 5000);
			return;
		}

		const zeroBasedLine = Math.max(0, lineNumberOneBased - 1);
		const line = editor.getLine(zeroBasedLine);
		const match = line.match(TaskTodoistPlugin.UNCHECKED_TASK_LINE_REGEX);
		if (!match) {
			return;
		}

		const title = normalizeTaskText(match[2] ?? '');
		if (!title || (expectedTitle && normalizeTaskText(expectedTitle) !== title)) {
			return;
		}

		const result = await this.convertChecklistLineByEditorLine(editor, zeroBasedLine);
		const prefix = result.ok ? 'Success:' : 'Failed:';
		new Notice(`${prefix} ${result.message}`, 5000);
	}


	private async convertChecklistLineByEditorLine(editor: Editor, lineNumber: number): Promise<{ ok: boolean; message: string }> {
		const line = editor.getLine(lineNumber);
		const match = line.match(TaskTodoistPlugin.UNCHECKED_TASK_LINE_REGEX);
		if (!match) {
			return {
				ok: false,
				message: 'Current line is not an unchecked checklist task.',
			};
		}

		const parsed = parseInlineTaskDirectives(normalizeTaskText(match[2] ?? ''));
		if (!parsed.title) {
			return {
				ok: false,
				message: 'Task title is empty.',
			};
		}

		const created = await this.createTaskNote({
			title: parsed.title,
			description: '',
			todoistSync: true,
			todoistProjectName: parsed.projectName,
			todoistSectionName: parsed.sectionName,
			todoistDueDate: parsed.dueRaw,
			todoistDueString: parsed.recurrenceRaw,
		});
		const linkTarget = created.path.replace(/\.md$/i, '');
		editor.setLine(lineNumber, `${match[1]}[[${linkTarget}|${parsed.title}]]`);
		return {
			ok: true,
			message: `Converted task to note: ${created.basename}`,
		};
	}

	async updateLinkedTaskNoteStatusByLink(linkTarget: string, isDone: boolean): Promise<void> {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		const taskFile = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
		if (!taskFile) {
			return;
		}

		await this.app.fileManager.processFrontMatter(taskFile, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			touchModifiedDate(data);
			setTaskStatus(data, isDone ? 'done' : 'open');
			data.local_updated_at = new Date().toISOString();
			const todoistId = typeof data.todoist_id === 'string' ? data.todoist_id : '';
			if (todoistId.trim()) {
				data.todoist_sync_status = 'dirty_local';
				if ('sync_status' in data) {
					delete data.sync_status;
				}
			}
		});
	}

	async updateTaskNote(file: TFile, input: LocalTaskNoteInput): Promise<TFile> {
		const normalizedTitle = input.title.trim();
		const normalizedDescription = input.description?.trim() ?? '';
		const normalizedParentTaskLink = input.parentTaskLink?.trim() ?? '';
		const normalizedProjectId = input.todoistProjectId?.trim() ?? '';
		const normalizedProjectName = input.todoistProjectName?.trim() ?? '';
		const normalizedSectionId = input.todoistSectionId?.trim() ?? '';
		const normalizedSectionName = input.todoistSectionName?.trim() ?? '';
		const normalizedDueDate = input.todoistDueDate?.trim() ?? '';
		const normalizedDueString = input.todoistDueString?.trim() ?? '';
		const isRecurring = Boolean(normalizedDueString);

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			touchModifiedDate(data);
			setTaskTitle(data, normalizedTitle);
			if (normalizedParentTaskLink) {
				data.parent_task = normalizedParentTaskLink;
			} else if ('parent_task' in data) {
				delete data.parent_task;
			}
			data.todoist_sync = input.todoistSync;
			data.todoist_project_id = normalizedProjectId;
			data.todoist_project_name = normalizedProjectName;
			data.todoist_section_id = normalizedSectionId;
			data.todoist_section_name = normalizedSectionName;
			data.todoist_due = normalizedDueDate;
			data.todoist_due_string = normalizedDueString;
			data.todoist_is_recurring = isRecurring;
			data.local_updated_at = new Date().toISOString();
			const todoistId = typeof data.todoist_id === 'string' ? data.todoist_id.trim() : '';
			data.todoist_sync_status = todoistId
				? (input.todoistSync ? 'dirty_local' : 'local_only')
				: (input.todoistSync ? 'queued_local_create' : 'local_only');
			if ('sync_status' in data) {
				delete data.sync_status;
			}
		});

		const currentContent = await this.app.vault.cachedRead(file);
		const nextContent = replaceBodyContent(currentContent, normalizedDescription);
		if (nextContent !== currentContent) {
			await this.app.vault.modify(file, nextContent);
		}

		const renamed = await this.renameTaskFileToMatchTitle(file, normalizedTitle);
		const oldLinkTarget = file.path.replace(/\.md$/i, '');
		const newLinkTarget = renamed.path.replace(/\.md$/i, '');
		if (oldLinkTarget !== newLinkTarget) {
			this.recentTaskMetaByLink.delete(oldLinkTarget);
		}
		this.recentTaskMetaByLink.set(newLinkTarget, {
			projectName: normalizedProjectName || undefined,
			sectionName: normalizedSectionName || undefined,
			dueDate: normalizedDueDate || undefined,
			dueString: normalizedDueString || undefined,
			isRecurring,
		});
		return renamed;
	}

	getLinkedTaskMetaSummary(linkTarget: string): string {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		const taskFile = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
		if (taskFile) {
			const frontmatter = this.app.metadataCache.getFileCache(taskFile)?.frontmatter as Record<string, unknown> | undefined;
			if (frontmatter) {
				const projectName = typeof frontmatter.todoist_project_name === 'string' ? frontmatter.todoist_project_name.trim() : '';
				const sectionName = typeof frontmatter.todoist_section_name === 'string' ? frontmatter.todoist_section_name.trim() : '';
				const dueString = typeof frontmatter.todoist_due_string === 'string' ? frontmatter.todoist_due_string.trim() : '';
				const dueDate = normalizeFrontmatterDateValue(frontmatter.todoist_due);
				const isRecurring = frontmatter.todoist_is_recurring === true || frontmatter.todoist_is_recurring === 'true';
				const summary = buildMetaSummary(projectName, sectionName, dueDate, dueString, isRecurring);
				if (summary) {
					this.recentTaskMetaByLink.delete(linkTarget);
					return summary;
				}
			}
		}

		const recent = this.recentTaskMetaByLink.get(linkTarget);
		if (recent) {
			return buildMetaSummary(
				recent.projectName,
				recent.sectionName,
				recent.dueDate,
				recent.dueString,
				recent.isRecurring,
			);
		}

		return '';
	}

	private async getTaskModalData(file: TFile): Promise<TaskModalTaskData> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const content = await this.app.vault.cachedRead(file);
		return {
			file,
			title: getTaskTitleFromFrontmatter(frontmatter, file.basename),
			description: stripFrontmatter(content).trim(),
			parentTaskLink: typeof frontmatter?.parent_task === 'string' ? frontmatter.parent_task.trim() : '',
			todoistSync: frontmatter?.todoist_sync === true || frontmatter?.todoist_sync === 'true',
			todoistProjectId: typeof frontmatter?.todoist_project_id === 'string' ? frontmatter.todoist_project_id.trim() : '',
			todoistProjectName: typeof frontmatter?.todoist_project_name === 'string' ? frontmatter.todoist_project_name.trim() : '',
			todoistSectionId: typeof frontmatter?.todoist_section_id === 'string' ? frontmatter.todoist_section_id.trim() : '',
			todoistSectionName: typeof frontmatter?.todoist_section_name === 'string' ? frontmatter.todoist_section_name.trim() : '',
			todoistDueDate: normalizeFrontmatterDateValue(frontmatter?.todoist_due),
			todoistDueString: typeof frontmatter?.todoist_due_string === 'string' ? frontmatter.todoist_due_string.trim() : '',
		};
	}

	private async renameTaskFileToMatchTitle(file: TFile, title: string): Promise<TFile> {
		if (!this.settings.autoRenameTaskFiles) {
			return file;
		}
		const desiredBaseName = sanitizeTaskFileName(title.trim());
		if (!desiredBaseName || file.basename === desiredBaseName) {
			return file;
		}
		const folderPath = getFolderPath(file.path);
		const desiredPath = await this.getUniqueFilePathInFolder(folderPath, `${desiredBaseName}.md`, file.path);
		if (desiredPath === file.path) {
			return file;
		}
		await this.app.fileManager.renameFile(file, desiredPath);
		return file;
	}

	private async getUniqueFilePathInFolder(folderPath: string, desiredFileName: string, currentPath: string): Promise<string> {
		const normalizedFolder = normalizePath(folderPath);
		const sanitizedBaseName = sanitizeTaskFileName(desiredFileName.replace(/\.md$/i, '')) || 'Task';
		let candidate = normalizePath(`${normalizedFolder}/${sanitizedBaseName}.md`);
		if (candidate === currentPath || !this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}
		let suffix = 2;
		while (true) {
			candidate = normalizePath(`${normalizedFolder}/${sanitizedBaseName}-${suffix}.md`);
			if (candidate === currentPath || !this.app.vault.getAbstractFileByPath(candidate)) {
				return candidate;
			}
			suffix += 1;
		}
	}

	async updateTodoistTokenSecretName(secretName: string): Promise<void> {
		const normalizedName = secretName.trim() || DEFAULT_TODOIST_TOKEN_SECRET_NAME;
		this.settings.todoistTokenSecretName = normalizedName;
		await this.saveSettings();
		await this.loadTodoistApiToken();
	}

	async updateAutoSyncEnabled(enabled: boolean): Promise<void> {
		this.settings.autoSyncEnabled = enabled;
		await this.saveSettings();
		this.configureScheduledSync();
	}

	async updateAutoSyncIntervalMinutes(minutes: number): Promise<void> {
		const normalized = normalizeSyncInterval(minutes);
		this.settings.autoSyncIntervalMinutes = normalized;
		await this.saveSettings();
		this.configureScheduledSync();
	}

	private async loadTodoistApiToken(): Promise<void> {
		const secretName = this.settings.todoistTokenSecretName.trim();
		if (!secretName) {
			this.todoistApiToken = null;
			return;
		}

		const token = this.app.secretStorage.getSecret(secretName);
		this.todoistApiToken = token?.trim() || null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'test-todoist-connection',
			name: 'Test todoist connection',
			callback: async () => {
				const result = await this.testTodoistConnection();
				const prefix = result.ok ? 'Success:' : 'Failed:';
				new Notice(`${prefix} ${result.message}`, 6000);
			},
		});
		this.addCommand({
			id: 'sync-todoist-now',
			name: 'Sync todoist now',
			callback: async () => {
				const result = await this.runImportSync();
				const prefix = result.ok ? 'Success:' : 'Failed:';
				new Notice(`${prefix} ${result.message}`, 8000);
			},
		});
		this.addCommand({
			id: 'create-task-note',
			name: 'Create task note',
			callback: () => {
				this.openCreateTaskModal();
			},
		});
		this.addCommand({
			id: 'convert-checklist-item-to-task-note',
			name: 'Convert checklist item to task note',
			editorCallback: async (editor) => {
				const result = await this.convertEditorChecklistLineToTaskNote(editor);
				const prefix = result.ok ? 'Success:' : 'Failed:';
				new Notice(`${prefix} ${result.message}`, 6000);
			},
		});
	}

	private setLastConnectionCheck(message: string): void {
		const checkedAt = new Date().toLocaleString();
		this.lastConnectionCheckMessage = `${message} (${checkedAt})`;
	}

	private setLastSync(message: string): void {
		const syncedAt = new Date().toLocaleString();
		this.lastSyncMessage = `${message} (${syncedAt})`;
	}

	private configureScheduledSync(): void {
		if (this.scheduledSyncIntervalId !== null) {
			window.clearInterval(this.scheduledSyncIntervalId);
			this.scheduledSyncIntervalId = null;
		}

		if (!this.settings.autoSyncEnabled) {
			return;
		}

		const intervalMs = normalizeSyncInterval(this.settings.autoSyncIntervalMinutes) * 60 * 1000;
		this.scheduledSyncIntervalId = window.setInterval(() => {
			void this.runScheduledSync();
		}, intervalMs);
		this.registerInterval(this.scheduledSyncIntervalId);
	}

	private async runScheduledSync(): Promise<void> {
		const result = await this.runImportSync();
		if (result.message.startsWith('Sync already running')) {
			return;
		}

		if (this.settings.showScheduledSyncNotices) {
			const prefix = result.ok ? 'Scheduled sync:' : 'Scheduled sync failed:';
			new Notice(`${prefix} ${result.message}`, result.ok ? 3500 : 5000);
			return;
		}

		if (!result.ok) {
			new Notice(`Scheduled sync failed: ${result.message}`, 5000);
		}
	}

	private finishSyncRun(): void {
		this.syncInProgress = false;
		if (this.syncQueued) {
			this.syncQueued = false;
			void this.runImportSync();
		}
	}

	private registerVaultTaskDirtyTracking(): void {
		this.registerEvent(this.app.vault.on('modify', (file) => {
			void this.onVaultFileModified(file);
		}));
	}

	private registerTaskLinkDoubleClickHandler(): void {
		const handlePointerActivation = (event: MouseEvent) => {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
				return;
			}
			const target = event.target;
			if (!(target instanceof HTMLElement)) {
				return;
			}
			const linkEl = target.closest('.internal-link');
			if (!(linkEl instanceof HTMLElement)) {
				return;
			}
			const linkTarget = readInternalLinkTarget(linkEl);
			if (!linkTarget) {
				return;
			}
			const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
			const taskFile = this.resolveTaskFileByLink(linkTarget, sourcePath);
			if (!taskFile) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if ('stopImmediatePropagation' in event) {
				event.stopImmediatePropagation();
			}
			this.handleTaskLinkInteraction(linkTarget, sourcePath);
		};

		document.addEventListener('click', handlePointerActivation, true);
		this.register(() => {
			document.removeEventListener('click', handlePointerActivation, true);
			this.clearPendingTaskLinkInteraction();
		});
	}

	handleTaskLinkInteraction(linkTarget: string, sourcePath: string): void {
		const normalizedLinkTarget = linkTarget.trim();
		if (!normalizedLinkTarget) {
			return;
		}
		const pending = this.pendingTaskLinkInteraction;
		if (pending && pending.linkTarget === normalizedLinkTarget && pending.sourcePath === sourcePath) {
			window.clearTimeout(pending.timeoutId);
			this.pendingTaskLinkInteraction = null;
			void this.openEditTaskModalByLink(normalizedLinkTarget, sourcePath);
			return;
		}

		this.clearPendingTaskLinkInteraction();
		const timeoutId = window.setTimeout(() => {
			this.pendingTaskLinkInteraction = null;
			void this.app.workspace.openLinkText(normalizedLinkTarget, sourcePath, false);
		}, TaskTodoistPlugin.TASK_LINK_DOUBLE_CLICK_DELAY_MS);
		this.pendingTaskLinkInteraction = {
			linkTarget: normalizedLinkTarget,
			sourcePath,
			timeoutId,
		};
	}

	private clearPendingTaskLinkInteraction(): void {
		if (!this.pendingTaskLinkInteraction) {
			return;
		}
		window.clearTimeout(this.pendingTaskLinkInteraction.timeoutId);
		this.pendingTaskLinkInteraction = null;
	}

	private async onVaultFileModified(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return;
		}
		if (this.syncInProgress) {
			return;
		}
		if (!this.isTaskFilePath(file.path)) {
			return;
		}

		const fullContent = await this.app.vault.cachedRead(file);
		const parsedFrontmatter = this.parseFrontmatterFromContent(fullContent);
		const cachedFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const frontmatter = parsedFrontmatter ?? cachedFrontmatter;
		if (!frontmatter) {
			return;
		}

		const todoistSync = frontmatter.todoist_sync;
		const todoistId = typeof frontmatter.todoist_id === 'string' ? frontmatter.todoist_id.trim() : '';
		if (!(todoistSync === true || todoistSync === 'true') || !todoistId) {
			return;
		}

		const currentStatus =
			typeof frontmatter.todoist_sync_status === 'string'
				? frontmatter.todoist_sync_status
				: (typeof frontmatter.sync_status === 'string' ? frontmatter.sync_status : '');
		if (currentStatus === 'dirty_local' || currentStatus === 'queued_local_create') {
			return;
		}

		const lastSyncedSignature =
			typeof frontmatter.todoist_last_synced_signature === 'string'
				? frontmatter.todoist_last_synced_signature.trim()
				: '';
		if (lastSyncedSignature) {
			const currentSignature = this.computeCurrentTodoistSyncSignature(file, fullContent, frontmatter);
			if (currentSignature === lastSyncedSignature) {
				return;
			}
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatterToMutate) => {
			const data = frontmatterToMutate as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			touchModifiedDate(data);
			data.todoist_sync_status = 'dirty_local';
			data.local_updated_at = new Date().toISOString();
			if ('sync_status' in data) {
				delete data.sync_status;
			}
		});
	}

	private isTaskFilePath(path: string): boolean {
		const taskFolder = normalizePath(this.settings.tasksFolderPath);
		const taskPrefix = `${taskFolder}/`;
		return path === taskFolder || path.startsWith(taskPrefix);
	}

	private resolveTaskFileByLink(linkTarget: string, sourcePath: string): TFile | null {
		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
		if (resolved && this.isTaskFilePath(resolved.path)) {
			return resolved;
		}

		const normalizedTarget = normalizePath(linkTarget.replace(/^\[\[|\]\]$/g, '').replace(/#.*$/, '').trim());
		if (!normalizedTarget) {
			return null;
		}
		const directCandidates = normalizedTarget.toLowerCase().endsWith('.md')
			? [normalizedTarget]
			: [normalizedTarget, `${normalizedTarget}.md`];
		for (const candidate of directCandidates) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile && this.isTaskFilePath(file.path)) {
				return file;
			}
		}
		return null;
	}

	private computeCurrentTodoistSyncSignature(
		file: TFile,
		fullContent: string,
		frontmatter: Record<string, unknown>,
	): string {
		const description = fullContent.replace(/^---[\s\S]*?---\n?/, '').trim();
		const title = typeof frontmatter.task_title === 'string' && frontmatter.task_title.trim()
			? frontmatter.task_title.trim()
			: file.basename.trim();
		const taskStatus = typeof frontmatter.task_status === 'string' ? frontmatter.task_status : '';
		const taskDone = frontmatter.task_done === true || frontmatter.task_done === 'true';
		const isDone = taskStatus === 'done' || taskDone;
		const isRecurring = frontmatter.todoist_is_recurring === true || frontmatter.todoist_is_recurring === 'true';
		const projectId = typeof frontmatter.todoist_project_id === 'string' ? frontmatter.todoist_project_id.trim() : '';
		const sectionId = typeof frontmatter.todoist_section_id === 'string' ? frontmatter.todoist_section_id.trim() : '';
		const dueDate = normalizeFrontmatterDateValue(frontmatter.todoist_due);
		const dueString = typeof frontmatter.todoist_due_string === 'string' ? frontmatter.todoist_due_string.trim() : '';

		return simpleStableHash(JSON.stringify([
			title,
			description,
			isDone ? 1 : 0,
			isRecurring ? 1 : 0,
			projectId,
			sectionId,
			dueDate,
			dueString,
		]));
	}

	private parseFrontmatterFromContent(content: string): Record<string, unknown> | null {
		const frontmatterInfo = getFrontMatterInfo(content);
		if (!frontmatterInfo.exists || frontmatterInfo.frontmatter.trim() === '') {
			return null;
		}
		const parsed = parseYaml(frontmatterInfo.frontmatter);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	}
}

function normalizeTaskText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function getTaskTitleFromFrontmatter(frontmatter: Record<string, unknown> | undefined, fallback: string): string {
	const taskTitle = typeof frontmatter?.task_title === 'string' ? frontmatter.task_title.trim() : '';
	if (taskTitle) {
		return taskTitle;
	}
	const legacyTitle = typeof frontmatter?.title === 'string' ? frontmatter.title.trim() : '';
	if (legacyTitle) {
		return legacyTitle;
	}
	return fallback;
}

function stripFrontmatter(content: string): string {
	return content.replace(/^---[\s\S]*?---\n?/, '');
}

function replaceBodyContent(content: string, nextBody: string): string {
	const frontmatterMatch = content.match(/^---[\s\S]*?---\n?/);
	const frontmatter = frontmatterMatch?.[0] ?? '';
	const normalizedBody = nextBody.trim() ? `${nextBody.trim()}\n` : '';
	return `${frontmatter}${normalizedBody}`;
}

function getFolderPath(path: string): string {
	const lastSlashIndex = path.lastIndexOf('/');
	if (lastSlashIndex === -1) {
		return '';
	}
	return path.slice(0, lastSlashIndex);
}

function sanitizeTaskFileName(value: string): string {
	return value
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

function readInternalLinkTarget(linkEl: HTMLElement): string {
	const dataHref = linkEl.getAttribute('data-href')?.trim() ?? '';
	if (dataHref) {
		return dataHref;
	}
	const href = linkEl.getAttribute('href')?.trim() ?? '';
	if (!href) {
		return '';
	}
	return href.replace(/^#/, '').trim();
}

function normalizeFrontmatterDateValue(value: unknown): string {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (value instanceof Date && Number.isFinite(value.getTime())) {
		return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
	}
	return '';
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

function normalizeSyncInterval(value: number): number {
	if (!Number.isFinite(value)) {
		return 5;
	}
	return Math.min(120, Math.max(1, Math.round(value)));
}

function buildMetaSummary(
	projectName?: string,
	sectionName?: string,
	dueDate?: string,
	dueString?: string,
	isRecurring = false,
): string {
	const parts: string[] = [];
	if (projectName) {
		parts.push(`📁 ${projectName}`);
	}
	if (sectionName) {
		parts.push(`🧭 ${sectionName}`);
	}
	if (isRecurring) {
		parts.push(`🔁 ${dueString || 'recurring'}`);
		if (dueDate) {
			parts.push(`📅 ${formatDueForDisplay(dueDate)}`);
		}
	} else {
		const dueRaw = dueString || dueDate;
		if (dueRaw) {
			parts.push(`📅 ${formatDueForDisplay(dueRaw)}`);
		}
	}
	return parts.join(' • ');
}

function simpleStableHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}
