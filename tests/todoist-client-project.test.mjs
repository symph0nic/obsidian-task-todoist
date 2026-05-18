import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

async function loadTodoistClientWithRequestStub(requestStubSource) {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'task-todoist-test-'));
	const stubPath = path.join(tempDir, 'obsidian-stub.js');
	const outPath = path.join(tempDir, 'todoist-client.mjs');
	await writeFile(stubPath, `export const requestUrl = ${requestStubSource};\n`);
	await esbuild.build({
		entryPoints: [path.resolve('src/todoist-client.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		outfile: outPath,
		plugins: [{
			name: 'obsidian-stub',
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: stubPath }));
			}
		}],
	});
	const module = await import(pathToFileURL(outPath));
	return { ...module, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
}

test('createProject sends Todoist project_add and returns mapped project id', async () => {
	const { TodoistClient, cleanup } = await loadTodoistClientWithRequestStub(`async (options) => {
		const body = Object.fromEntries(new URLSearchParams(options.body));
		if (body.resource_types !== '["projects"]') {
			throw new Error(\`Expected project sync resource type, received \${body.resource_types}\`);
		}
		const commands = JSON.parse(body.commands);
		const addProjectCommand = commands.find((command) => command.type === 'project_add');
		if (!addProjectCommand) {
			throw new Error('Expected project_add command.');
		}
		if (addProjectCommand.args.name !== 'Edge Case Project') {
			throw new Error(\`Expected project name Edge Case Project, received \${addProjectCommand.args.name}\`);
		}
		return {
			status: 200,
			json: {
				sync_status: { [addProjectCommand.uuid]: 'ok' },
				temp_id_mapping: { [addProjectCommand.temp_id]: 'project-123' },
			},
		};
	}`);

	try {
		const client = new TodoistClient('token');
		const projectId = await client.createProject('Edge Case Project');

		assert.equal(projectId, 'project-123');
	} finally {
		await cleanup();
	}
});
