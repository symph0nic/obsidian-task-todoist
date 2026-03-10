import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type TaskTodoistPlugin from './main';

const UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[\s\]\s+)(.+)$/;
const LINKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[[ xX]\]\s+)(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])(\s*)$/;

export function createTaskConvertOverlayExtension(plugin: TaskTodoistPlugin) {
	return ViewPlugin.fromClass(class {
		decorations: DecorationSet;
		linkedStatusByTarget: Map<string, boolean>;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view, plugin);
			this.linkedStatusByTarget = readLinkedTaskStatusMap(view.state.doc.toString());
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged || update.selectionSet) {
				this.decorations = buildDecorations(update.view, plugin);
			}
			if (update.docChanged) {
				const next = readLinkedTaskStatusMap(update.state.doc.toString());
				for (const [linkTarget, checked] of next) {
					const previous = this.linkedStatusByTarget.get(linkTarget);
					if (previous !== undefined && previous !== checked) {
						void plugin.updateLinkedTaskNoteStatusByLink(linkTarget, checked);
					}
				}
				this.linkedStatusByTarget = next;
			}
		}
	}, {
		decorations: (value) => value.decorations,
		eventHandlers: {
			click(event, view) {
				return handleLinkedTaskClick(event, view, plugin);
			},
		},
	});
}

function buildDecorations(view: EditorView, plugin: TaskTodoistPlugin): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	for (const range of view.visibleRanges) {
		let position = range.from;
		while (position <= range.to) {
			const line = view.state.doc.lineAt(position);

			const linkedMatch = line.text.match(LINKED_TASK_LINE_REGEX);
			if (linkedMatch) {
				const linkTarget = linkedMatch[3] ?? '';
				const metaSummary = linkTarget ? plugin.getLinkedTaskMetaSummary(linkTarget) : '';

				if (linkTarget && metaSummary) {
					builder.add(
						line.to,
						line.to,
						Decoration.widget({
							side: 1,
							widget: new LinkedTaskMetaWidget(metaSummary),
						}),
					);
				}
			} else {
				const uncheckedMatch = line.text.match(UNCHECKED_TASK_LINE_REGEX);
				if (uncheckedMatch) {
					const title = normalizeTaskText(uncheckedMatch[2] ?? '');
					if (title) {
						builder.add(
							line.to,
							line.to,
							Decoration.widget({
								side: 1,
								widget: new ConvertTaskWidget(plugin, line.number, title),
							}),
						);
					}
				}
			}

			if (line.to >= range.to) {
				break;
			}
			position = line.to + 1;
		}
	}

	return builder.finish();
}

class ConvertTaskWidget extends WidgetType {
	private readonly plugin: TaskTodoistPlugin;
	private readonly lineNumber: number;
	private readonly taskTitle: string;

	constructor(plugin: TaskTodoistPlugin, lineNumber: number, taskTitle: string) {
		super();
		this.plugin = plugin;
		this.lineNumber = lineNumber;
		this.taskTitle = taskTitle;
	}

	toDOM(): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'task-todoist-convert-button';
		button.textContent = '↗';
		button.title = 'Convert to task note';
		button.setAttribute('aria-label', 'Convert to task note');
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.plugin.convertChecklistLineInActiveEditor(this.lineNumber, this.taskTitle);
		});
		return button;
	}
}

class LinkedTaskMetaWidget extends WidgetType {
	private readonly metaSummary: string;

	constructor(metaSummary: string) {
		super();
		this.metaSummary = metaSummary;
	}

	eq(other: LinkedTaskMetaWidget): boolean {
		return this.metaSummary === other.metaSummary;
	}

	toDOM(): HTMLElement {
		const meta = document.createElement('span');
		meta.className = 'task-todoist-linked-inline';
		meta.textContent = this.metaSummary;
		return meta;
	}
}

function normalizeTaskText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function readLinkedTaskStatusMap(docText: string): Map<string, boolean> {
	const map = new Map<string, boolean>();
	const lines = docText.split('\n');
	for (const line of lines) {
		const match = line.match(LINKED_TASK_LINE_REGEX);
		if (!match) {
			continue;
		}
		const checkedMark = (match[0].match(/\[([ xX])\]/)?.[1] ?? ' ').toLowerCase();
		const isChecked = checkedMark === 'x';
		const linkTarget = match[3] ?? '';
		if (!linkTarget) {
			continue;
		}
		map.set(linkTarget, isChecked);
	}
	return map;
}

function handleLinkedTaskClick(event: MouseEvent, view: EditorView, plugin: TaskTodoistPlugin): boolean {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return false;
	}
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	const clickable = target.closest('.cm-hmd-internal-link, .internal-link, .task-todoist-linked-inline');
	if (!(clickable instanceof HTMLElement)) {
		return false;
	}

	let position: number;
	try {
		position = view.posAtDOM(clickable, 0);
	} catch {
		return false;
	}

	const line = view.state.doc.lineAt(position);
	const match = line.text.match(LINKED_TASK_LINE_REGEX);
	if (!match) {
		return false;
	}

	const linkTarget = match[3] ?? '';
	if (!linkTarget) {
		return false;
	}

	event.preventDefault();
	event.stopPropagation();
	if ('stopImmediatePropagation' in event) {
		event.stopImmediatePropagation();
	}
	plugin.handleTaskLinkInteraction(linkTarget, plugin.app.workspace.getActiveFile()?.path ?? '');
	return true;
}
