export interface ParsedTaskDirectives {
	title: string;
	projectName?: string;
	sectionName?: string;
	dueRaw?: string;
	recurrenceRaw?: string;
}

const DIRECTIVE_REGEX = /\b(proj|project|sec|section|due|recur|recurrence)::(?:"([^"]+)"|(\S+))/gi;

export function parseInlineTaskDirectives(rawTaskText: string): ParsedTaskDirectives {
	let projectName: string | undefined;
	let sectionName: string | undefined;
	let dueRaw: string | undefined;
	let recurrenceRaw: string | undefined;

	let cleaned = rawTaskText;
	let match: RegExpExecArray | null;
	while ((match = DIRECTIVE_REGEX.exec(rawTaskText)) !== null) {
		const directive = (match[1] ?? '').toLowerCase();
		const value = (match[2] ?? match[3] ?? '').trim();
		if (!value) {
			continue;
		}

		if (directive === 'proj' || directive === 'project') {
			projectName = value;
		} else if (directive === 'sec' || directive === 'section') {
			sectionName = value;
		} else if (directive === 'due') {
			dueRaw = value;
		} else if (directive === 'recur' || directive === 'recurrence') {
			recurrenceRaw = value;
		}
		cleaned = cleaned.replace(match[0], ' ');
	}

	const title = cleaned.replace(/\s+/g, ' ').trim();
	return {
		title,
		projectName,
		sectionName,
		dueRaw,
		recurrenceRaw,
	};
}

export function formatDueForDisplay(dueRaw: string): string {
	const trimmed = dueRaw.trim();
	if (!trimmed) {
		return '';
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		const parsed = new Date(`${trimmed}T00:00:00`);
		if (!Number.isNaN(parsed.getTime())) {
			const relative = relativeDayLabel(parsed, new Date());
			if (relative) {
				return relative;
			}
			return new Intl.DateTimeFormat(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
			}).format(parsed);
		}
	}

	return trimmed;
}

function relativeDayLabel(target: Date, now: Date): string | null {
	const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
	const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const diffMs = targetMidnight.getTime() - nowMidnight.getTime();
	const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
	if (diffDays === 0) {
		return 'today';
	}
	if (diffDays === 1) {
		return 'tomorrow';
	}
	if (diffDays === -1) {
		return 'yesterday';
	}
	return null;
}
