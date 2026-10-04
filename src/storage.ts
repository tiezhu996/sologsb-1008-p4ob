import type {
  Reply,
  ReviewComment,
  ReviewStatus,
  SignItem,
  SignProject,
  TermBinding,
  VersionSnapshot,
} from "./types";

export const LEGACY_STORAGE_KEY = "sologsb-1008-project-v1";
const STORAGE_PREFIX = "sologsb-1008:v2:";
const META_KEY = `${STORAGE_PREFIX}meta`;
const PENDING_KEY = `${STORAGE_PREFIX}pending`;
const MAX_SNAPSHOTS = 12;

type JsonRecord = Record<string, unknown>;
type PartitionKind = "identity" | "terms" | "reviews";
type PendingOp = "save" | "compact" | "upgrade";
type ArchiveEntry = Pick<VersionSnapshot, "id" | "revision"> & Partial<Omit<VersionSnapshot, "id" | "revision">>;

interface RecordRef {
  key: string;
  revision: number;
}

interface SnapshotRef {
  id: string;
  revision: number;
  status: ReviewStatus;
  archived: boolean;
  key?: string;
  archiveId?: number;
}

interface ArchiveRef {
  id: string;
  revision: number;
  key: string;
  archiveId: number;
  signId: string;
}

interface SignMeta {
  identity: RecordRef;
  terms: RecordRef;
  reviews: RecordRef;
  snapshots: SnapshotRef[];
  archives: ArchiveRef[];
}

interface PartitionManifest {
  schema: 2;
  kind: "meta";
  revision: number;
  projectId: string;
  projectIdentity: RecordRef;
  signOrder: string[];
  signs: Record<string, SignMeta>;
}

interface PendingState {
  schema: 2;
  kind: "pending";
  op: PendingOp;
  revision: number;
  meta: PartitionManifest;
  records: string[];
  cleanup?: string[];
}

interface ProjectIdentityRecord {
  schema: 2;
  kind: "project-identity";
  revision: number;
  project: Pick<SignProject, "id" | "title" | "location" | "activeSignId" | "updatedAt">;
}

interface SignIdentityRecord {
  schema: 2;
  kind: "sign-identity";
  revision: number;
  signId: string;
  sign: Pick<
    SignItem,
    | "id"
    | "code"
    | "sourceText"
    | "targetLanguage"
    | "targetText"
    | "scenario"
    | "regulation"
    | "status"
    | "emergencyRevision"
    | "updatedAt"
  >;
}

interface TermsRecord {
  schema: 2;
  kind: "terms";
  revision: number;
  signId: string;
  terms: TermBinding[];
}

interface ReviewsRecord {
  schema: 2;
  kind: "reviews";
  revision: number;
  signId: string;
  comments: ReviewComment[];
}

interface SnapshotRecord {
  schema: 2;
  kind: "snapshot";
  revision: number;
  signId: string;
  snapshot: VersionSnapshot;
}

interface ArchiveRecord {
  schema: 2;
  kind: "snapshot-archive";
  revision: number;
  signId: string;
  archiveId: number;
  archive: {
    head: VersionSnapshot;
    entries: ArchiveEntry[];
  };
}

export interface SaveResult {
  project: SignProject;
  revision: number;
  compactedSignId?: string;
}

export interface LoadResult {
  project: SignProject | null;
  recovered?: string;
}

const isObject = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null;

const revisionOf = (value: unknown, fallback = 0) => {
  const revision = Math.trunc(Number(value));
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : fallback;
};

const clone = <T>(value: T): T => structuredClone(value);

function isQuotaError(error: unknown) {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22);
}

function writeJson(storage: Storage, key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value));
}

function readJson<T>(storage: Storage, key: string): T | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

function required<T>(value: T | null | undefined, key: string): T {
  if (value === null || value === undefined) throw new Error(`缺少完整的本地存储分区：${key}`);
  return value;
}

