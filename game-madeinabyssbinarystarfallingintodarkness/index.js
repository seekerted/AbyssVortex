const path = require('path');
const { fs, log, util, selectors } = require('vortex-api');
const { spawnSync } = require('child_process');
var crypto = require('crypto');

const GAME_NEXUS_ID = 'madeinabyssbinarystarfallingintodarkness';
const GAME_NAME = 'Made in Abyss: Binary Star Falling into Darkness';
const GAME_STEAM_ID = '1324340';

const VALID_EXTENSIONS = ['.pak', '.txt', '.dll', '.ini', '.lua'];

const NOTIF_MIABSFD_PAK_CONFLICT = 'miabsfd-pak-conflict';

function main(context) {
	context.registerGame({
		id: GAME_NEXUS_ID,
		name: GAME_NAME,
		mergeMods: true,
		queryPath: findGame,
		supportedTools: [],
		queryModPath: () => '.',
		logo: 'assets/gameart.jpg',
		executable: () => 'MadeInAbyss.exe',
		requiredFiles: [
		  'MadeInAbyss.exe',
		  'MadeInAbyss-BSFD/Binaries/Win64/MadeInAbyss-Win64-Shipping.exe',
		],
		setup: prepareForModding,
		environment: {
		  SteamAPPId: GAME_STEAM_ID,
		},
		details: {
		  steamAppId: GAME_STEAM_ID,
		},
	});

	context.registerInstaller('miabsfd-mod', 25, testSupportedContent, installContent);

	context.api.onAsync('did-deploy', (profileId, newDeployment) => checkPakCompatibility(profileId, newDeployment, context));
	
	return true;
}

// Check if there is more than one pak mod that modifies the same file.
async function checkPakCompatibility(profileId, newDeployment, context) {
	const state = context.api.getState();

	const gameId = selectors.profileById(state, profileId)?.gameId;
	if (GAME_NEXUS_ID !== gameId) {
		return Promise.resolve();
	}

	const extensionPath = selectors.gameById(state, GAME_NEXUS_ID).extensionPath;
	const pakModsFolder = path.join(selectors.discoveryByGame(state, GAME_NEXUS_ID).path, 'MadeInAbyss-BSFD', 'Content', 'Paks');
	const program = path.join(extensionPath, 'assets', 'repak.exe');

	const skipFiles = ['MadeInAbyss-BSFD-WindowsNoEditor.pak', 'MadeInAbyss-BSFD-WindowsNoEditor_0_P.pak'];

	const paks = await fs.readdirAsync(pakModsFolder);

	let pakCompatibilityList = {};

	// Retrieve the file list of each pak mod (using an external tool)
	// Create a dictionary of game files (string) -> pak mods that have that file (string[])
	for (let p of paks) {
		if (skipFiles.includes(p) || '.pak' !== path.extname(p)) continue;

		const pakPath = path.join(pakModsFolder, p);

		// Apologies, I do not know enough about async js to get this to work async.
		// Running spawnSync on a for loop shouldn't take too long... I hope.
		const process = spawnSync(program, ['list', pakPath], {
			encoding: 'utf8',
		});
		process.stdout.split('\n').forEach(f => {
			if (!f) return;

			if (f in pakCompatibilityList) {
				pakCompatibilityList[f].push(p);
			} else {
				pakCompatibilityList[f] = [p];
			}
		});
	}

	const conflictReport = {};
	const pakListHashes = {};

	// Just give a quick string representation of a list of strings of pak mods
	const hashFromPakList = (pakList) => {
		return crypto.createHash('sha1').update(pakList.sort().join(',')).digest('base64');
	};

	// Reverse the dictionary such that it is now list of pak mods (string hash representation) -> game files (string[])
	for (let [k, v] of Object.entries(pakCompatibilityList)) {
		// Remove entries that have only one mod per game file (no conflicts found)
		if (v.length <= 1) continue;

		const pakListHash = hashFromPakList(v);

		if (pakListHash in conflictReport) {
			conflictReport[pakListHash].push(k);
		} else {
			conflictReport[pakListHash] = [k];
			pakListHashes[pakListHash] = v;
		}
	}

	context.api.dismissNotification(NOTIF_MIABSFD_PAK_CONFLICT);

	if (Object.keys(conflictReport).length > 0) {
		context.api.sendNotification({
			id: NOTIF_MIABSFD_PAK_CONFLICT,
			type: 'warning',
			title: 'Pak mod conflicts detected.',
			actions: [{
				title: 'See Report',
				action: () => showConflictReport(context, conflictReport, pakListHashes),
			}, {
				title: 'Ignore',
				action: dismiss => dismiss(),
			}],
		});
	}

	return Promise.resolve();
}

