import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type TaskTodoistPlugin from './main';
import type { ArchiveMode, ImportProjectScope } from './settings';

export class TaskTodoistSettingTab extends PluginSettingTab {
	plugin: TaskTodoistPlugin;

	constructor(app: App, plugin: TaskTodoistPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Task note storage').setHeading();

		new Setting(containerEl)
			.setName('Task folder path')
			.setDesc('Folder where synced task notes are created.')
			.addText((text) => {
				text
					.setPlaceholder('Tasks')
					.setValue(this.plugin.settings.tasksFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.tasksFolderPath = value.trim() || 'Tasks';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 32;
			});

		new Setting(containerEl)
			.setName('Default task tag')
			.setDesc('Default tag added to task notes for easy bases filtering.')
			.addText((text) => {
				text
					.setPlaceholder('Tasks')
					.setValue(this.plugin.settings.defaultTaskTag)
					.onChange(async (value) => {
						this.plugin.settings.defaultTaskTag = value.trim() || 'tasks';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 24;
			});

		new Setting(containerEl)
			.setName('Auto-rename task files from title')
			.setDesc('When task title changes locally or in todoist, rename the note file to match.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoRenameTaskFiles).onChange(async (value) => {
					this.plugin.settings.autoRenameTaskFiles = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Archive mode')
			.setDesc('How to represent completed or deleted todoist tasks locally.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('none', 'Keep notes in place')
					.addOption('move-to-archive-folder', 'Move notes to archive folder')
					.addOption('mark-local-done', 'Only mark notes as done')
					.setValue(this.plugin.settings.archiveMode)
					.onChange(async (value) => {
						this.plugin.settings.archiveMode = value as ArchiveMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Archive folder path')
			.setDesc('Used when archive mode is set to move notes to archive folder.')
			.addText((text) => {
				text
					.setPlaceholder('Tasks/_archive')
					.setValue(this.plugin.settings.archiveFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.archiveFolderPath = value.trim() || 'Tasks/_archive';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 32;
			});

		new Setting(containerEl).setName('Auto import rules').setHeading();

		new Setting(containerEl)
			.setName('Enable auto import')
			.setDesc('Automatically create task notes for matching todoist tasks.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoImportEnabled).onChange(async (value) => {
					this.plugin.settings.autoImportEnabled = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Project scope')
			.setDesc('Choose whether to import from all projects or only named projects.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('all-projects', 'All projects')
					.addOption('allow-list-by-name', 'Allow list by project name')
					.setValue(this.plugin.settings.autoImportProjectScope)
					.onChange(async (value) => {
						this.plugin.settings.autoImportProjectScope = value as ImportProjectScope;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Allowed project names')
			.setDesc('Comma-separated names used when project scope is allow list.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Work, personal')
					.setValue(this.plugin.settings.autoImportAllowedProjectNames)
					.onChange(async (value) => {
						this.plugin.settings.autoImportAllowedProjectNames = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 2;
				textArea.inputEl.cols = 36;
			});

		new Setting(containerEl)
			.setName('Required todoist label')
			.setDesc('Only import tasks that include this label. Leave empty for no label filter.')
			.addText((text) => {
				text
					.setPlaceholder('Obsidian')
					.setValue(this.plugin.settings.autoImportRequiredLabel)
					.onChange(async (value) => {
						this.plugin.settings.autoImportRequiredLabel = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 20;
			});

		new Setting(containerEl)
			.setName('Assigned to me only')
			.setDesc('Only auto import tasks assigned to your todoist account.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoImportAssignedToMeOnly).onChange(async (value) => {
					this.plugin.settings.autoImportAssignedToMeOnly = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl).setName('Todoist connection').setHeading();

		const secureStorageText = this.plugin.isSecretStorageAvailable()
			? 'Token is stored in Obsidian secret storage.'
			: 'Obsidian secret storage is unavailable in this app version.';

		new Setting(containerEl)
			.setName('Token secret name')
			.setDesc('Name of the secret key used for the todoist API token.')
			.addText((text) => {
				text
					.setPlaceholder('Todoist API token key')
					.setValue(this.plugin.settings.todoistTokenSecretName)
					.onChange(async (value) => {
						await this.plugin.updateTodoistTokenSecretName(value);
					});
				text.inputEl.size = 24;
			});

		new Setting(containerEl)
			.setName('Todoist API token')
			.setDesc(secureStorageText)
			.addComponent((componentEl) => {
				return new SecretComponent(this.app, componentEl)
					.setValue(this.plugin.settings.todoistTokenSecretName)
					.onChange(async (value) => {
						await this.plugin.updateTodoistTokenSecretName(value);
						this.display();
					});
			})
			.setDisabled(!this.plugin.isSecretStorageAvailable());

		new Setting(containerEl)
			.setName('Connection check')
			.setDesc('Verify the configured token against the todoist API.')
			.addButton((button) => {
				button.setButtonText('Test connection').onClick(async () => {
					const result = await this.plugin.testTodoistConnection();
					const prefix = result.ok ? 'Success:' : 'Failed:';
					new Notice(`${prefix} ${result.message}`, 6000);
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('Last connection check')
			.setDesc(this.plugin.getLastConnectionCheckMessage());

		new Setting(containerEl).setName('Todoist sync').setHeading();

		new Setting(containerEl)
			.setName('Run sync now')
			.setDesc('Import todoist tasks and update task notes using current rules.')
			.addButton((button) => {
				button.setButtonText('Sync now').onClick(async () => {
					const result = await this.plugin.runImportSync();
					const prefix = result.ok ? 'Success:' : 'Failed:';
					new Notice(`${prefix} ${result.message}`, 8000);
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('Enable scheduled sync')
			.setDesc('Run sync automatically in the background.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
					await this.plugin.updateAutoSyncEnabled(value);
				});
			});

		new Setting(containerEl)
			.setName('Scheduled sync interval')
			.setDesc('Minutes between automatic sync runs.')
			.addText((text) => {
				text
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							await this.plugin.updateAutoSyncIntervalMinutes(parsed);
						}
					});
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '120';
				text.inputEl.size = 6;
			});

		new Setting(containerEl)
			.setName('Show scheduled sync notices')
			.setDesc('Show a notice after each automatic sync run.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showScheduledSyncNotices).onChange(async (value) => {
					this.plugin.settings.showScheduledSyncNotices = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Last sync')
			.setDesc(this.plugin.getLastSyncMessage());

		new Setting(containerEl).setName('Task tools').setHeading();

		new Setting(containerEl)
			.setName('Create task note')
			.setDesc('Open a modal to create a new task note in your task folder.')
			.addButton((button) => {
				button.setButtonText('Create task').onClick(() => {
					this.plugin.openCreateTaskModal();
				});
			});
	}
}
