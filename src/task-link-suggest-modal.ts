import { Editor, Notice, SuggestModal, TFile, normalizePath } from 'obsidian';
import type TaskTodoistPlugin from './main';
import { formatDueForDisplay } from './task-directives';
import { getTaskStatus, getTaskTitle } from './task-frontmatter';

interface TaskLinkSuggestion {
	file: TFile;
	title: string;
	status: 'open' | 'done';
	projectName: string;
	sectionName: string;
	dueDate: string;
	dueString: string;
	isRecurring: boolean;
	isArchived: boolean;
}

export class TaskLinkSuggestModal extends SuggestModal<TaskLinkSuggestion> {
	private readonly plugin: TaskTodoistPlugin;
	private readonly editor: Editor;
	private readonly items: TaskLinkSuggestion[];

	constructor(plugin: TaskTodoistPlugin, editor: Editor) {
		super(plugin.app);
		this.plugin = plugin;
		this.editor = editor;
		this.items = this.collectTaskNotes();
		this.setPlaceholder('Search task notes to insert...');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'insert task link' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getSuggestions(query: string): TaskLinkSuggestion[] {
		const normalizedQuery = query.trim().toLowerCase();
		const matches = normalizedQuery
			? this.items.filter((item) => this.getSearchText(item).includes(normalizedQuery))
			: this.items;
		return matches.slice(0, 50);
	}

	renderSuggestion(item: TaskLinkSuggestion, el: HTMLElement): void {
		el.addClass('task-todoist-link-suggestion');
		el.createDiv({ cls: 'task-todoist-link-suggestion-title', text: item.title });
		const bits: string[] = [item.status];
		const metaSummary = buildMetaSummary(item);
		if (metaSummary) {
			bits.push(metaSummary);
		}
		if (item.isArchived) {
			bits.push('archived');
		}
		bits.push(item.file.path);
		el.createDiv({ cls: 'task-todoist-link-suggestion-meta', text: bits.join(' • ') });
	}

	onChooseSuggestion(item: TaskLinkSuggestion): void {
		const linkTarget = item.file.path.replace(/\.md$/i, '');
		const selection = this.editor.getSelection().trim();
		const alias = selection || item.title;
		const link = alias && alias !== linkTarget
			? `[[${linkTarget}|${escapeAlias(alias)}]]`
			: `[[${linkTarget}]]`;
		insertTaskLineAtCursor(this.editor, link);
		new Notice(`Inserted task link: ${item.title}`, 3500);
	}

	private collectTaskNotes(): TaskLinkSuggestion[] {
		const taskFolder = normalizePath(this.plugin.settings.tasksFolderPath || 'Tasks');
		const taskPrefix = `${taskFolder}/`;
		const archiveFolder = normalizePath(this.plugin.settings.archiveFolderPath || '');
		const archivePrefix = archiveFolder ? `${archiveFolder}/` : '';
		const items: TaskLinkSuggestion[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path.startsWith(taskPrefix) || file.path === `${taskFolder}.md`)) {
				continue;
			}
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			const title = getTaskTitle(frontmatter ?? {}, file.basename);
			const status = getTaskStatus(frontmatter ?? {});
			items.push({
				file,
				title,
				status,
				projectName: toOptionalString(frontmatter?.todoist_project_name),
				sectionName: toOptionalString(frontmatter?.todoist_section_name),
				dueDate: normalizeDateValue(frontmatter?.todoist_due),
				dueString: toOptionalString(frontmatter?.todoist_due_string),
				isRecurring: frontmatter?.todoist_is_recurring === true || frontmatter?.todoist_is_recurring === 'true',
				isArchived: Boolean(archivePrefix) && file.path.startsWith(archivePrefix),
			});
		}

		return items.sort((a, b) => {
			if (a.isArchived !== b.isArchived) {
				return a.isArchived ? 1 : -1;
			}
			if (a.status !== b.status) {
				return a.status === 'done' ? 1 : -1;
			}
			return a.title.localeCompare(b.title);
		});
	}

	private getSearchText(item: TaskLinkSuggestion): string {
		return [
			item.title,
			item.file.path,
			item.status,
			item.projectName,
			item.sectionName,
			item.dueDate,
			item.dueString,
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase();
	}
}

function insertTaskLineAtCursor(editor: Editor, link: string): void {
	const selectedText = editor.getSelection();
	const taskLine = `- [ ] ${link}`;
	if (selectedText.length > 0) {
		editor.replaceSelection(taskLine);
		return;
	}

	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line) || '';
	const indent = line.match(/^\s*/)?.[0] ?? '';
	const indentedTaskLine = `${indent}${taskLine}`;

	if (line.trim().length === 0) {
		editor.setLine(cursor.line, indentedTaskLine);
		editor.setCursor({ line: cursor.line, ch: indentedTaskLine.length });
		return;
	}

	if (cursor.ch === 0) {
		editor.replaceRange(`${indentedTaskLine}\n`, cursor);
		editor.setCursor({ line: cursor.line, ch: indentedTaskLine.length });
		return;
	}

	if (cursor.ch >= line.length) {
		editor.replaceRange(`\n${indentedTaskLine}`, cursor);
		editor.setCursor({ line: cursor.line + 1, ch: indentedTaskLine.length });
		return;
	}

	editor.replaceRange(`\n${indentedTaskLine}\n`, cursor);
	editor.setCursor({ line: cursor.line + 1, ch: indentedTaskLine.length });
}

function buildMetaSummary(item: TaskLinkSuggestion): string {
	const parts: string[] = [];
	if (item.projectName) {
		parts.push(`📁 ${item.projectName}`);
	}
	if (item.sectionName) {
		parts.push(`🧭 ${item.sectionName}`);
	}
	if (item.isRecurring) {
		parts.push(`🔁 ${item.dueString || 'recurring'}`);
		if (item.dueDate) {
			parts.push(`📅 ${formatDueForDisplay(item.dueDate)}`);
		}
	} else {
		const dueRaw = item.dueString || item.dueDate;
		if (dueRaw) {
			parts.push(`📅 ${formatDueForDisplay(dueRaw)}`);
		}
	}
	return parts.join(' • ');
}

function toOptionalString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function normalizeDateValue(value: unknown): string {
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

function escapeAlias(value: string): string {
	return value.replace(/]/g, '\\]');
}