function showConflictReport(context, report, hashes) {
	let header = 'The following pak mods modify the same file.\n' +
		'While you can still play the game, it is best to resolve conflicts to ensure that things may work properly.\n\n' +
		'To resolve conflicts, for each group below, ensure that only one mod is enabled.\n' +
		'Pak mod compatibility checking is done on every deploy.';
	let readableReport = '';

	// Format readable report as:
	// [list of pak mods]
	//     - [list of game files they both manipulate]
	// (repeat)
	for (let [k, v] of Object.entries(report)) {
		const pakList = hashes[k];
		pakList.forEach(p => {
			readableReport += p + '\n';
		});

		v.forEach(f => {
			readableReport += '\t- [...]' + path.sep + path.basename(f) + '\n';
		});

		readableReport += '\n';
	}

	context.api.showDialog('info', 'Conflict Report', {
		text: header,
		message: readableReport,
	}, [{
		label: 'Close',
	}]);
}

// The game is only available to be modded on Steam
function findGame() {
	return util.GameStoreHelper.findByAppId(GAME_STEAM_ID).then(game => game.gamePath);
}

// Directories where we'll be placing files
async function prepareForModding(discovery) {
	await fs.ensureDirWritableAsync(path.join(discovery.path, 'MadeInAbyss-BSFD', 'Content', 'Paks'));
	await fs.ensureDirWritableAsync(path.join(discovery.path, 'MadeInAbyss-BSFD', 'Content', 'Paks', 'LogicMods'));
	await fs.ensureDirWritableAsync(path.join(discovery.path, 'MadeInAbyss-BSFD', 'Binaries', 'Win64', 'Mods'));
}

// Mods can either be a UE4SS Lua mod, a UE4SS Blueprint mod, or a pak mod.
function testSupportedContent(files, gameId) {
	// If it's not MiABSFD, it's already unsupported.
	if (GAME_NEXUS_ID !== gameId) {
		return Promise.resolve({
			supported: false,
			requiredFiles: [],
		});
	}

	let isLuaMod = false;

	// Check if UE4SS Lua mod:
	// Both Mods/*/Scripts/main.lua and Mods/*/enabled.txt must exist
	let luaMainFile = files.find(
		f => path.basename(f) === 'main.lua' &&
		path.basename(path.dirname(f)) === 'Scripts' &&
		path.basename(path.dirname(path.dirname(path.dirname(f)))) === 'Mods'
	);
	if (luaMainFile) {
		const modFolder = path.dirname(path.dirname(luaMainFile));

		const enabledTxt = path.join(modFolder, 'enabled.txt');

		isLuaMod = files.includes(enabledTxt);
	}

	// If a file ends with .pak, it's either a BP or pak mod.
	let isPakMod = files.some(f => path.extname(f).toLowerCase() === '.pak');

	// Special case for UE4SS (it doesn't have the enabled.txt files)
	let isUE4SS = files.some(f => path.basename(f) === 'UE4SS.dll');

	return Promise.resolve({
		supported: isUE4SS || isLuaMod || isPakMod,
		requiredFiles: [],
	});
}

// For UE4SS Lua mods / UE4SS:
// Move all files (that are not .pak files) from the directory where the Mods folder is located in, to MadeInAbyss-BSFD\Binaries\Win64
// For UE4SS BP mods:
// Move all .pak files that are located inside a LogicMods folder, to MadeInAbyss-BSFD\Content\Paks\LogicMods
// For Pak mods:
// Move all .pak files that are not located inside a Logic Mods folder, to MadeInAbyss-BSFD\Content\Paks
function installContent(files) {
	let instructions = [];

	const isLuaMod = files.some(f => path.basename(f) === 'main.lua');
	let idx;
	if (isLuaMod) {
		const modFolder = files.find(f => path.basename(f) === 'Mods')
		idx = modFolder.indexOf(path.basename(modFolder));
	}

	for (let f of files) {
		// Only copy files that are among the valid extensions.
		// Fixes the "not part of the archive" error.
		if (!VALID_EXTENSIONS.includes(path.extname(f).toLowerCase())) continue;

		if ('.pak' === path.extname(f).toLowerCase()) {
			let parentFolder = path.basename(path.dirname(f));

			if ('LogicMods' === parentFolder) {
				// Blueprint mod

				instructions.push({
					type: 'copy',
					source: f,
					destination: path.join("MadeInAbyss-BSFD", "Content", "Paks", "LogicMods", path.basename(f)),
				});
			} else {
				// Pak mod

				instructions.push({
					type: 'copy',
					source: f,
					destination: path.join("MadeInAbyss-BSFD", "Content", "Paks", path.basename(f)),
				});
			}
		} else {
			// Lua mod
			if (!isLuaMod || idx == null) continue;

			instructions.push({
				type: 'copy',
				source: f,
				destination: path.join("MadeInAbyss-BSFD", "Binaries", "Win64", path.join(f.substr(idx))),
			});
		}
	}

	return Promise.resolve({ instructions });
}

module.exports = {
    default: main,
};