/**
 * 自动截图的持久层（**独立 IDB**）。
 *
 * ★ 为什么不并进 `storage/db.ts`：主库的迁移分支里有
 *   `if (from < 3) { 删除 accounts }`，而主库版本号是 2 —— 一升级就会把
 *   accounts 缓存（离线副本）真的删掉。截图数据体量大、生命周期也完全不同，
 *   单独一个库既不用碰迁移，也不会和账号缓存互相拖累。
 *
 * ★ 谁写谁读：
 *   · 写：只由 background（`core/shot-capture.ts`）写 —— 截图 blob 只有它能产出
 *   · 读：UI 页直接读（`chrome-extension://` 同源），图片字节因此**不必走消息**，
 *     否则每帧几十 KB 的 base64 会把 runtime 通道和 UI 一起拖慢
 */
import { SHOT_DB_NAME, SHOT_DB_VERSION, SHOT_STORE_SESSIONS, SHOT_STORE_STEPS } from '../shared/constants';
import type { ShotSessionMeta, ShotStepRecord } from '../shared/types';

let dbPromise: Promise<IDBDatabase> | null = null;

function openShotDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(SHOT_DB_NAME, SHOT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SHOT_STORE_SESSIONS)) {
        db.createObjectStore(SHOT_STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SHOT_STORE_STEPS)) {
        const steps = db.createObjectStore(SHOT_STORE_STEPS, { keyPath: 'id' });
        // 一次录制 = 一个 sessionId；时间线按它一次读完，别做 N+1
        steps.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开截图数据库'));
    // 被别的扩展页占着旧版本时不要永远挂起：明确报错，UI 才能提示「关掉其它标签页」
    req.onblocked = () => reject(new Error('截图数据库被其它扩展页占用，请关闭后重试'));
  });
  return dbPromise;
}

function request<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openShotDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = run(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('截图数据库操作失败'));
      }),
  );
}

export const shotDb = {
  async listSessions(): Promise<ShotSessionMeta[]> {
    const rows = await request<ShotSessionMeta[]>(SHOT_STORE_SESSIONS, 'readonly', (s) => s.getAll());
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  },

  async getSession(id: string): Promise<ShotSessionMeta | undefined> {
    return await request<ShotSessionMeta | undefined>(SHOT_STORE_SESSIONS, 'readonly', (s) => s.get(id));
  },

  async putSession(row: ShotSessionMeta): Promise<void> {
    await request(SHOT_STORE_SESSIONS, 'readwrite', (s) => s.put(row));
  },

  async listSteps(sessionId: string): Promise<ShotStepRecord[]> {
    const rows = await request<ShotStepRecord[]>(SHOT_STORE_STEPS, 'readonly', (s) =>
      s.index('sessionId').getAll(sessionId),
    );
    return rows.sort((a, b) => a.seq - b.seq);
  },

  async getStep(id: string): Promise<ShotStepRecord | undefined> {
    return await request<ShotStepRecord | undefined>(SHOT_STORE_STEPS, 'readonly', (s) => s.get(id));
  },

  async putStep(row: ShotStepRecord): Promise<void> {
    await request(SHOT_STORE_STEPS, 'readwrite', (s) => s.put(row));
  },

  async deleteStep(id: string): Promise<void> {
    await request(SHOT_STORE_STEPS, 'readwrite', (s) => s.delete(id));
  },

  /** 删一次录制：会话行 + 它的全部帧（图片随帧一起被回收，不留孤儿 blob） */
  async deleteSession(id: string): Promise<void> {
    const db = await openShotDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SHOT_STORE_SESSIONS, SHOT_STORE_STEPS], 'readwrite');
      tx.objectStore(SHOT_STORE_SESSIONS).delete(id);
      const steps = tx.objectStore(SHOT_STORE_STEPS);
      const cursorReq = steps.index('sessionId').openKeyCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur) {
          steps.delete(cur.primaryKey);
          cur.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('删除录制失败'));
    });
  },
};
