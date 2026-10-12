/**
 * ============================================================================
 * Litefin Web Plugin - Automated Packaging Script
 * ============================================================================
 * Automates compiling the web client bundle, publishing the .NET 8 server plugin,
 * bundling assets, creating the release zip, calculating MD5 checksums,
 * and generating/updating the standalone Jellyfin repository manifest.
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ============================================================================
// 1. Version and Argument Parsing
// ============================================================================
// Read single-source-of-truth version directly from package.json
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version || '1.0.0';

// Parse command line arguments
const args = process.argv.slice(2);
const changelogArg = args.find((a) => a.startsWith('--changelog='));
let changelog = changelogArg ? changelogArg.replace('--changelog=', '').trim() : '';

// Check environment variable fallback for CI/CD runners
if (!changelog && process.env.CHANGELOG) {
    changelog = process.env.CHANGELOG.trim();
}

// If no explicit changelog is passed, attempt git log extraction or default to release note
if (!changelog) {
    try {
        const prevTag = execSync('git describe --tags --abbrev=0 HEAD^ 2>nul || git rev-list --max-parents=0 HEAD', {
            cwd: rootDir,
            encoding: 'utf8'
        }).trim();

        const gitLog = execSync(`git log ${prevTag}..HEAD --pretty=format:"- %s"`, {
            cwd: rootDir,
            encoding: 'utf8'
        }).trim();

        changelog = gitLog || `Release ${version}`;
    } catch {
        changelog = `Release ${version}`;
    }
}

console.log(`\n======================================================`);
console.log(` Packaging Litefin Web Server Plugin v${version}`);
console.log(`======================================================\n`);

// ============================================================================
// 2. Build the Web Client (Modern Webpack Target)
// ============================================================================
// Compiles client code with MoviVideoPlayer and movi.wasm WebAssembly binary
console.log('>>> [1/5] Compiling Litefin web client bundle...');
try {
    execSync('npx webpack --config webpack.config.cjs --config-name web', {
        cwd: rootDir,
        stdio: 'inherit'
    });
} catch (err) {
    console.error('Failed to compile web bundle:', err);
    process.exit(1);
}

const distWebDir = path.join(rootDir, 'dist', 'web');
if (!fs.existsSync(distWebDir) || !fs.existsSync(path.join(distWebDir, 'index.html'))) {
    console.error('Build output dist/web/index.html was not found!');
    process.exit(1);
}

// ============================================================================
// 3. Compile and Publish .NET Server Plugin
// ============================================================================
// Publishes Litefin.Web.dll targeting net8.0
console.log('\n>>> [2/5] Publishing .NET server plugin...');
const csprojPath = path.join(rootDir, 'server-plugin', 'Litefin.Web.csproj');
const publishDir = path.join(rootDir, 'server-plugin', 'bin', 'Release', 'net8.0', 'publish');

if (fs.existsSync(publishDir)) {
    fs.rmSync(publishDir, { recursive: true, force: true });
}

try {
    execSync(
        `dotnet publish "${csprojPath}" -c Release -o "${publishDir}" -p:Version=${version} -p:AssemblyVersion=${version}.0 -p:FileVersion=${version}.0`,
        {
            cwd: rootDir,
            stdio: 'inherit'
        }
    );
} catch (err) {
    console.error('Failed to publish .NET plugin assembly:', err);
    process.exit(1);
}

// ============================================================================
// 4. Bundle Web Assets and Meta Information
// ============================================================================
// Copy dist/web into the publish folder under web/
console.log('\n>>> [3/5] Bundling web client assets into plugin directory...');
const targetWebDir = path.join(publishDir, 'web');
if (fs.existsSync(targetWebDir)) {
    fs.rmSync(targetWebDir, { recursive: true, force: true });
}
fs.cpSync(distWebDir, targetWebDir, { recursive: true });

// Copy icon_oblong.png into plugin package root
const iconOblongSrc = path.join(rootDir, 'assets', 'icon_oblong.png');
if (fs.existsSync(iconOblongSrc)) {
    fs.copyFileSync(iconOblongSrc, path.join(publishDir, 'icon_oblong.png'));
}

// Write meta.json for Jellyfin plugin discovery and catalog metadata
const pluginGuid = 'b4a2c918-7e3f-4d92-a1b8-6e54f0a9d123';
const timestamp = new Date().toISOString();

const meta = {
    category: 'General',
    changelog: changelog,
    description: 'Embedded modern Litefin client with Movi WebAssembly video player.',
    guid: pluginGuid,
    name: 'Litefin Web',
    overview: 'Access Litefin directly in your browser at /litefin.',
    owner: 'MoazSalem',
    imageUrl: 'https://raw.githubusercontent.com/MoazSalem/litefin/development/assets/icon_oblong.png',
    targetAbi: '10.10.0.0',
    timestamp: timestamp,
    version: version,
    status: 'Active',
    autoUpdate: true,
    assemblies: ['Litefin.Web.dll']
};

fs.writeFileSync(path.join(publishDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

// ============================================================================
// 5. Create Plugin Release ZIP Archive
// ============================================================================
console.log('\n>>> [4/5] Compressing plugin release archive...');
const zipName = `Litefin.Web.Plugin_${version}.zip`;
const zipPath = path.join(rootDir, zipName);

if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
}

await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(publishDir, false);
    archive.finalize();
});

console.log(`Created archive: ${zipName} (${fs.statSync(zipPath).size} bytes)`);

// ============================================================================
// 6. Calculate MD5 Checksum and Update Repository Manifest
// ============================================================================
console.log('\n>>> [5/5] Updating litefin-plugin-manifest.json...');
const zipBuffer = fs.readFileSync(zipPath);
const md5Hash = crypto.createHash('md5').update(zipBuffer).digest('hex');

console.log(`MD5 Checksum: ${md5Hash}`);

const manifestPath = path.join(rootDir, 'litefin-plugin-manifest.json');
let manifest = [];

if (fs.existsSync(manifestPath)) {
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        console.warn('Could not parse existing manifest, generating a new one.');
        manifest = [];
    }
}

// Find existing plugin entry or create a fresh entry
let pluginEntry = manifest.find((item) => item.guid === pluginGuid);
if (!pluginEntry) {
    pluginEntry = {
        guid: pluginGuid,
        name: 'Litefin Web',
        description: 'Embedded modern Litefin client with Movi WebAssembly video player.',
        overview: 'Access Litefin directly in your browser at /litefin.',
        owner: 'MoazSalem',
        category: 'General',
        imageUrl: 'https://raw.githubusercontent.com/MoazSalem/litefin/development/assets/icon_oblong.png',
        versions: []
    };
    manifest.unshift(pluginEntry);
} else {
    // Ensure the preview image points to icon_oblong.png
    pluginEntry.imageUrl = 'https://raw.githubusercontent.com/MoazSalem/litefin/development/assets/icon_oblong.png';
}

// Remove any existing entry for this exact version to allow idempotence
pluginEntry.versions = (pluginEntry.versions || []).filter((v) => v.version !== version);

// Prepend the new version to the versions list
const versionEntry = {
    version: version,
    changelog: changelog,
    targetAbi: '10.10.0.0',
    sourceUrl: `https://github.com/MoazSalem/litefin/releases/download/v${version}/${zipName}`,
    checksum: md5Hash,
    timestamp: timestamp
};

pluginEntry.versions.unshift(versionEntry);

// Format and save updated manifest
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Manifest updated at: ${manifestPath}`);

console.log('\n======================================================');
console.log(' Build and packaging completed successfully!');
console.log(` Plugin Archive: ${zipName}`);
console.log(` Manifest: litefin-plugin-manifest.json`);
console.log('======================================================\n');
