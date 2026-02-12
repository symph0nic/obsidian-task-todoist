import type { TaskTodoistSettings } from './settings';
import type { TodoistItem, TodoistProject } from './todoist-client';

export function filterImportableItems(
	items: TodoistItem[],
	projects: TodoistProject[],
	settings: TaskTodoistSettings,
	userId: string | null,
): TodoistItem[] {
	if (!settings.autoImportEnabled) {
		return [];
	}

	const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
	const allowedProjectNames = parseAllowedProjectNames(settings.autoImportAllowedProjectNames);
	const requiredLabel = settings.autoImportRequiredLabel.trim().toLowerCase();

	return items.filter((item) => {
		if (item.is_deleted) {
			return false;
		}

		if (settings.autoImportAssignedToMeOnly && userId && item.responsible_uid && item.responsible_uid !== userId) {
			return false;
		}

		if (settings.autoImportProjectScope === 'allow-list-by-name' && allowedProjectNames.size > 0) {
			const projectName = projectNameById.get(item.project_id)?.toLowerCase();
			if (!projectName || !allowedProjectNames.has(projectName)) {
				return false;
			}
		}

		if (requiredLabel) {
			const labels = (item.labels ?? []).map((label) => label.toLowerCase());
			if (!labels.includes(requiredLabel)) {
				return false;
			}
		}

		return true;
	});
}

function parseAllowedProjectNames(rawValue: string): Set<string> {
	return new Set(
		rawValue
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean),
	);
}
