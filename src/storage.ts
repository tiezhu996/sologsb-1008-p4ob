import type {
  CommentsRecord,
  PendingJournal,
  PendingUnit,
  ProjectMetaRecord,
  SignCorePayload,
  SignItem,
  SignProject,
  SignRecord,
  TermsRecord,
  VersionSnapshot,
  VersionsRecord,
} from "./types";

/**
 * 分区存储引擎。
 *
 * - 项目拆成 标识 / 术语 / 审校意见 三类分区记录（版本快照单独成区），
 *   按标识分键落盘，不再一次保存整份数据；
 * - 版本快照与当前内容共用同一修订号，元信息记录最后一份完整修订；
 * - 每次修订先整体落入待处理区（写前日志），再逐键提交，提交完成才清除；
 *   页面中断后重新打开时从待处理区接着恢复；
 * - 容量不足时按标识分批归档已确认快照再继续；仍写不进去就回滚到上一份
 *   完整修订（按日志里的 prev 逐键还原）；
 * - 旧版整包数据（schema 1）首次打开时原位升级为分区记录，升级事务同样
 *   走待处理区，失败则旧数据原样保留，不会只剩半份单位或丢掉版本。
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LEGACY_STORAGE_KEY = "sologsb-1008-project-v1";

/** 新快照落盘前的修订号哨兵：持久化时由引擎盖上正式修订号；旧版数据升级为 0 */
export const PENDING_REVISION = -1;

const PREFIX = "sologsb-1008-project-v2";
const META_KEY = `${PREFIX}:meta`;
const PENDING_KEY = `${PREFIX}:pending`;
const signKey = (signId: string) => `${PREFIX}:sign:${signId}`;
const termsKey = (signId: string) => `${PREFIX}:terms:${signId}`;
const commentsKey = (signId: string) => `${PREFIX}:comments:${signId}`;
const versionsKey = (signId: string) => `${PREFIX}:versions:${signId}`;

interface ArchivedBatch {
  signId: string;
  count: number;
}

export interface LoadOutcome {
  project: SignProject;
  revision: number;
  /** 没有任何已存数据，使用传入的示例项目 */
  fresh: boolean;
  /** 旧版整包数据已原位升级为分区存储 */
  migrated: boolean;
  /** 升级因容量不足被延后：旧数据未动，下次写入时重试 */
  migrationDeferred: boolean;
  /** 检测到中断的写入并作了处理（恢复或回滚） */
  recovered: boolean;
  /** 中断的写入无法完成，已回滚到上一份完整修订 */
  rolledBack: boolean;
  /** 本次加载过程中归档的已确认快照总数 */
  archivedTotal: number;
}

export interface PersistOutcome {
  ok: boolean;
  /** 是否有实际内容变化（无变化时不产生新修订） */
  changed: boolean;
  revision: number;
  archivedTotal: number;
  /** 写入失败，存储已回滚到上一份完整修订 */
  rolledBack: boolean;
}

export interface ProjectStore {
  load(fallback: SignProject): LoadOutcome;
  persist(project: SignProject): PersistOutcome;
  /** 上一份完整修订的内容（回滚后用于还原界面状态）；未加载前为 null */
  current(): SignProject | null;
}

/* ---------- 底层工具 ---------- */

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code } = error as { name?: string; code?: number };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014;
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(storage: StorageLike, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // 删除失败不影响主流程，遗留键下次会被覆盖或清理
  }
}

