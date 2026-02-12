import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, 'release');
const releaseFiles = ['main.js', 'manifest.json', 'styles.css'];

for (const file of releaseFiles) {
	const absolutePath = path.join(rootDir, file);
	try {
		await access(absolutePath);
	} catch {
		console.error(`Missing required artifact: ${file}`);
		console.error('Run `npm run build` first.');
		process.exit(1);
	}
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

for (const file of releaseFiles) {
	await cp(path.join(rootDir, file), path.join(releaseDir, file));
}

console.log(`Packaged release artifacts in ${releaseDir}`);
