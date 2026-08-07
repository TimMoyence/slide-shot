// Dialogues macOS natifs via osascript (AppleScript) et Finder.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

function appleScriptString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Erreur dont le message est ecrit pour l'utilisateur.
 *
 * Ces echecs remontent en 500, que le serveur masque par defaut derriere
 * « Erreur interne du serveur ». `expose` dit que ce message-la, redige en
 * francais et explicite sur ce qui a echoue, doit lui parvenir tel quel — au
 * contraire d'un rejet fortuit (`spawn osascript ENOENT`), qui reste masque.
 */
function userFacingError(message) {
  const err = new Error(message);
  err.expose = true;
  return err;
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        if (/user canceled/i.test(stderr)) {
          resolve(null);
          return;
        }
        reject(userFacingError(`Erreur AppleScript : ${stderr.trim() || 'erreur inconnue'}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function defaultLocationClause(defaultPath) {
  if (!defaultPath) return '';
  try {
    await stat(defaultPath);
    return ` default location (POSIX file ${appleScriptString(defaultPath)})`;
  } catch {
    return '';
  }
}

/** @returns {Promise<string|null>} chemin POSIX, ou null si annule */
export async function chooseFolder(defaultPath) {
  const clause = await defaultLocationClause(defaultPath);
  const prompt = appleScriptString('Choisir un dossier de destination');
  const script = `POSIX path of (choose folder with prompt ${prompt}${clause})`;
  return runOsascript(script);
}

/** Dialogue filtre sur les PDF. @returns {Promise<string|null>} */
export async function chooseFile(defaultPath) {
  const clause = await defaultLocationClause(defaultPath);
  const prompt = appleScriptString('Choisir un fichier PDF');
  const script = `POSIX path of (choose file with prompt ${prompt} of type {"pdf"}${clause})`;
  return runOsascript(script);
}

/** Revele un fichier ou dossier dans le Finder. */
export async function reveal(targetPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('open', ['-R', targetPath]);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          userFacingError(
            `Impossible de révéler « ${targetPath} » dans le Finder : ${stderr.trim() || 'erreur inconnue'}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