function readJson<T>(storage: StorageLike, key: string): T | null {
  const raw = safeGet(storage, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

function defaultStorage(): StorageLike {
  try {
    const probe = `${PREFIX}:probe`;
    globalThis.localStorage.setItem(probe, "1");
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    // SSR 或隐私模式下退化为内存存储，界面仍可工作
    return memoryStorage();
  }
}

/* ---------- 序列化 ---------- */

function corePayloadOf(sign: SignItem): SignCorePayload {
  return {
    id: sign.id,
    code: sign.code,
    sourceText: sign.sourceText,
    targetLanguage: sign.targetLanguage,
    targetText: sign.targetText,
    scenario: sign.scenario,
    regulation: sign.regulation,
    status: sign.status,
    emergencyRevision: sign.emergencyRevision,
    updatedAt: sign.updatedAt,
  };
}

function serializeCore(sign: SignItem, revision: number): string {
  const record: SignRecord = { schema: 2, kind: "sign", signId: sign.id, revision, payload: corePayloadOf(sign) };
  return JSON.stringify(record);
}

function serializeTerms(sign: SignItem, revision: number): string {
  const record: TermsRecord = { schema: 2, kind: "terms", signId: sign.id, revision, payload: sign.terms };
  return JSON.stringify(record);
}

function serializeComments(sign: SignItem, revision: number): string {
  const record: CommentsRecord = { schema: 2, kind: "comments", signId: sign.id, revision, payload: sign.comments };
  return JSON.stringify(record);
}

/**
 * 版本分区落盘前剔除已归档快照（归档区是唯一权威副本，避免写回后空间重新膨胀），
 * 同时原样携带既有归档区，防止后续写入把归档快照冲掉。
 */
function serializeVersions(storage: StorageLike, sign: SignItem, revision: number): string {
  const existing = readJson<VersionsRecord>(storage, versionsKey(sign.id));
  const archivedIds = new Set((existing?.archive?.snapshots ?? []).map((snap) => snap.id));
  const record: VersionsRecord = {
    schema: 2,
    kind: "versions",
    signId: sign.id,
    revision,
    payload: sign.versions.filter((version) => !archivedIds.has(version.id)),
    ...(existing?.archive ? { archive: existing.archive } : {}),
  };
  return JSON.stringify(record);
}

function serializeMeta(project: SignProject, revision: number): string {
  const record: ProjectMetaRecord = {
    schema: 2,
    kind: "meta",
    revision,
    project: {
      id: project.id,
      title: project.title,
      location: project.location,
      activeSignId: project.activeSignId,
      updatedAt: project.updatedAt,
    },
    signOrder: project.signs.map((sign) => sign.id),
  };
  return JSON.stringify(record);
}

/** 元信息负载（不含修订号），用于判断是否需要产生新修订 */
function metaBodyOf(project: SignProject) {
  return {
    id: project.id,
    title: project.title,
    location: project.location,
    activeSignId: project.activeSignId,
    updatedAt: project.updatedAt,
    signOrder: project.signs.map((sign) => sign.id),
  };
}

/* ---------- 差异计算：一次修订涉及哪些分区 ---------- */

function buildUnits(storage: StorageLike, prev: SignProject | null, next: SignProject, revision: number): PendingUnit[] {
  const units: PendingUnit[] = [];
  const push = (key: string, serialized: string | null) => units.push({ key, prev: safeGet(storage, key), next: serialized });

  // 被删除的标识：四类分区记录一起清除
  for (const prevSign of prev?.signs ?? []) {
    if (next.signs.some((sign) => sign.id === prevSign.id)) continue;
    for (const key of [signKey, termsKey, commentsKey, versionsKey].map((of) => of(prevSign.id))) push(key, null);
  }

  for (const sign of next.signs) {
    const prevSign = prev?.signs.find((item) => item.id === sign.id) ?? null;
    // 版本快照与当前内容共用同一修订号：新快照（哨兵修订号）盖上本次修订号，
    // 并强制把标识正文与术语分区一起提交，保证快照、正文、术语三者修订号一致
    const hasNewSnapshot = sign.versions.some((version) => version.revision === PENDING_REVISION);
    if (hasNewSnapshot) {
      for (const version of sign.versions) {
        if (version.revision === PENDING_REVISION) version.revision = revision;
      }
    }
    const coreChanged = !prevSign || JSON.stringify(corePayloadOf(prevSign)) !== JSON.stringify(corePayloadOf(sign));
    const termsChanged = !prevSign || JSON.stringify(prevSign.terms) !== JSON.stringify(sign.terms);
    const commentsChanged = !prevSign || JSON.stringify(prevSign.comments) !== JSON.stringify(sign.comments);
    const versionsChanged = !prevSign || JSON.stringify(prevSign.versions) !== JSON.stringify(sign.versions);
    if (coreChanged || hasNewSnapshot) push(signKey(sign.id), serializeCore(sign, revision));
    if (termsChanged || hasNewSnapshot) push(termsKey(sign.id), serializeTerms(sign, revision));
    if (commentsChanged) push(commentsKey(sign.id), serializeComments(sign, revision));
    if (versionsChanged) push(versionsKey(sign.id), serializeVersions(storage, sign, revision));
  }

  // 元信息是提交点：有任何分区变化或元信息自身变化时才推进修订号
  const metaChanged = !prev || JSON.stringify(metaBodyOf(prev)) !== JSON.stringify(metaBodyOf(next));
  if (units.length > 0 || metaChanged) push(META_KEY, serializeMeta(next, revision));
  return units;
}

/* ---------- 归档：容量不足时按标识分批压缩已确认快照 ---------- */

/**
 * 归档一个标识的已确认快照：把最近一条已确认快照压缩进版本记录的归档区，
 * 其余已确认快照从活动区移除。压缩与归档是同一次原子写入，重写后的记录
 * 只会更小，因此归档本身不会再触发容量不足。
 */
function archiveConfirmedForSign(storage: StorageLike, signId: string, revision: number): number {
  const record = readJson<VersionsRecord>(storage, versionsKey(signId));
  const confirmed = (record?.payload ?? []).filter((version) => version.status === "confirmed");
  if (!confirmed.length) return 0;
  // 版本列表按时间倒序，第一条即最近一次已确认快照
  const compacted: VersionsRecord = {
    schema: 2,
    kind: "versions",
    signId,
    revision,
    payload: (record?.payload ?? []).filter((version) => version.status !== "confirmed"),
    archive: {
      snapshots: [{ ...confirmed[0], archived: true }],
      archivedCount: (record?.archive?.archivedCount ?? 0) + confirmed.length,
      updatedAt: new Date().toISOString(),
    },
  };
  storage.setItem(versionsKey(signId), JSON.stringify(compacted));
  return confirmed.length;
}

/** 还有已确认快照可归档的标识，按版本分区大小降序（先归档最占空间的） */
function archivableSignIds(storage: StorageLike): string[] {
  const meta = readJson<ProjectMetaRecord>(storage, META_KEY);
  if (!meta || meta.schema !== 2) return [];
  return meta.signOrder
    .map((signId) => ({ signId, size: safeGet(storage, versionsKey(signId))?.length ?? 0 }))
    .filter((entry) => entry.size > 0)
    .sort((a, b) => b.size - a.size)
    .map((entry) => entry.signId);
}

/**
 * 执行一次写入；容量不足时按标识分批归档已确认快照，每归档一批就重试。
 * 返回 false 表示归档尽所有批次后仍写不进去。
 */
function writeWithArchiveRetry(storage: StorageLike, write: () => void, revision: number, archived: ArchivedBatch[]): boolean {
  try {
    write();
    return true;
  } catch (error) {
    if (!isQuotaError(error)) throw error;
  }
  for (const signId of archivableSignIds(storage)) {
    let count = 0;
    try {
      count = archiveConfirmedForSign(storage, signId, revision);
    } catch {
      // 归档记录本身都写不下，换下一批
      continue;
    }
    if (!count) continue;
    archived.push({ signId, count });
    try {
      write();
      return true;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
    }
  }
  return false;
}

/* ---------- 事务：待处理区 + 提交 + 回滚 ---------- */

function applyUnit(storage: StorageLike, unit: PendingUnit) {
  if (unit.next === null) storage.removeItem(unit.key);
  else storage.setItem(unit.key, unit.next);
}

/** 回滚到上一份完整修订：按日志 prev 逐键还原（未提交的键重写原值，等同无操作） */
function rollbackUnits(storage: StorageLike, units: PendingUnit[]) {
  for (const unit of [...units].reverse()) {
    try {
      if (unit.prev === null) storage.removeItem(unit.key);
      else storage.setItem(unit.key, unit.prev);
    } catch {
      // prev 原本就放得下，回滚写入理论上不会再超容量；尽力而为
    }
  }
}

interface TxResult {
  ok: boolean;
  rolledBack: boolean;
  archived: ArchivedBatch[];
}

/**
 * 提交一份修订：先把全部写入单元落到待处理区，再逐键提交，最后清除待处理区。
 * 任一步骤容量不足都会先按标识分批归档已确认快照再重试；
 * 仍失败则回滚到上一份完整修订，不留下半份单位。
 */
function runTransaction(storage: StorageLike, units: PendingUnit[], revision: number): TxResult {
  const archived: ArchivedBatch[] = [];
  const journal: PendingJournal = { schema: 2, revision, startedAt: new Date().toISOString(), units };

  const staged = writeWithArchiveRetry(storage, () => storage.setItem(PENDING_KEY, JSON.stringify(journal)), revision, archived);
  if (!staged) {
    // 待处理区都落不下：一个分区都还没动，直接放弃本次修订
    safeRemove(storage, PENDING_KEY);
    return { ok: false, rolledBack: false, archived };
  }

  for (const unit of units) {
    const applied = writeWithArchiveRetry(storage, () => applyUnit(storage, unit), revision, archived);
    if (!applied) {
      rollbackUnits(storage, units);
      safeRemove(storage, PENDING_KEY);
      return { ok: false, rolledBack: true, archived };
    }
  }

  safeRemove(storage, PENDING_KEY);
  return { ok: true, rolledBack: false, archived };
}

/** 页面中断后的恢复：待处理区非空则把该修订的写入单元幂等重放完 */
function recoverPending(storage: StorageLike): { recovered: boolean; rolledBack: boolean; archived: ArchivedBatch[] } {
  const journal = readJson<PendingJournal>(storage, PENDING_KEY);
  if (!journal || journal.schema !== 2 || !Array.isArray(journal.units)) {
    if (safeGet(storage, PENDING_KEY) !== null) safeRemove(storage, PENDING_KEY);
    return { recovered: false, rolledBack: false, archived: [] };
  }
  const archived: ArchivedBatch[] = [];
  // 所有单元写入都是幂等的，从头重放即可接着恢复到一致状态
  for (const unit of journal.units) {
    const applied = writeWithArchiveRetry(storage, () => applyUnit(storage, unit), journal.revision, archived);
    if (!applied) {
      rollbackUnits(storage, journal.units);
      safeRemove(storage, PENDING_KEY);
      return { recovered: true, rolledBack: true, archived };
    }
  }
  safeRemove(storage, PENDING_KEY);
  return { recovered: true, rolledBack: false, archived };
}

/* ---------- 旧版整包数据原位升级 ---------- */

function normalizeLegacyProject(project: SignProject): SignProject {
  return {
    ...project,
    signs: project.signs.map((sign) => ({
      ...sign,
      terms: sign.terms ?? [],
      comments: sign.comments ?? [],
      // 旧版快照没有修订号，置 0 表示升级前的历史版本，全部保留不丢
      versions: (sign.versions ?? []).map((version) => ({ ...version, revision: version.revision ?? 0 })),
    })),
  };
}

/** 读取旧版整包数据（只读，不写任何键） */
function parseLegacyProject(storage: StorageLike): { project: SignProject; raw: string } | null {
  const raw = safeGet(storage, LEGACY_STORAGE_KEY);
  if (raw === null) return null;
  let legacy: { schema?: number; project?: SignProject };
  try {
    legacy = JSON.parse(raw);
  } catch {
    return null;
  }
  if (legacy?.schema !== 1 || !legacy.project?.signs?.length) return null;
  return { project: normalizeLegacyProject(legacy.project), raw };
}

/**
 * 把 schema 1 的整包数据升级为分区记录。升级是一个普通事务：
 * 全部新分区 + 元信息提交后才删除旧键；失败则旧键原样保留。
 */
function migrateLegacy(storage: StorageLike, revision: number): { project: SignProject; deferred: boolean } | null {
  const legacy = parseLegacyProject(storage);
  if (!legacy) return null;
  const units = buildUnits(storage, null, legacy.project, revision);
  units.push({ key: LEGACY_STORAGE_KEY, prev: legacy.raw, next: null });
  const result = runTransaction(storage, units, revision);
  // 容量不足导致升级失败：旧数据未动，由调用方以旧数据继续工作，下次写入再试
  return { project: legacy.project, deferred: !result.ok };
}

/* ---------- 装配：分区记录 → 项目 ---------- */

function mergedVersions(storage: StorageLike, signId: string): VersionSnapshot[] {
  const record = readJson<VersionsRecord>(storage, versionsKey(signId));
  if (!record) return [];
  const active = record.payload ?? [];
  const seen = new Set(active.map((version) => version.id));
  const merged = [...active];
  for (const snapshot of record.archive?.snapshots ?? []) {
    if (!seen.has(snapshot.id)) merged.push({ ...snapshot, archived: true });
  }
  return merged;
}

function readProject(storage: StorageLike): { project: SignProject; revision: number } | null {
  const meta = readJson<ProjectMetaRecord>(storage, META_KEY);
  if (!meta || meta.schema !== 2 || meta.kind !== "meta") return null;
  const signs: SignItem[] = [];
  for (const signId of meta.signOrder) {
    const core = readJson<SignRecord>(storage, signKey(signId));
    // 标识正文缺失视为损坏单位：跳过，不把半份单位交给界面
    if (!core || core.schema !== 2) continue;
    signs.push({
      ...core.payload,
      terms: readJson<TermsRecord>(storage, termsKey(signId))?.payload ?? [],
      comments: readJson<CommentsRecord>(storage, commentsKey(signId))?.payload ?? [],
      versions: mergedVersions(storage, signId),
    });
  }
  return { project: { ...meta.project, signs }, revision: meta.revision };
}

/* ---------- 存储引擎 ---------- */

export function createProjectStore(storage: StorageLike = defaultStorage()): ProjectStore {
  let revision = 0;
  let lastPersisted: SignProject | null = null;
  let legacyDeferred = false;

  const sumArchived = (batches: ArchivedBatch[]) => batches.reduce((total, batch) => total + batch.count, 0);

  return {
    load(fallback) {
      // 先处理中断的写入，再考虑升级，最后装配项目；任何一步异常都不弄丢旧数据
      let recovery = { recovered: false, rolledBack: false, archived: [] as ArchivedBatch[] };
      try {
        recovery = recoverPending(storage);
      } catch {
        // 存储暂时不可写：待处理区原样保留，下次打开再恢复
      }
      let project: SignProject;
      let fresh = false;
      let migrated = false;
      let migrationDeferred = false;

      const stored = readProject(storage);
      if (stored) {
        project = stored.project;
        revision = stored.revision;
      } else {
        let legacy: { project: SignProject; deferred: boolean } | null = null;
        try {
          legacy = migrateLegacy(storage, 1);
        } catch {
          // 升级事务异常（如存储暂时不可写）：按旧数据只读继续，下次写入再试
          const parsed = parseLegacyProject(storage);
          if (parsed) legacy = { project: parsed.project, deferred: true };
        }
        if (legacy && !legacy.deferred) {
          project = legacy.project;
          revision = 1;
          migrated = true;
        } else if (legacy) {
          project = legacy.project;
          revision = 0;
          migrationDeferred = true;
          legacyDeferred = true;
        } else {
          project = fallback;
          revision = 0;
          fresh = true;
        }
      }
      lastPersisted = structuredClone(project);
      return {
        project,
        revision,
        fresh,
        migrated,
        migrationDeferred,
        recovered: recovery.recovered,
        rolledBack: recovery.rolledBack,
        archivedTotal: sumArchived(recovery.archived),
      };
    },

    persist(project) {
      const nextRevision = revision + 1;
      // 上次写入若中断且加载时没能恢复，开新修订前先接着恢复，避免覆盖待处理区
      try {
        recoverPending(storage);
      } catch {
        // 恢复不了也不阻塞本次尝试：新事务会整体重写待处理区
      }
      // 升级被容量卡住时，旧键仍在、新分区全无：必须全量写入，不能只写差异
      const units = buildUnits(storage, legacyDeferred ? null : lastPersisted, project, nextRevision);
      if (!units.length) {
        return { ok: true, changed: false, revision, archivedTotal: 0, rolledBack: false };
      }
      if (legacyDeferred) {
        // 本次修订顺带完成原位升级：全部新分区提交后才删除旧键
        const raw = safeGet(storage, LEGACY_STORAGE_KEY);
        if (raw !== null) units.push({ key: LEGACY_STORAGE_KEY, prev: raw, next: null });
      }
      let result: TxResult;
      try {
        result = runTransaction(storage, units, nextRevision);
      } catch {
        // 非容量类异常（如隐私模式 SecurityError）：已落下的部分留在待处理区，
        // 下次打开时会从待处理区接着恢复
        return { ok: false, changed: true, revision, archivedTotal: 0, rolledBack: false };
      }
      if (result.ok) {
        revision = nextRevision;
        lastPersisted = structuredClone(project);
        legacyDeferred = false;
      }
      return {
        ok: result.ok,
        changed: true,
        revision,
        archivedTotal: sumArchived(result.archived),
        rolledBack: result.rolledBack,
      };
    },

    current() {
      return structuredClone(lastPersisted);
    },
  };
}

let singleton: ProjectStore | null = null;

export function getProjectStore(): ProjectStore {
  singleton ??= createProjectStore();
  return singleton;
}
