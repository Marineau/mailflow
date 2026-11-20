/**
 * Saves every attachment of one message into a new folder the user picks.
 * Names are cleaned for Windows: no reserved device names, no path separators.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface DownloadWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface DownloadFileHandle {
  createWritable(): Promise<DownloadWritable>;
}

export interface DownloadFolder {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<DownloadFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DownloadFolder>;
}

type DirectoryPicker = (options: {
  mode: 'readwrite';
  id: string;
  startIn: 'downloads';
}) => Promise<DownloadFolder>;

export function directoryPicker(): DirectoryPicker | null {
  const host = window as Window & { showDirectoryPicker?: DirectoryPicker };
  if (typeof host.showDirectoryPicker !== 'function') return null;
  return host.showDirectoryPicker.bind(window);
}

export function isPickerCancel(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError');
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export function safeFolderName(label: string): string {
  const cleaned = label
    // Control characters are among those Windows refuses in a file name.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  const name = !cleaned || RESERVED.test(cleaned) ? 'pieces-jointes' : cleaned;
  return name.slice(0, 80);
}

export function safeDownloadName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  const dot = cleaned.lastIndexOf('.');
  const hasExt = dot > 0 && cleaned.length - dot <= 12;
  const ext = hasExt ? cleaned.slice(dot).toLowerCase() : '';
  let stem = hasExt ? cleaned.slice(0, dot) : cleaned;
  if (!stem || RESERVED.test(stem)) stem = 'piece-jointe';
  const maxStem = Math.max(1, 180 - ext.length);
  return `${stem.slice(0, maxStem)}${ext}`;
}

export function* folderNameCandidates(label: string): Generator<string> {
  const base = safeFolderName(label);
  yield base;
  for (let index = 2; index < 200; index += 1) {
    const suffix = ` (${index})`;
    yield `${base.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
  }
}

export function* fileNameCandidates(filename: string): Generator<string> {
  const safe = safeDownloadName(filename);
  yield safe;
  const dot = safe.lastIndexOf('.');
  const hasExt = dot > 0;
  const ext = hasExt ? safe.slice(dot) : '';
  const stem = hasExt ? safe.slice(0, dot) : safe;
  for (let index = 2; index < 200; index += 1) {
    const suffix = ` (${index})`;
    const maxStem = Math.max(1, 180 - ext.length - suffix.length);
    yield `${stem.slice(0, maxStem)}${suffix}${ext}`;
  }
}

export async function createDownloadFolder(
  parent: DownloadFolder,
  label: string,
): Promise<{ folder: DownloadFolder; createdName: string }> {
  for (const candidate of folderNameCandidates(label)) {
    try {
      await parent.getDirectoryHandle(candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const folder = await parent.getDirectoryHandle(candidate, { create: true });
      return { folder, createdName: candidate };
    }
  }
  throw new Error('Dossier indisponible');
}

export async function vacantFileName(
  dir: DownloadFolder,
  filename: string,
  reserved: Set<string>,
): Promise<string> {
  for (const candidate of fileNameCandidates(filename)) {
    const key = candidate.toLowerCase();
    if (reserved.has(key)) continue;
    try {
      await dir.getFileHandle(candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      reserved.add(key);
      return candidate;
    }
    reserved.add(key);
  }
  throw new Error('Nom de fichier indisponible');
}

export async function writeBlob(dir: DownloadFolder, name: string, blob: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The stream may already be closed.
    }
    throw error;
  }
}
