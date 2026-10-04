export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
  /** 与当前内容共用的修订号；0 表示旧版数据尚未跟踪修订 */
  revision: number;
  /** 容量不足时被归档的已确认快照（加载合并时标记，不随分区记录重复落盘） */
  archived?: boolean;
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  updatedAt: string;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  updatedAt: string;
}

export interface PersistedProject {
  schema: 1;
  project: SignProject;
}

/* ---------- 分区存储（schema 2） ---------- */

/** 三类业务分区：标识正文、术语、审校意见；版本快照单独成区 */
export type PartitionKind = "sign" | "terms" | "comments" | "versions";

/** 标识分区负载：一条标识的当前正文与元信息 */
export interface SignCorePayload {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  emergencyRevision: boolean;
  updatedAt: string;
}

/** 分区记录：每个键只存一个标识的一类分区，全部记录共用同一修订号 */
export interface PartitionRecord<Kind extends PartitionKind, Payload> {
  schema: 2;
  kind: Kind;
  signId: string;
  revision: number;
  payload: Payload;
}

export type SignRecord = PartitionRecord<"sign", SignCorePayload>;
export type TermsRecord = PartitionRecord<"terms", TermBinding[]>;
export type CommentsRecord = PartitionRecord<"comments", ReviewComment[]>;

/** 版本分区内的归档区：容量不足时按标识分批压缩，保留最近一条已确认快照 */
export interface VersionArchive {
  snapshots: VersionSnapshot[];
  /** 累计归档的已确认快照数 */
  archivedCount: number;
  updatedAt: string;
}

/**
 * 版本分区记录。归档区内嵌在同一记录里：压缩与归档是一次原子写入，
 * 不存在“归档写进去了、压缩没来得及”的中断窗口，也不会因归档记录
 * 本身写不下而卡死（重写后的记录只会更小）。
 */
export interface VersionsRecord extends PartitionRecord<"versions", VersionSnapshot[]> {
  archive?: VersionArchive;
}

/** 项目元信息记录：修订号即“上一份完整修订”的提交点 */
export interface ProjectMetaRecord {
  schema: 2;
  kind: "meta";
  revision: number;
  project: {
    id: string;
    title: string;
    location: string;
    activeSignId: string;
    updatedAt: string;
  };
  signOrder: string[];
}

/** 待处理区的一个写入单元：prev 用于回滚，next 为 null 表示删除 */
export interface PendingUnit {
  key: string;
  prev: string | null;
  next: string | null;
}

/** 待处理区（写前日志）：一次修订的全部分区写入先落到这里，提交完成后清除 */
export interface PendingJournal {
  schema: 2;
  revision: number;
  startedAt: string;
  units: PendingUnit[];
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
