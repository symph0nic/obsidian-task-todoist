import type { TaskTodoistSettings } from './settings';

export function applyStandardTaskFrontmatter(
	frontmatter: Record<string, unknown>,
	settings: TaskTodoistSettings,
): void {
	if (typeof frontmatter.created !== 'string' || !frontmatter.created.trim()) {
		frontmatter.created = formatCreatedDate(new Date());
	}
	frontmatter.modified = formatModifiedDate(new Date());

	const defaultTag = normalizeTag(settings.defaultTaskTag);
	const existingTags = normalizeTags(frontmatter.tags);
	if (defaultTag && !existingTags.includes(defaultTag)) {
		existingTags.unshift(defaultTag);
	}
	frontmatter.tags = existingTags;

	if (!Array.isArray(frontmatter.links)) {
		frontmatter.links = [];
	}
}

export function getTaskTitle(frontmatter: Record<string, unknown>, fallback = ''): string {
	const taskTitle = typeof frontmatter.task_title === 'string' ? frontmatter.task_title.trim() : '';
	if (taskTitle) {
		return taskTitle;
	}
	const legacyTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
	if (legacyTitle) {
		return legacyTitle;
	}
	return fallback;
}

export function getTaskStatus(frontmatter: Record<string, unknown>): 'open' | 'done' {
	if (frontmatter.task_done === true || frontmatter.task_done === 'true') {
		return 'done';
	}
	if (frontmatter.task_done === false || frontmatter.task_done === 'false') {
		return 'open';
	}
	const taskStatus = typeof frontmatter.task_status === 'string' ? frontmatter.task_status.trim().toLowerCase() : '';
	if (taskStatus === 'done') {
		return 'done';
	}
	if (taskStatus === 'open') {
		return 'open';
	}
	if (frontmatter.done === true || frontmatter.done === 'true') {
		return 'done';
	}
	const legacyStatus = typeof frontmatter.status === 'string' ? frontmatter.status.trim().toLowerCase() : '';
	if (legacyStatus === 'done') {
		return 'done';
	}
	return 'open';
}

export function setTaskTitle(frontmatter: Record<string, unknown>, title: string): void {
	frontmatter.task_title = title;
	if ('title' in frontmatter) {
		delete frontmatter.title;
	}
}

export function setTaskStatus(frontmatter: Record<string, unknown>, status: 'open' | 'done'): void {
	frontmatter.task_status = status;
	frontmatter.task_done = status === 'done';
	if ('status' in frontmatter) {
		delete frontmatter.status;
	}
	if ('done' in frontmatter) {
		delete frontmatter.done;
	}
}

export function getDefaultTaskTag(settings: TaskTodoistSettings): string | null {
	return normalizeTag(settings.defaultTaskTag);
}

export function formatCreatedDate(date: Date): string {
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	return `${year}-${month}-${day}`;
}

export function formatModifiedDate(date: Date): string {
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	const hours = pad2(date.getHours());
	const minutes = pad2(date.getMinutes());
	return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function normalizeTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => normalizeTag(entry))
			.filter((entry): entry is string => Boolean(entry));
	}
	if (typeof value === 'string') {
		const normalized = normalizeTag(value);
		return normalized ? [normalized] : [];
	}
	return [];
}

function normalizeTag(value: string | undefined): string | null {
	const trimmed = (value ?? '').trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.replace(/^#+/, '');
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}
