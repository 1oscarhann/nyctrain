/**
 * IndexedDB storage: an autosave plus three manual slots. Export/import as JSON files.
 */
import { migrate } from './migrate';
import type { SaveFile } from './format';

const DB = 'headway-ny';
const STORE = 'saves';
export const SLOTS = ['autosave', 'slot1', 'slot2', 'slot3'] as const;
export type SlotId = (typeof SLOTS)[number];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function writeSlot(slot: SlotId, save: SaveFile): Promise<void> {
  await tx('readwrite', (s) => s.put(save, slot));
}

export async function readSlot(slot: SlotId): Promise<SaveFile | null> {
  try {
    const raw = await tx('readonly', (s) => s.get(slot));
    return raw ? migrate(raw) : null;
  } catch {
    return null;
  }
}

export async function deleteSlot(slot: SlotId): Promise<void> {
  await tx('readwrite', (s) => s.delete(slot));
}

export async function listSlots(): Promise<Record<SlotId, SaveFile['meta'] | null>> {
  const out = {} as Record<SlotId, SaveFile['meta'] | null>;
  for (const slot of SLOTS) out[slot] = (await readSlot(slot))?.meta ?? null;
  return out;
}

export function exportFile(save: SaveFile): void {
  const blob = new Blob([JSON.stringify(save)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `headway-${save.city ?? 'nyc'}-day${save.meta.day + 1}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function importFile(): Promise<SaveFile> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('No file chosen'));
      try {
        resolve(migrate(JSON.parse(await f.text())));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