function safeId(id: string) {
  return encodeURIComponent(id).replace(/[!'()*]/g, "");
}

function signRecordKey(kind: PartitionKind, signId: string, revision: number) {
  return `${STORAGE_PREFIX}sign:${safeId(signId)}:${kind}:r${revision}`;
}

function snapshotKey(signId: string, snapshotId: string, revision: number) {
  return `${STORAGE_PREFIX}sign:${safeId(signId)}:snapshot:${safeId(snapshotId)}:r${revision}`;
}

function archiveKey(signId: string, archiveId: number, revision: number) {
  return `${STORAGE_PREFIX}sign:${safeId(signId)}:archive:${archiveId}:r${revision}`;
}

function projectIdentityKey(revision: number) {
  return `${STORAGE_PREFIX}project:identity:r${revision}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown) {
  return stableStringify(left) === stableStringify(right);
}

function asStatus(value: unknown): ReviewStatus {
  return value === "draft" || value === "pending" || value === "confirmed" || value === "changes"
    ? value
    : "draft";
}

function normalizeTerms(value: unknown): TermBinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => ({
    id: String(item.id ?? ""),
    source: String(item.source ?? ""),
    target: String(item.target ?? ""),
    required: item.required !== false,
    confirmed: item.confirmed === true,
  })).filter((item) => item.id);
}

function normalizeReplies(value: unknown): Reply[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => ({
    id: String(item.id ?? ""),
    author: String(item.author ?? "当前审校员"),
    body: String(item.body ?? ""),
    createdAt: String(item.createdAt ?? ""),
  })).filter((item) => item.id);
}

function normalizeComments(value: unknown): ReviewComment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => ({
    id: String(item.id ?? ""),
    author: String(item.author ?? "当前审校员"),
    body: String(item.body ?? ""),
    createdAt: String(item.createdAt ?? ""),
    resolved: item.resolved === true,
    replies: normalizeReplies(item.replies),
  })).filter((item) => item.id);
}

function normalizeSnapshots(value: unknown): VersionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => ({
    id: String(item.id ?? ""),
    label: String(item.label ?? "未命名版本"),
    createdAt: String(item.createdAt ?? ""),
    sourceText: String(item.sourceText ?? ""),
    targetText: String(item.targetText ?? ""),
    status: asStatus(item.status),
    terms: normalizeTerms(item.terms),
    revision: revisionOf(item.revision),
    archived: item.archived === true,
  })).filter((item) => item.id).slice(0, MAX_SNAPSHOTS);
}

function normalizeSign(value: unknown, fallbackRevision = 0): SignItem {
  const item = isObject(value) ? value : {};
  const revision = revisionOf(item.revision, fallbackRevision);
  return {
    id: String(item.id ?? ""),
    code: String(item.code ?? ""),
    sourceText: String(item.sourceText ?? ""),
    targetLanguage: String(item.targetLanguage ?? "English"),
    targetText: String(item.targetText ?? ""),
    scenario: String(item.scenario ?? ""),
    regulation: String(item.regulation ?? ""),
    status: asStatus(item.status),
    terms: normalizeTerms(item.terms),
    comments: normalizeComments(item.comments),
    versions: normalizeSnapshots(item.versions),
    emergencyRevision: item.emergencyRevision === true,
    updatedAt: String(item.updatedAt ?? new Date(0).toISOString()),
    revision,
  };
}

export function normalizeProject(value: unknown): SignProject | null {
  if (!isObject(value)) return null;
  const revision = revisionOf(value.revision, 0);
  const signs = Array.isArray(value.signs)
    ? value.signs.map((sign) => normalizeSign(sign, revision)).filter((sign) => sign.id)
    : [];
  if (!signs.length) return null;
  return {
    id: String(value.id ?? "public-sign-review"),
    title: String(value.title ?? "公共标识多语言校对"),
    location: String(value.location ?? ""),
    activeSignId: String(value.activeSignId ?? signs[0].id),
    signs,
    updatedAt: String(value.updatedAt ?? new Date(0).toISOString()),
    revision,
  };
}

function isRecordRef(value: unknown): value is RecordRef {
  return isObject(value) && typeof value.key === "string" && Number.isSafeInteger(revisionOf(value.revision, NaN));
}

function isSnapshotRef(value: unknown): value is SnapshotRef {
  if (!isObject(value) || typeof value.id !== "string") return false;
  if (value.archived === true) return Number.isInteger(value.archiveId);
  return typeof value.key === "string";
}

function isArchiveRef(value: unknown): value is ArchiveRef {
  return isObject(value) && typeof value.key === "string" && Number.isInteger(value.archiveId) && typeof value.signId === "string";
}

function isManifest(value: unknown): value is PartitionManifest {
  if (!isObject(value) || value.schema !== 2 || value.kind !== "meta" || !isObject(value.signs)) return false;
  if (!isRecordRef(value.projectIdentity) || !Array.isArray(value.signOrder)) return false;
  return Object.values(value.signs).every((sign) => {
    if (!isObject(sign) || !isRecordRef(sign.identity) || !isRecordRef(sign.terms) || !isRecordRef(sign.reviews)) return false;
    if (!Array.isArray(sign.snapshots) || !sign.snapshots.every(isSnapshotRef)) return false;
    return Array.isArray(sign.archives) && sign.archives.every(isArchiveRef);
  });
}

function isPending(value: unknown): value is PendingState {
  return isObject(value) && value.schema === 2 && value.kind === "pending" &&
    (value.op === "save" || value.op === "compact" || value.op === "upgrade") &&
    isManifest(value.meta) && Array.isArray(value.records) &&
    (value.cleanup === undefined || Array.isArray(value.cleanup));
}

function readManifest(storage: Storage): PartitionManifest | null {
  const meta = readJson<PartitionManifest>(storage, META_KEY);
  if (meta === null) return null;
  if (!isManifest(meta)) throw new Error("本地项目修订清单已损坏");
  return meta;
}

function readPending(storage: Storage): PendingState | null {
  const pending = readJson<PendingState>(storage, PENDING_KEY);
  if (pending === null) return null;
  if (!isPending(pending)) throw new Error("本地待处理区已损坏");
  return pending;
}

function writePending(storage: Storage, pending: PendingState) {
  writeJson(storage, PENDING_KEY, pending);
}

function identityPayload(sign: SignItem): SignIdentityRecord["sign"] {
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

function makeSignMeta(signId: string, revision: number): SignMeta {
  return {
    identity: { key: signRecordKey("identity", signId, revision), revision },
    terms: { key: signRecordKey("terms", signId, revision), revision },
    reviews: { key: signRecordKey("reviews", signId, revision), revision },
    snapshots: [],
    archives: [],
  };
}

function nextArchiveId(meta: PartitionManifest, signId: string) {
  return (meta.signs[signId]?.archives.reduce((max, item) => Math.max(max, item.archiveId), 0) ?? 0) + 1;
}

function rememberRecord(pending: PendingState, key: string) {
  if (!pending.records.includes(key)) pending.records.push(key);
}

function compactCandidateSign(
  storage: Storage,
  pending: PendingState,
  signId: string,
  excludeKey?: string,
): { changed: boolean } {
  const signMeta = pending.meta.signs[signId];
  if (!signMeta) return { changed: false };
  const refs = signMeta.snapshots
    .filter((item) => item.status === "confirmed" && !item.archived && item.key)
    .filter((item) => storage.getItem(item.key!) !== null && item.key !== excludeKey);
  if (!refs.length) return { changed: false };

  const snapshots = refs.map((ref) => {
    const record = required(readJson<SnapshotRecord>(storage, ref.key!), ref.key!);
    if (record.schema !== 2 || record.kind !== "snapshot" || record.snapshot?.id !== ref.id) {
      throw new Error(`待归档快照不完整：${ref.key}`);
    }
    return record.snapshot;
  });

  const archiveId = nextArchiveId(pending.meta, signId);
  const revision = pending.revision;
  const key = archiveKey(signId, archiveId, revision);
  const head: VersionSnapshot = { ...snapshots[0], archived: true };
  const entries: ArchiveEntry[] = snapshots.slice(1).map((snapshot) => {
    return {
      id: snapshot.id,
      label: sameValue(snapshot.label, head.label) ? undefined : snapshot.label,
      createdAt: sameValue(snapshot.createdAt, head.createdAt) ? undefined : snapshot.createdAt,
      sourceText: sameValue(snapshot.sourceText, head.sourceText) ? undefined : snapshot.sourceText,
      targetText: sameValue(snapshot.targetText, head.targetText) ? undefined : snapshot.targetText,
      status: snapshot.status === head.status ? undefined : snapshot.status,
      terms: sameValue(snapshot.terms, head.terms) ? undefined : snapshot.terms,
      revision: snapshot.revision,
      archived: true,
    };
  });
  const record: ArchiveRecord = {
    schema: 2,
    kind: "snapshot-archive",
    revision,
    signId,
    archiveId,
    archive: { head, entries },
  };
  writeJson(storage, key, record);

  const updatedRefs = new Map(refs.map((ref) => [
    ref.id,
    { id: ref.id, revision: ref.revision, status: ref.status, archived: true as const, archiveId },
  ]));
  signMeta.snapshots = signMeta.snapshots.map((ref) => updatedRefs.get(ref.id) ?? ref);
  signMeta.archives.push({ id: `archive-${signId}-${archiveId}`, revision, key, archiveId, signId });
  pending.cleanup ??= [];
  for (const ref of refs) if (!pending.cleanup.includes(ref.key!)) pending.cleanup.push(ref.key!);
  rememberRecord(pending, key);
  writePending(storage, pending);
  return { changed: true };
}

function writeRecord(
  storage: Storage,
  pending: PendingState,
  key: string,
  record: unknown,
  eligibleSignIds: string[],
): { compactedSignId?: string } {
  try {
    writeJson(storage, key, record);
    return {};
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    for (const signId of eligibleSignIds) {
      if (compactCandidateSign(storage, pending, signId, key).changed) {
        writeJson(storage, key, record);
        return { compactedSignId: signId };
      }
    }
    for (const signId of pending.meta.signOrder) {
      if (eligibleSignIds.includes(signId)) continue;
      if (compactCandidateSign(storage, pending, signId, key).changed) {
        writeJson(storage, key, record);
        return { compactedSignId: signId };
      }
    }
    throw error;
  }
}

function commitManifest(storage: Storage, pending: PendingState, recovered?: string): LoadResult {
  writeJson(storage, META_KEY, pending.meta);
  for (const key of pending.cleanup ?? []) storage.removeItem(key);
  storage.removeItem(PENDING_KEY);
  return { project: assembleProject(storage, pending.meta), recovered };
}

function abortPending(storage: Storage, pending: PendingState) {
  for (const key of pending.records) {
    if (key !== META_KEY && !pending.cleanup?.includes(key)) storage.removeItem(key);
  }
  storage.removeItem(PENDING_KEY);
}

function rollbackPending(storage: Storage, pending: PendingState): LoadResult {
  abortPending(storage, pending);
  const meta = readManifest(storage);
  return {
    project: meta ? assembleProject(storage, meta) : null,
    recovered: "检测到未写完的修订，已回滚到上一份完整修订。",
  };
}

function resolveSnapshot(
  storage: Storage,
  signId: string,
  ref: SnapshotRef,
  archives: Map<number, ArchiveRecord>,
): VersionSnapshot {
  if (!ref.archived) {
    const record = required(readJson<SnapshotRecord>(storage, ref.key!), ref.key ?? snapshotKey(signId, ref.id, ref.revision));
    if (record.schema !== 2 || record.kind !== "snapshot") throw new Error(`快照分区不完整：${ref.key}`);
    return { ...record.snapshot, revision: ref.revision, archived: false };
  }
  const archive = required(archives.get(ref.archiveId!), `sign ${signId} archive ${ref.archiveId}`);
  const entry = archive.archive.entries.find((item) => item.id === ref.id);
  if (!entry && ref.id === archive.archive.head.id) {
    return { ...archive.archive.head, revision: ref.revision, archived: true };
  }
  if (!entry) throw new Error(`归档中缺少快照：${ref.id}`);
  return {
    id: entry.id,
    label: entry.label ?? archive.archive.head.label,
    createdAt: entry.createdAt ?? archive.archive.head.createdAt,
    sourceText: entry.sourceText ?? archive.archive.head.sourceText,
    targetText: entry.targetText ?? archive.archive.head.targetText,
    status: entry.status ?? archive.archive.head.status,
    terms: entry.terms ?? archive.archive.head.terms,
    revision: ref.revision,
    archived: true,
  };
}

function assembleProject(storage: Storage, meta: PartitionManifest): SignProject {
  const projectRecord = required(readJson<ProjectIdentityRecord>(storage, meta.projectIdentity.key), meta.projectIdentity.key);
  if (projectRecord.schema !== 2 || projectRecord.kind !== "project-identity") {
    throw new Error("项目标识分区不完整");
  }

  const archiveCache = new Map<string, Map<number, ArchiveRecord>>();
  const signs = meta.signOrder.map((signId) => {
    const signMeta = required(meta.signs[signId], signId);
    const identityRecord = required(readJson<SignIdentityRecord>(storage, signMeta.identity.key), signMeta.identity.key);
    const termsRecord = required(readJson<TermsRecord>(storage, signMeta.terms.key), signMeta.terms.key);
    const reviewsRecord = required(readJson<ReviewsRecord>(storage, signMeta.reviews.key), signMeta.reviews.key);
    if (identityRecord.kind !== "sign-identity" || termsRecord.kind !== "terms" || reviewsRecord.kind !== "reviews") {
      throw new Error(`标识 ${signId} 的三类分区不完整`);
    }
    if (!archiveCache.has(signId)) {
      const map = new Map<number, ArchiveRecord>();
      for (const ref of signMeta.archives) {
        const record = required(readJson<ArchiveRecord>(storage, ref.key), ref.key);
        if (record.kind === "snapshot-archive") map.set(ref.archiveId, record);
      }
      archiveCache.set(signId, map);
    }
    const versions = signMeta.snapshots.map((ref) => resolveSnapshot(storage, signId, ref, archiveCache.get(signId)!));
    const revision = Math.max(signMeta.identity.revision, signMeta.terms.revision, signMeta.reviews.revision);
    return {
      ...identityRecord.sign,
      terms: termsRecord.terms,
      comments: reviewsRecord.comments,
      versions,
      revision,
    } satisfies SignItem;
  });

  return {
    ...projectRecord.project,
    activeSignId: meta.signOrder.includes(projectRecord.project.activeSignId)
      ? projectRecord.project.activeSignId
      : meta.signOrder[0],
    signs,
    revision: meta.revision,
  };
}

function resumePending(storage: Storage, pending: PendingState): LoadResult {
  const missing = pending.records.some((key) => storage.getItem(key) === null);
  const hasLegacy = storage.getItem(LEGACY_STORAGE_KEY) !== null;
  if (pending.op === "upgrade" && hasLegacy) return continueUpgrade(storage, pending);
  if (hasLegacy) {
    storage.removeItem(PENDING_KEY);
    return { project: readManifest(storage) ? assembleProject(storage, readManifest(storage)!) : null };
  }
  if (missing) return rollbackPending(storage, pending);
  return commitManifest(storage, pending, "页面曾中断，已从待处理区继续并完成上次修订。");
}

function loadLegacyProject(storage: Storage): SignProject | null {
  let stored: { schema?: number; project?: unknown } | null = null;
  try {
    stored = readJson(storage, LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored || stored.schema !== 1) return null;
  return normalizeProject(stored.project);
}

function buildUpgradeManifest(legacy: SignProject): PartitionManifest {
  const revision = Math.max(1, legacy.signs.reduce((max, sign) => Math.max(max, sign.versions.length), 0));
  const signs: Record<string, SignMeta> = {};
  for (const sign of legacy.signs) {
    const meta = makeSignMeta(sign.id, revision);
    const baseRevision = revision - sign.versions.length + 1;
    meta.snapshots = sign.versions.slice(0, MAX_SNAPSHOTS).map((snapshot, index) => ({
      id: snapshot.id,
      revision: baseRevision + index,
      status: snapshot.status,
      archived: false,
      key: snapshotKey(sign.id, snapshot.id, baseRevision + index),
    }));
    signs[sign.id] = meta;
  }
  return {
    schema: 2,
    kind: "meta",
    revision,
    projectId: legacy.id,
    projectIdentity: { key: projectIdentityKey(revision), revision },
    signOrder: legacy.signs.map((sign) => sign.id),
    signs,
  };
}

function buildUpgradeRecords(sign: SignItem, signMeta: SignMeta, revision: number): Array<[string, unknown]> {
  const snapshots = signMeta.snapshots.map((ref) => {
    const snapshot = required(sign.versions.find((item) => item.id === ref.id), `legacy snapshot ${ref.id}`);
    return [
      ref.key!,
      { schema: 2, kind: "snapshot", revision: ref.revision, signId: sign.id, snapshot: { ...snapshot, revision: ref.revision, archived: false } } satisfies SnapshotRecord,
    ] as [string, SnapshotRecord];
  });
  return [
    ...snapshots,
    [signMeta.identity.key, { schema: 2, kind: "sign-identity", revision, signId: sign.id, sign: identityPayload(sign) } satisfies SignIdentityRecord],
    [signMeta.terms.key, { schema: 2, kind: "terms", revision, signId: sign.id, terms: sign.terms } satisfies TermsRecord],
    [signMeta.reviews.key, { schema: 2, kind: "reviews", revision, signId: sign.id, comments: sign.comments } satisfies ReviewsRecord],
  ];
}

function signUpgradeRecordsReady(meta: PartitionManifest, signId: string) {
  const signMeta = meta.signs[signId];
  return Boolean(signMeta && signMeta.snapshots.every((ref) => ref.archived || ref.key));
}

function writeResidual(storage: Storage, pending: PendingState, latestLegacy: SignProject, removedSignId: string) {
  const residual = clone(latestLegacy);
  residual.signs = residual.signs.filter((item) => item.id !== removedSignId);
  let lastError: unknown;
  try {
    writeJson(storage, LEGACY_STORAGE_KEY, { schema: 1, project: residual });
    return;
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    lastError = error;
  }
  for (const eligible of pending.meta.signOrder) {
    if (eligible === removedSignId || !signUpgradeRecordsReady(pending.meta, eligible)) continue;
    if (compactCandidateSign(storage, pending, eligible).changed) {
      writeJson(storage, LEGACY_STORAGE_KEY, { schema: 1, project: residual });
      return;
    }
  }
  if (storage.getItem(LEGACY_STORAGE_KEY) !== null) {
    const current = loadLegacyProject(storage);
    if (current && !current.signs.some((sign) => sign.id === removedSignId)) return;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("容量不足，旧数据原位升级在剥离已迁移标识时中断，可刷新后继续。");
}

function legacySourceForUpgrade(storage: Storage, pending: PendingState): SignProject {
  const legacy = loadLegacyProject(storage);
  if (!legacy) throw new Error("旧数据不完整，无法继续原位升级。");
  if (legacy.id !== pending.meta.projectId) throw new Error("旧数据与待处理升级不属于同一项目。");
  return legacy;
}

function loadOriginalLegacyProject(storage: Storage, pending: PendingState): SignProject {
  const projectRecord = required(readJson<ProjectIdentityRecord>(storage, pending.meta.projectIdentity.key), pending.meta.projectIdentity.key);
  const signs = pending.meta.signOrder.map((signId) => {
    const signMeta = required(pending.meta.signs[signId], signId);
    const identityRecord = readJson<SignIdentityRecord>(storage, signMeta.identity.key);
    const termsRecord = readJson<TermsRecord>(storage, signMeta.terms.key);
    const reviewsRecord = readJson<ReviewsRecord>(storage, signMeta.reviews.key);
    if (identityRecord?.kind !== "sign-identity" || termsRecord?.kind !== "terms" || reviewsRecord?.kind !== "reviews") {
      throw new Error(`已迁移标识 ${signId} 不完整，无法继续升级。`);
    }
    const archiveMap = new Map<number, ArchiveRecord>();
    for (const archiveRef of signMeta.archives) {
      const archiveRecord = readJson<ArchiveRecord>(storage, archiveRef.key);
      if (archiveRecord?.kind === "snapshot-archive") archiveMap.set(archiveRef.archiveId, archiveRecord);
    }
    const versions: VersionSnapshot[] = [];
    for (const ref of signMeta.snapshots) {
      if (ref.archived) {
        if (archiveMap.has(ref.archiveId!)) versions.push(resolveSnapshot(storage, signId, ref, archiveMap));
      } else {
        const snapshotRecord = readJson<SnapshotRecord>(storage, ref.key!);
        if (snapshotRecord?.kind === "snapshot" && snapshotRecord.snapshot.id === ref.id) {
          versions.push({ ...snapshotRecord.snapshot, revision: ref.revision, archived: false });
        }
      }
    }
    return {
      ...identityRecord.sign,
      terms: termsRecord.terms,
      comments: reviewsRecord.comments,
      versions,
      revision: pending.revision,
    } satisfies SignItem;
  });
  return {
    ...projectRecord.project,
    activeSignId: pending.meta.signOrder.includes(projectRecord.project.activeSignId)
      ? projectRecord.project.activeSignId
      : pending.meta.signOrder[0],
    signs,
    revision: pending.revision,
  };
}

function writeUpgradeSign(
  storage: Storage,
  pending: PendingState,
  sign: SignItem,
  latestLegacy: SignProject,
  completedSignIds: string[],
) {
  const meta = pending.meta;
  const signMeta = required(meta.signs[sign.id], sign.id);
  for (const [key, record] of buildUpgradeRecords(sign, signMeta, meta.revision)) {
    if (storage.getItem(key) !== null) {
      rememberRecord(pending, key);
      continue;
    }
    const snapshotsReady = signMeta.snapshots
      .filter((ref) => !ref.archived)
      .every((ref) => ref.key && storage.getItem(ref.key) !== null);
    const eligible = snapshotsReady && sign.versions.length ? [...completedSignIds, sign.id] : completedSignIds;
    try {
      writeRecord(storage, pending, key, record, eligible);
      rememberRecord(pending, key);
    } catch (error) {
      writePending(storage, pending);
      throw error;
    }
    writePending(storage, pending);
  }
  writeResidual(storage, pending, latestLegacy, sign.id);
  writePending(storage, pending);
}

function continueUpgrade(storage: Storage, pending: PendingState): LoadResult {
  const legacy = legacySourceForUpgrade(storage, pending);
  const completedLegacy = loadOriginalLegacyProject(storage, pending);
  const fullById = new Map(completedLegacy.signs.map((sign) => [sign.id, sign]));
  const byId = new Map(legacy.signs.map((sign) => [sign.id, sign]));
  const completed: string[] = [];
  const originalIds = pending.meta.signOrder;
  let latestLegacy = clone(legacy);
  for (const signId of originalIds) {
    const sign = byId.get(signId) ?? fullById.get(signId);
    const signMeta = pending.meta.signs[signId];
    if (!sign || !signMeta) throw new Error(`旧数据升级缺少标识：${signId}`);
    const identityReady = storage.getItem(signMeta.identity.key) !== null;
    const termsReady = storage.getItem(signMeta.terms.key) !== null;
    const reviewsReady = storage.getItem(signMeta.reviews.key) !== null;
    const snapshotsReady = signMeta.snapshots.every((ref) =>
      ref.archived || (ref.key && storage.getItem(ref.key) !== null),
    );
    const allReady = identityReady && termsReady && reviewsReady && snapshotsReady;
    if (!allReady) {
      writeUpgradeSign(storage, pending, sign, latestLegacy, completed);
    } else if (latestLegacy.signs.some((item) => item.id === signId)) {
      writeResidual(storage, pending, latestLegacy, signId);
    }
    latestLegacy = { ...latestLegacy, signs: latestLegacy.signs.filter((item) => item.id !== signId) };
    completed.push(signId);
  }
  storage.removeItem(LEGACY_STORAGE_KEY);
  return commitManifest(storage, pending, "页面中断后已从待处理区继续完成旧数据原位升级。");
}

function upgradeLegacyProject(storage: Storage, legacyInput: SignProject): SignProject {
  const legacy = clone(legacyInput);
  const meta = buildUpgradeManifest(legacy);
  const pending: PendingState = { schema: 2, kind: "pending", op: "upgrade", revision: meta.revision, meta, records: [] };
  writePending(storage, pending);

  const projectRecord: ProjectIdentityRecord = {
    schema: 2,
    kind: "project-identity",
    revision: meta.revision,
    project: {
      id: legacy.id,
      title: legacy.title,
      location: legacy.location,
      activeSignId: legacy.activeSignId,
      updatedAt: legacy.updatedAt,
    },
  };
  writeJson(storage, meta.projectIdentity.key, projectRecord);
  rememberRecord(pending, meta.projectIdentity.key);
  writePending(storage, pending);

  const completed: string[] = [];
  for (const sign of legacy.signs) {
    writeUpgradeSign(storage, pending, sign, legacy, completed);
    completed.push(sign.id);
  }
  storage.removeItem(LEGACY_STORAGE_KEY);
  writeJson(storage, META_KEY, meta);
  storage.removeItem(PENDING_KEY);
  return assembleProject(storage, meta);
}

function removeOldRefs(storage: Storage, base: PartitionManifest | null, candidate: PartitionManifest) {
  const candidateKeys = new Set<string>([candidate.projectIdentity.key]);
  for (const signId of candidate.signOrder) {
    const sign = candidate.signs[signId];
    candidateKeys.add(sign.identity.key).add(sign.terms.key).add(sign.reviews.key);
    for (const snapshot of sign.snapshots) if (snapshot.key) candidateKeys.add(snapshot.key);
    for (const archive of sign.archives) candidateKeys.add(archive.key);
  }
  if (!base) return;
  const oldKeys = [base.projectIdentity.key];
  for (const signId of base.signOrder) {
    const sign = base.signs[signId];
    if (!sign) continue;
    oldKeys.push(sign.identity.key, sign.terms.key, sign.reviews.key);
    for (const snapshot of sign.snapshots) if (snapshot.key) oldKeys.push(snapshot.key);
    for (const archive of sign.archives) oldKeys.push(archive.key);
  }
  for (const key of oldKeys) if (!candidateKeys.has(key)) storage.removeItem(key);
}

function freshManifest(project: SignProject, revision: number): PartitionManifest {
  return {
    schema: 2,
    kind: "meta",
    revision,
    projectId: project.id,
    projectIdentity: { key: projectIdentityKey(revision), revision },
    signOrder: project.signs.map((sign) => sign.id),
    signs: Object.fromEntries(project.signs.map((sign) => [sign.id, makeSignMeta(sign.id, revision)])),
  };
}

export function saveProject(input: SignProject, storage: Storage = localStorage): SaveResult {
  const project = clone(required(normalizeProject(input), "project"));
  const base = readManifest(storage);
  const baseProject = base ? assembleProject(storage, base) : null;
  const existingSnapshotIds = new Set<string>();
  baseProject?.signs.forEach((sign) => sign.versions.forEach((snapshot) => existingSnapshotIds.add(snapshot.id)));

  const newSnapshots: Array<{ signId: string; snapshot: VersionSnapshot }> = [];
  for (const sign of project.signs) {
    for (const snapshot of sign.versions) {
      if (!existingSnapshotIds.has(snapshot.id)) newSnapshots.push({ signId: sign.id, snapshot });
    }
  }

  const targetRevision = (base?.revision ?? 0) + 1;
  for (const item of newSnapshots) {
    item.snapshot.revision = targetRevision;
    item.snapshot.archived = false;
  }
  project.revision = targetRevision;
  for (const sign of project.signs) sign.revision = targetRevision;

  const meta: PartitionManifest = base
    ? { ...clone(base), revision: targetRevision, projectIdentity: { key: projectIdentityKey(targetRevision), revision: targetRevision }, signs: clone(base.signs), signOrder: clone(base.signOrder) }
    : freshManifest(project, targetRevision);

  meta.projectId = project.id;
  meta.signOrder = project.signs.map((sign) => sign.id);
  for (const signId of Object.keys(meta.signs)) {
    if (!project.signs.some((sign) => sign.id === signId)) delete meta.signs[signId];
  }

  const writes: Array<[string, unknown]> = [
    [meta.projectIdentity.key, {
      schema: 2,
      kind: "project-identity",
      revision: targetRevision,
      project: {
        id: project.id,
        title: project.title,
        location: project.location,
        activeSignId: project.activeSignId,
        updatedAt: project.updatedAt,
      },
    } satisfies ProjectIdentityRecord],
  ];

  for (const sign of project.signs) {
    const existing = baseProject?.signs.find((item) => item.id === sign.id);
    const signMeta = meta.signs[sign.id] ?? makeSignMeta(sign.id, targetRevision);
    meta.signs[sign.id] = signMeta;

    if (!existing || !sameValue(identityPayload(existing), identityPayload(sign))) {
      signMeta.identity = { key: signRecordKey("identity", sign.id, targetRevision), revision: targetRevision };
      writes.push([signMeta.identity.key, { schema: 2, kind: "sign-identity", revision: targetRevision, signId: sign.id, sign: identityPayload(sign) } satisfies SignIdentityRecord]);
    }
    if (!existing || !sameValue(existing.terms, sign.terms)) {
      signMeta.terms = { key: signRecordKey("terms", sign.id, targetRevision), revision: targetRevision };
      writes.push([signMeta.terms.key, { schema: 2, kind: "terms", revision: targetRevision, signId: sign.id, terms: sign.terms } satisfies TermsRecord]);
    }
    if (!existing || !sameValue(existing.comments, sign.comments)) {
      signMeta.reviews = { key: signRecordKey("reviews", sign.id, targetRevision), revision: targetRevision };
      writes.push([signMeta.reviews.key, { schema: 2, kind: "reviews", revision: targetRevision, signId: sign.id, comments: sign.comments } satisfies ReviewsRecord]);
    }

    signMeta.snapshots = sign.versions.slice(0, MAX_SNAPSHOTS).map((snapshot) => {
      const old = signMeta.snapshots.find((ref) => ref.id === snapshot.id);
      if (old) return old;
      return {
        id: snapshot.id,
        revision: targetRevision,
        status: snapshot.status,
        archived: false,
        key: snapshotKey(sign.id, snapshot.id, targetRevision),
      } satisfies SnapshotRef;
    });

    for (const item of newSnapshots.filter((snapshot) => snapshot.signId === sign.id)) {
      writes.push([snapshotKey(sign.id, item.snapshot.id, targetRevision), {
        schema: 2,
        kind: "snapshot",
        revision: targetRevision,
        signId: sign.id,
        snapshot: item.snapshot,
      } satisfies SnapshotRecord]);
    }
  }

  const pending: PendingState = { schema: 2, kind: "pending", op: "save", revision: targetRevision, meta, records: [] };
  let compactedSignId: string | undefined;
  try {
    writePending(storage, pending);
    for (const [key, record] of writes) {
      const result = writeRecord(storage, pending, key, record, meta.signOrder);
      compactedSignId ??= result.compactedSignId;
      rememberRecord(pending, key);
      writePending(storage, pending);
    }
    try {
      writeJson(storage, META_KEY, meta);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      for (const signId of meta.signOrder) {
        if (compactCandidateSign(storage, pending, signId).changed) {
          compactedSignId ??= signId;
          writeJson(storage, META_KEY, meta);
          break;
        }
      }
      if ((readJson<PartitionManifest>(storage, META_KEY)?.revision ?? -1) !== meta.revision) throw error;
    }
    storage.removeItem(PENDING_KEY);
    removeOldRefs(storage, base, meta);
    return { project: assembleProject(storage, meta), revision: targetRevision, compactedSignId };
  } catch (error) {
    abortPending(storage, pending);
    throw error;
  }
}

export function compactConfirmedSnapshots(storage: Storage = localStorage): { changed: boolean; signId?: string } {
  const pending = readPending(storage);
  if (pending) resumePending(storage, pending);
  const meta = readManifest(storage);
  if (!meta) return { changed: false };
  const signId = meta.signOrder.find((id) => meta.signs[id].snapshots.some((snapshot) => snapshot.status === "confirmed" && !snapshot.archived));
  if (!signId) return { changed: false };

  const next: PendingState = { schema: 2, kind: "pending", op: "compact", revision: meta.revision, meta: clone(meta), records: [] };
  writePending(storage, next);
  compactCandidateSign(storage, next, signId);
  writeJson(storage, META_KEY, next.meta);
  storage.removeItem(PENDING_KEY);
  return { changed: true, signId };
}

export function loadProject(storage: Storage = localStorage): LoadResult {
  const pending = readPending(storage);
  if (pending) return resumePending(storage, pending);
  const meta = readManifest(storage);
  if (meta) return { project: assembleProject(storage, meta) };
  const legacy = loadLegacyProject(storage);
  if (legacy) return { project: upgradeLegacyProject(storage, legacy), recovered: "旧版整包数据已原位升级为标识、术语、审校意见分区。" };
  return { project: null };
}
