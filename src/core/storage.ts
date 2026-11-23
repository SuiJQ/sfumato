/**
 * IndexedDB 存储。这是本工具"唯一的后端"。
 *
 * 三张表：presets（预设）、luts（33³ LUT）、settings（界面状态）。
 */

import type { Preset } from './types';

export interface StoredPreset {
  id: string;
  name: string;
  preset: Preset;
  updatedAt: number;
}

export interface StoredLut {
  id: string;
  name: string;
  size: number;
  data: Uint8Array;
}

const DB_NAME = 'grain';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('luts')) db.createObjectStore('luts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开本地数据库'));
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        let result: T;
        // 写事务要等 complete：只在 request 成功时 resolve 会把
        // "提交阶段失败（配额/abort）"误报成成功
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error ?? new Error('数据库操作失败'));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error('数据库事务失败'));
        t.onabort = () => reject(t.error ?? new Error('数据库事务中止'));
      }),
  );
}

export function listPresets(): Promise<StoredPreset[]> {
  return tx<StoredPreset[]>('presets', 'readonly', (s) => s.getAll() as IDBRequest<StoredPreset[]>).then(
    (all) => all.sort((a, b) => b.updatedAt - a.updatedAt),
  );
}

export async function savePreset(name: string, preset: Preset): Promise<StoredPreset> {
  const record: StoredPreset = {
    id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    preset: { ...preset, name },
    updatedAt: Date.now(),
  };
  await tx('presets', 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>);
  return record;
}

export function deletePreset(id: string): Promise<void> {
  return tx('presets', 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export function listLuts(): Promise<StoredLut[]> {
  return tx<StoredLut[]>('luts', 'readonly', (s) => s.getAll() as IDBRequest<StoredLut[]>);
}

export async function saveLut(name: string, size: number, data: Uint8Array): Promise<StoredLut> {
  const record: StoredLut = {
    id: `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    size,
    data,
  };
  await tx('luts', 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>);
  return record;
}

export function deleteLut(id: string): Promise<void> {
  return tx('luts', 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export function getLut(id: string): Promise<StoredLut | undefined> {
  return tx<StoredLut | undefined>('luts', 'readonly', (s) => s.get(id) as IDBRequest<StoredLut | undefined>);
}