import { App, Modal, Notice, Setting } from 'obsidian';
import type TaskTodoistPlugin from './main';

export class CreateTaskModal extends Modal {
	private readonly plugin: TaskTodoistPlugin;
	private readonly initialTitle: string;
	private title = '';
	private description = '';
	private parentTaskLink = '';
	private todoistProjectName = '';
	private todoistSectionName = '';
	private todoistDueDate = '';
	private todoistRecurrence = '';
	private todoistSync = true;

	constructor(app: App, plugin: TaskTodoistPlugin, initialTitle = '') {
		super(app);
		this.plugin = plugin;
		this.initialTitle = initialTitle.trim();
		this.title = this.initialTitle;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Create task note');

		new Setting(contentEl)
			.setName('Title')
			.setDesc('Task title for the new task note.')
			.addText((text) => {
				text
					.setPlaceholder('Task title')
					.setValue(this.title)
					.onChange((value) => {
						this.title = value;
					});
				text.inputEl.size = 36;
				window.setTimeout(() => text.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.setName('Description')
			.setDesc('Optional Markdown description in the task note body.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Optional details')
					.setValue(this.description)
					.onChange((value) => {
						this.description = value;
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 40;
			});

		new Setting(contentEl)
			.setName('Parent task link')
			.setDesc('Optional parent task wiki link, for subtask grouping in bases.')
				.addText((text) => {
					text
						.setPlaceholder('Parent task wiki link')
						.setValue(this.parentTaskLink)
					.onChange((value) => {
						this.parentTaskLink = value;
					});
				text.inputEl.size = 36;
			});

		new Setting(contentEl)
			.setName('Todoist project')
			.setDesc('Optional project name. Will map to todoist project on sync.')
			.addText((text) => {
				text
					.setPlaceholder('Work')
					.setValue(this.todoistProjectName)
					.onChange((value) => {
						this.todoistProjectName = value;
					});
				text.inputEl.size = 28;
			});

		new Setting(contentEl)
			.setName('Todoist section')
			.setDesc('Optional section name within the selected project.')
			.addText((text) => {
				text
					.setPlaceholder('Urgent')
					.setValue(this.todoistSectionName)
					.onChange((value) => {
						this.todoistSectionName = value;
					});
				text.inputEl.size = 28;
			});

		new Setting(contentEl)
			.setName('Due date')
			.setDesc('Optional due date.')
			.addText((text) => {
				text
					.setValue(this.todoistDueDate)
					.onChange((value) => {
						this.todoistDueDate = value;
					});
				text.inputEl.type = 'date';
				text.inputEl.size = 24;
			});

		new Setting(contentEl)
			.setName('Recurrence')
			.setDesc('Optional todoist recurrence rule, e.g. "every weekday".')
				.addText((text) => {
					text
						.setPlaceholder('Every weekday')
						.setValue(this.todoistRecurrence)
					.onChange((value) => {
						this.todoistRecurrence = value;
					});
				text.inputEl.size = 28;
			});

		new Setting(contentEl)
			.setName('Sync with todoist')
			.setDesc('Marks this task note as eligible for todoist sync.')
			.addToggle((toggle) => {
				toggle.setValue(this.todoistSync).onChange((value) => {
					this.todoistSync = value;
				});
			});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Create task').setCta().onClick(async () => {
					await this.handleCreate();
				});
			})
			.addExtraButton((button) => {
				button.setIcon('cross').setTooltip('Cancel').onClick(() => {
					this.close();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async handleCreate(): Promise<void> {
		const trimmedTitle = this.title.trim();
		if (!trimmedTitle) {
			new Notice('Task title is required.', 4000);
			return;
		}

		const createdFile = await this.plugin.createTaskNote({
			title: trimmedTitle,
			description: this.description,
			parentTaskLink: this.parentTaskLink,
			todoistSync: this.todoistSync,
			todoistProjectName: this.todoistProjectName,
			todoistSectionName: this.todoistSectionName,
			todoistDueDate: this.todoistDueDate,
			todoistDueString: this.todoistRecurrence,
		});
		new Notice(`Created task note: ${createdFile.basename}`, 5000);
		this.close();
	}
}
