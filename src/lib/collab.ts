/**
 * 可恢复协作数据层（框架无关）
 *
 * 一份协作文档 CollabDoc 同时承载：
 *  - issues   问题单（带修订号 rev）
 *  - records  处理记录（只追加，与问题单在同一次写入中落盘）
 *  - mergeLinks 合并关系（source -> parent，经 findRoot 总能解析到最终问题单）
 *  - conflicts  保存前比对产生的冲突，双方修订都保留，待审核员选定
 *
 * 所有变更（新建 / 保存修订 / 合并 / 解决冲突）都先写入 WAL（待办操作日志），
 * 再一次性提交文档：提交失败则文档保留原值，WAL 保留操作，可重试；
 * 重开后自动续传恰好一次，之后只能人工重试。
 */

export const DOC_KEY = 'a11y-audit-collab-v2';
export const WAL_KEY = 'a11y-audit-collab-v2-wal';
export const LEGACY_DOC_KEY = 'a11y-audit-v1';

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type ReviewerChoice = 'mine' | 'theirs';

export const WORKFLOW_FIELDS = ['status', 'fixNote', 'retestNote'] as const;
export type WorkflowField = (typeof WORKFLOW_FIELDS)[number];

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  fixNote: string;
  retestNote: string;
  /** 问题单修订号：每次工作流字段提交成功 +1，保存前据此比对双方修订 */
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export type ProcessKind =
  | 'create'
  | 'edit'
  | 'triage'
  | 'fix-start'
  | 'fix-note'
  | 'submit-retest'
  | 'retest-note'
  | 'retest-pass'
  | 'retest-fail'
  | 'reopen'
  | 'merge'
  | 'conflict-resolution';

export interface ProcessRecord {
  id: string;
  /** 幂等键：对应 WAL 操作 id，重放时据此去重 */
  opId: string;
  issueId: string;
  kind: ProcessKind;
  by: string;
  at: string;
  message: string;
  /** 提交后该问题单工作流字段的快照 */
  status?: IssueStatus;
  fixNote?: string;
  retestNote?: string;
  /** 合并记录：最终指向的主问题单 id */
  mergeTargetId?: string;
  conflictId?: string;
}

export interface FieldCandidates {
  field: WorkflowField;
  /** 我的修订（基于旧版本保存的值） */
  mine: string;
  /** 对方的修订（文档头部已提交的值） */
  theirs: string;
  mineBy: string;
  theirsBy: string;
  mineAt: string;
  theirsAt: string;
  chosen?: ReviewerChoice;
}

export interface PendingConflict {
  id: string;
  issueId: string;
  /** 触发冲突的保存操作 id，重放去重 */
  originOpId: string;
  /** 审核员保存时所依据的修订号（旧版本） */
  baseRev: number;
  detectedAt: string;
  fields: FieldCandidates[];
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface CollabDoc {
  version: 2;
  issues: AuditIssue[];
  records: ProcessRecord[];
  /** 合并关系：被合并问题单 id -> 直接指向的父问题单 id */
  mergeLinks: Record<string, string>;
  conflicts: PendingConflict[];
}

export interface WorkflowSnapshot {
  status: IssueStatus;
  fixNote: string;
  retestNote: string;
}

export type WorkflowPatch = Partial<WorkflowSnapshot>;

interface OpBase {
  id: string;
  by: string;
  createdAt: string;
  attempts: number;
  /** 是否已经享受过重开后的那一次自动续传 */
  resumed: boolean;
  lastError?: string;
}

export interface CreateOp extends OpBase {
  type: 'create';
  issueId: string;
  fields: Omit<AuditIssue, 'id' | 'status' | 'fixNote' | 'retestNote' | 'rev' | 'createdAt' | 'updatedAt'>;
}

export interface SaveOp extends OpBase {
  type: 'save';
  issueId: string;
  kind: Exclude<ProcessKind, 'create' | 'merge' | 'conflict-resolution'>;
  message: string;
  /** 审核员打开问题单时看到的旧版本快照（三方比对的 base） */
  base: WorkflowSnapshot;
  patch: WorkflowPatch;
}

export interface MergeOp extends OpBase {
  type: 'merge';
  sourceId: string;
  targetId: string;
}

export interface ResolutionChoice {
  field: WorkflowField;
  choice: ReviewerChoice;
}

export interface ResolveOp extends OpBase {
  type: 'resolve';
  conflictId: string;
  choices: ResolutionChoice[];
}

export type PendingOperation = CreateOp | SaveOp | MergeOp | ResolveOp;

export class CollabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollabError';
  }
}

export const snapshotOf = (issue: AuditIssue): WorkflowSnapshot => ({
  status: issue.status,
  fixNote: issue.fixNote,
  retestNote: issue.retestNote
});

export const FIELD_LABELS: Record<WorkflowField, string> = {
  status: '状态',
  fixNote: '修复说明',
  retestNote: '复测说明'
};

export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};

// ---------- 合并关系：任意层数都解析到最终问题单 ----------

export interface RootResolution {
  root: string;
  /** 从当前问题单到最终问题单经过的链路 */
  chain: string[];
}

export function resolveRoot(links: Record<string, string>, id: string): RootResolution {
  const chain = [id];
  let cur = id;
  const seen = new Set<string>([id]);
  for (;;) {
    const next = links[cur];
    if (!next) return { root: cur, chain };
    if (seen.has(next)) throw new CollabError(`合并关系存在环：${[...chain, next].join(' → ')}`);
    seen.add(next);
    chain.push(next);
    cur = next;
  }
}

/** 路径压缩：无论经过几层，旧链接一律直接指向最终问题单 */
export function compressLinks(links: Record<string, string>): Record<string, string> {
  const compressed: Record<string, string> = {};
  for (const source of Object.keys(links)) {
    const { root, chain } = resolveRoot(links, source);
    if (chain.length > 1) {
      for (const node of chain.slice(0, -1)) compressed[node] = root;
    }
  }
  return compressed;
}

// ---------- 种子与旧版本迁移 ----------

export function seedDoc(now: number = Date.now()): CollabDoc {
  const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();
  const issues: AuditIssue[] = [
    {
      id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算',
      steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
      impactGroup: '键盘与读屏用户', severity: 'serious',
      status: 'triaged', fixNote: '', retestNote: '', rev: 2,
      createdAt: iso(7_200_000), updatedAt: iso(3_600_000)
    },
    {
      id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置',
      steps: '输入无效手机号后使用读屏读取输入框',
      impactGroup: '读屏用户', severity: 'moderate',
      status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', rev: 3,
      createdAt: iso(9_000_000), updatedAt: iso(7_000_000)
    },
    {
      id: 'issue-3', title: '图标按钮缺少可访问名称', flow: '订单结算',
      steps: '打开订单列表，用读屏遍历纯图标按钮',
      impactGroup: '读屏用户', severity: 'minor',
      status: 'open', fixNote: '', retestNote: '', rev: 1,
      createdAt: iso(5_400_000), updatedAt: iso(5_400_000)
    },
    {
      id: 'issue-4', title: '帮助链接仅用图标表达', flow: '全局导航',
      steps: '读屏遍历页脚帮助区域',
      impactGroup: '读屏用户', severity: 'minor',
      status: 'open', fixNote: '', retestNote: '', rev: 1,
      createdAt: iso(4_800_000), updatedAt: iso(4_800_000)
    }
  ];
  // 旧链路：issue-4 -> issue-3 -> issue-2，最终都应回到 issue-2
  const mergeLinks: Record<string, string> = { 'issue-4': 'issue-3', 'issue-3': 'issue-2' };
  const records: ProcessRecord[] = [
    { id: 'r-1', opId: 'seed-1', issueId: 'issue-1', kind: 'create', by: '审核员甲', at: iso(7_200_000), message: '审计员创建问题并保存证据', status: 'open', fixNote: '', retestNote: '' },
    { id: 'r-2', opId: 'seed-2', issueId: 'issue-1', kind: 'triage', by: '审核员甲', at: iso(3_600_000), message: '审核员确认问题有效并完成分诊', status: 'triaged', fixNote: '', retestNote: '' },
    { id: 'r-3', opId: 'seed-3', issueId: 'issue-2', kind: 'create', by: '审核员乙', at: iso(9_000_000), message: '审计员创建问题并保存证据', status: 'open', fixNote: '', retestNote: '' },
    { id: 'r-4', opId: 'seed-4', issueId: 'issue-2', kind: 'fix-start', by: '审核员乙', at: iso(7_000_000), message: '开发人员提交焦点管理修复', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '' },
    { id: 'r-5', opId: 'seed-5', issueId: 'issue-3', kind: 'create', by: '审核员甲', at: iso(5_400_000), message: '审计员创建问题并保存证据', status: 'open', fixNote: '', retestNote: '' },
    { id: 'r-6', opId: 'seed-6', issueId: 'issue-4', kind: 'create', by: '审核员丙', at: iso(4_800_000), message: '审计员创建问题并保存证据', status: 'open', fixNote: '', retestNote: '' },
    { id: 'r-7', opId: 'seed-7', issueId: 'issue-4', kind: 'merge', by: '审核员丙', at: iso(4_200_000), message: '重复问题合并（历史链路）', status: 'open', mergeTargetId: 'issue-3' }
  ];
  return { version: 2, issues, records, mergeLinks, conflicts: [] };
}

interface LegacyIssue {
  id: string; title: string; flow: string; steps: string; impactGroup: string;
  severity: Severity; status: IssueStatus; canonicalId?: string; fixNote: string; retestNote: string;
  updatedAt: string;
}
interface LegacyEvent { id: string; at: string; issueId: string; message: string }

/** 从 v1（最后写入获胜）数据迁移到 v2 协作文档 */
export function migrateLegacy(raw: string): CollabDoc | null {
  try {
    const old = JSON.parse(raw) as { issues?: LegacyIssue[]; events?: LegacyEvent[] };
    if (!old || !Array.isArray(old.issues)) return null;
    const issues: AuditIssue[] = old.issues.map((it) => ({
      id: it.id, title: it.title, flow: it.flow, steps: it.steps,
      impactGroup: it.impactGroup, severity: it.severity, status: it.status,
      fixNote: it.fixNote ?? '', retestNote: it.retestNote ?? '',
      rev: 1, createdAt: it.updatedAt, updatedAt: it.updatedAt
    }));
    const mergeLinks: Record<string, string> = {};
    for (const it of old.issues) if (it.canonicalId) mergeLinks[it.id] = it.canonicalId;
    const records: ProcessRecord[] = (old.events ?? []).map((e, i) => ({
      id: `mig-${i}-${e.id}`, opId: `mig-op-${e.id}`, issueId: e.issueId, kind: 'edit',
      by: '历史记录', at: e.at, message: e.message
    }));
    return { version: 2, issues, records, mergeLinks: compressLinks(mergeLinks), conflicts: [] };
  } catch {
    return null;
  }
}

// ---------- 操作应用（纯函数，就地修改传入的 doc 克隆） ----------

const newId = (prefix: string) =>
  `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

function appendRecord(doc: CollabDoc, rec: Omit<ProcessRecord, 'id'>) {
  doc.records.push({ id: newId('rec'), ...rec });
}

function latestAuthor(doc: CollabDoc, issueId: string): string {
  for (let i = doc.records.length - 1; i >= 0; i--) {
    const r = doc.records[i];
    if (r.issueId === issueId) return r.by;
  }
  return '对方审核员';
}

function applyCreate(doc: CollabDoc, op: CreateOp) {
  if (doc.issues.some((it) => it.id === op.issueId)) return { skipped: true as const };
  const at = op.createdAt;
  const issue: AuditIssue = {
    ...op.fields,
    id: op.issueId,
    status: 'open', fixNote: '', retestNote: '', rev: 1,
    createdAt: at, updatedAt: at
  };
  doc.issues.unshift(issue);
  appendRecord(doc, {
    opId: op.id, issueId: issue.id, kind: 'create', by: op.by, at,
    message: '审计员创建问题并保存证据', status: 'open', fixNote: '', retestNote: ''
  });
  return { skipped: false as const, issueId: issue.id };
}

interface SaveResult {
  outcome: 'applied' | 'conflict';
  conflictId?: string;
  remoteMerged: boolean;
}

function applySave(doc: CollabDoc, op: SaveOp, effectiveBase: WorkflowSnapshot): SaveResult {
  const issue = doc.issues.find((it) => it.id === op.issueId);
  if (!issue) throw new CollabError('问题单不存在或已被删除');

  const head = snapshotOf(issue);
  const next: WorkflowSnapshot = { ...head };
  const conflictFields: FieldCandidates[] = [];
  let appliedChange = false;
  let remoteMerged = false;

  for (const field of WORKFLOW_FIELDS) {
    const b = effectiveBase[field];
    const h = head[field];
    const m = op.patch[field] !== undefined ? (op.patch[field] as string) : b;
    if (h !== b) remoteMerged = true;
    if (b === h) {
      // 对方未动该字段：我的修订直接成立
      if (m !== h) {
        (next[field] as string) = m;
        appliedChange = true;
      }
    } else if (b === m) {
      // 对方改了、我没改：接受对方修订
      (next[field] as string) = h;
    } else if (m === h) {
      // 双方改成相同值
    } else {
      // 双方都基于旧版本改了同一字段且结果不同：两份都留下
      conflictFields.push({
        field, mine: m, theirs: h,
        mineBy: op.by, mineAt: op.createdAt,
        theirsBy: latestAuthor(doc, issue.id), theirsAt: issue.updatedAt
      });
    }
  }

  const priorUnresolved = doc.conflicts.filter((c) => c.issueId === issue.id && !c.resolvedAt);

  // 关闭护栏：只要该问题单还有未选定的冲突（含本次），状态就不能落为 closed
  if (next.status === 'closed' && (priorUnresolved.length > 0 || conflictFields.length > 0)) {
    if (!conflictFields.some((c) => c.field === 'status')) {
      conflictFields.push({
        field: 'status', mine: next.status, theirs: head.status,
        mineBy: op.by, mineAt: op.createdAt,
        theirsBy: latestAuthor(doc, issue.id), theirsAt: issue.updatedAt
      });
    }
    next.status = head.status;
    if (next.status === head.status && !appliedChange) {
      // 仅关闭动作被拦时，其余字段若也无改动则没有可直接落盘的修订
    }
  }

  // 先落无冲突的字段（问题单与处理记录一起写）；冲突字段保持对方（头部）值，两份候选留存在冲突里
  let headChanged = false;
  for (const field of WORKFLOW_FIELDS) {
    if (!conflictFields.some((c) => c.field === field) && next[field] !== issue[field]) {
      (issue[field] as string) = next[field];
      headChanged = true;
    }
  }

  if (conflictFields.length > 0) {
    const at = new Date().toISOString();
    const conflict: PendingConflict = {
      id: newId('conf'), originOpId: op.id, issueId: issue.id,
      baseRev: issue.rev, detectedAt: at, fields: conflictFields
    };
    doc.conflicts.push(conflict);
    if (headChanged) {
      issue.rev += 1;
      issue.updatedAt = at;
      appendRecord(doc, {
        opId: op.id, issueId: issue.id, kind: op.kind, by: op.by, at,
        message: `${op.message}（部分修订与他人冲突已保留两份，待选定后生效）`,
        status: issue.status, fixNote: issue.fixNote, retestNote: issue.retestNote,
        conflictId: conflict.id
      });
    }
    return { outcome: 'conflict', conflictId: conflict.id, remoteMerged };
  }

  if (appliedChange || headChanged) {
    issue.status = next.status;
    issue.fixNote = next.fixNote;
    issue.retestNote = next.retestNote;
    issue.rev += 1;
    issue.updatedAt = new Date().toISOString();
  }
  appendRecord(doc, {
    opId: op.id, issueId: issue.id, kind: op.kind, by: op.by, at: issue.updatedAt,
    message: remoteMerged ? `${op.message}（已与他人修订自动合并）` : op.message,
    status: issue.status, fixNote: issue.fixNote, retestNote: issue.retestNote
  });
  return { outcome: 'applied', remoteMerged };
}

function applyMerge(doc: CollabDoc, op: MergeOp): { skipped: boolean } {
  if (doc.records.some((r) => r.opId === op.id)) return { skipped: true };
  const source = doc.issues.find((it) => it.id === op.sourceId);
  const target = doc.issues.find((it) => it.id === op.targetId);
  if (!source || !target) throw new CollabError('合并的问题单不存在');
  const from = resolveRoot(doc.mergeLinks, op.sourceId);
  const to = resolveRoot(doc.mergeLinks, op.targetId);
  if (from.root === to.root) return { skipped: true };
  // roots 不同，挂上后不可能成环；随后压缩，链路上每个旧链接都直达最终问题单
  doc.mergeLinks[from.root] = to.root;
  doc.mergeLinks = compressLinks(doc.mergeLinks);

  const rootIssue = doc.issues.find((it) => it.id === from.root)!;
  const at = new Date().toISOString();
  rootIssue.rev += 1;
  rootIssue.updatedAt = at;
  appendRecord(doc, {
    opId: op.id, issueId: rootIssue.id, kind: 'merge', by: op.by, at,
    message: `重复问题合并到最终主问题：${target.title}`,
    status: rootIssue.status, fixNote: rootIssue.fixNote, retestNote: rootIssue.retestNote,
    mergeTargetId: to.root
  });
  return { skipped: false };
}

function applyResolve(doc: CollabDoc, op: ResolveOp) {
  const conflict = doc.conflicts.find((c) => c.id === op.conflictId);
  if (!conflict) throw new CollabError('冲突不存在或已被其他操作清理');
  if (conflict.resolvedAt) return { skipped: true as const };
  const issue = doc.issues.find((it) => it.id === conflict.issueId);
  if (!issue) throw new CollabError('问题单不存在');

  if (op.choices.length !== conflict.fields.length) {
    throw new CollabError('每个冲突字段都必须选定一份修订后才能提交');
  }
  for (const c of conflict.fields) {
    const choice = op.choices.find((ch) => ch.field === c.field);
    if (!choice) throw new CollabError(`字段「${FIELD_LABELS[c.field]}」尚未选定`);
    c.chosen = choice.choice;
  }

  const next: WorkflowSnapshot = snapshotOf(issue);
  for (const c of conflict.fields) {
    (next[c.field] as string) = c.chosen === 'mine' ? c.mine : c.theirs;
  }

  const otherUnresolved = doc.conflicts.filter(
    (c) => c.issueId === issue.id && c !== conflict && !c.resolvedAt
  );
  if (next.status === 'closed' && otherUnresolved.length > 0) {
    throw new CollabError(`该问题单还有 ${otherUnresolved.length} 处冲突未选定，不能关闭`);
  }

  const at = new Date().toISOString();
  issue.status = next.status;
  issue.fixNote = next.fixNote;
  issue.retestNote = next.retestNote;
  issue.rev += 1;
  issue.updatedAt = at;
  conflict.resolvedAt = at;
  conflict.resolvedBy = op.by;

  const summary = conflict.fields
    .map((c) => `${FIELD_LABELS[c.field]}采用${c.chosen === 'mine' ? '我方' : '对方'}修订`)
    .join('、');
  appendRecord(doc, {
    opId: op.id, issueId: issue.id, kind: 'conflict-resolution', by: op.by, at,
    message: `冲突已由审核员选定：${summary}`,
    status: issue.status, fixNote: issue.fixNote, retestNote: issue.retestNote,
    conflictId: conflict.id
  });
  return { skipped: false as const };
}

// ---------- 存储适配与 WAL 原子提交 ----------

export interface StorageAdapter {
  loadDoc(): string | null;
  saveDoc(serialized: string): void;
  loadWAL(): string | null;
  writeWAL(serialized: string): void;
  clearWAL(): void;
}

export function createLocalStorageAdapter(): StorageAdapter & {
  failNextDocWrites: (count: number) => void;
  pendingFailures: () => number;
} {
  let failuresLeft = 0;
  return {
    loadDoc: () => localStorage.getItem(DOC_KEY),
    saveDoc: (serialized) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('模拟写入失败：存储暂不可用');
      }
      localStorage.setItem(DOC_KEY, serialized);
    },
    loadWAL: () => localStorage.getItem(WAL_KEY),
    writeWAL: (serialized) => localStorage.setItem(WAL_KEY, serialized),
    clearWAL: () => localStorage.removeItem(WAL_KEY),
    failNextDocWrites: (count) => {
      failuresLeft = Math.max(0, count);
    },
    pendingFailures: () => failuresLeft
  };
}

export function readDoc(adapter: StorageAdapter): CollabDoc {
  const raw = adapter.loadDoc();
  if (raw) {
    const parsed = JSON.parse(raw) as CollabDoc;
    if (parsed && parsed.version === 2 && Array.isArray(parsed.issues)) {
      parsed.mergeLinks = compressLinks(parsed.mergeLinks ?? {});
      return parsed;
    }
  }
  // 首次使用：尝试迁移 v1，否则播种
  if (typeof localStorage !== 'undefined') {
    const legacy = localStorage.getItem(LEGACY_DOC_KEY);
    if (legacy) {
      const migrated = migrateLegacy(legacy);
      if (migrated) return migrated;
    }
  }
  return seedDoc();
}

export function readWAL(adapter: StorageAdapter): PendingOperation[] {
  const raw = adapter.loadWAL();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PendingOperation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWAL(adapter: StorageAdapter, ops: PendingOperation[]) {
  adapter.writeWAL(JSON.stringify(ops));
}

export type StagedOperationInput =
  | Omit<CreateOp, 'attempts' | 'resumed'>
  | Omit<SaveOp, 'attempts' | 'resumed'>
  | Omit<MergeOp, 'attempts' | 'resumed'>
  | Omit<ResolveOp, 'attempts' | 'resumed'>;

/** 所有变更先暂存进 WAL；之后即使页面崩溃，重开也能继续一次 */
export function stageOperation(adapter: StorageAdapter, input: StagedOperationInput): PendingOperation {
  const op = { ...input, attempts: 0, resumed: false } as PendingOperation;
  const ops = readWAL(adapter);
  if (ops.some((it) => it.id === op.id)) throw new CollabError('操作已在待办队列中');
  ops.push(op);
  writeWAL(adapter, ops);
  return op;
}

export interface CommitReport {
  doc: CollabDoc;
  applied: string[];
  conflicted: { opId: string; conflictId: string }[];
  skipped: string[];
  /** 校验失败的操作：未写文档，留在 WAL 等待修改后重试或放弃 */
  rejected: { opId: string; error: string }[];
  /** 文档写入失败：文档保留原值，以下操作留在 WAL 中等待重试 */
  failure?: { opIds: string[]; error: string };
}

function isAlreadyApplied(doc: CollabDoc, op: PendingOperation): boolean {
  switch (op.type) {
    case 'create':
      return doc.issues.some((it) => it.id === op.issueId);
    case 'save':
      return doc.records.some((r) => r.opId === op.id)
        || doc.conflicts.some((c) => c.originOpId === op.id);
    case 'merge':
      return doc.records.some((r) => r.opId === op.id);
    case 'resolve': {
      const c = doc.conflicts.find((it) => it.id === op.conflictId);
      return Boolean(c?.resolvedAt);
    }
  }
}

/** 提交 WAL：把暂存操作按序应用到最新文档，文档只写一次（问题单+处理记录同写） */
export function commitWAL(adapter: StorageAdapter): CommitReport {
  const doc = readDoc(adapter);
  const ops = readWAL(adapter);
  const report: CommitReport = { doc, applied: [], conflicted: [], skipped: [], rejected: [] };
  if (ops.length === 0) return report;

  // 同一审核员连续暂存的多次保存按序衔接：后一次的 base 对齐前一次的结果，避免与自己冲突
  const lastByAuthor = new Map<string, { by: string; snap: WorkflowSnapshot }>();
  const rejected: { op: PendingOperation; error: string }[] = [];

  for (const op0 of ops) {
    const op: PendingOperation = { ...op0, attempts: op0.attempts + 1 };
    if (isAlreadyApplied(doc, op)) {
      report.skipped.push(op.id);
      continue;
    }
    try {
      if (op.type === 'create') {
        const r = applyCreate(doc, op);
        if (r.skipped) report.skipped.push(op.id);
        else report.applied.push(op.id);
      } else if (op.type === 'save') {
        const prior = lastByAuthor.get(op.issueId);
        const effectiveBase = prior && prior.by === op.by ? prior.snap : op.base;
        const r = applySave(doc, op, effectiveBase);
        if (r.outcome === 'conflict' && r.conflictId) {
          report.conflicted.push({ opId: op.id, conflictId: r.conflictId });
        } else {
          report.applied.push(op.id);
          const issue = doc.issues.find((it) => it.id === op.issueId)!;
          lastByAuthor.set(op.issueId, { by: op.by, snap: snapshotOf(issue) });
        }
      } else if (op.type === 'merge') {
        const r = applyMerge(doc, op);
        if (r.skipped) report.skipped.push(op.id);
        else report.applied.push(op.id);
      } else {
        const r = applyResolve(doc, op);
        if (r.skipped) report.skipped.push(op.id);
        else report.applied.push(op.id);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      rejected.push({ op: { ...op, lastError: error }, error });
      report.rejected.push({ opId: op.id, error });
      // 校验失败：文档不写入；本操作（带错误原因）及之后的操作全部留在 WAL 等待处理
    }
  }

  if (rejected.length > 0) {
    const rejectedById = new Map(rejected.map((r) => [r.op.id, r.op]));
    const firstRejectedIdx = ops.findIndex((o) => rejectedById.has(o.id));
    const kept: PendingOperation[] = ops.slice(firstRejectedIdx).map((o) => rejectedById.get(o.id) ?? o);
    try {
      writeWAL(adapter, kept);
    } catch {
      /* WAL 不可写：下次重开会读到旧 WAL */
    }
    // 文档保持原值：前面即便有可应用的操作也不单独落盘（问题单与处理记录必须与同批一起写入）
    return { ...report, doc: readDoc(adapter), applied: [], conflicted: [] };
  }

  doc.mergeLinks = compressLinks(doc.mergeLinks);

  try {
    adapter.saveDoc(JSON.stringify(doc));
  } catch (err) {
    const failedIds = [
      ...new Set([...report.applied, ...report.conflicted.map((c) => c.opId)])
    ];
    // 文档没有改成：applied/conflicted 的操作其实也没落盘，全部留在 WAL
    const rolled: PendingOperation[] = [];
    for (const id of failedIds) {
      const original = ops.find((o) => o.id === id);
      if (original) rolled.push({ ...original, attempts: original.attempts + 1, lastError: err instanceof Error ? err.message : String(err) });
    }
    try {
      writeWAL(adapter, rolled);
    } catch {
      /* WAL 也不可写：下次重开仍会读到旧 WAL 并续传 */
    }
    return { doc: readDoc(adapter), applied: [], conflicted: [], skipped: report.skipped, rejected: [], failure: { opIds: rolled.map((o) => o.id), error: err instanceof Error ? err.message : String(err) } };
  }

  // 文档已落盘，清理已处理操作；异常时保留 WAL 也无妨（重放幂等）
  const consumedIds = new Set([
    ...report.applied,
    ...report.conflicted.map((c) => c.opId),
    ...report.skipped
  ]);
  const finalWAL = readWAL(adapter).filter((op) => !consumedIds.has(op.id));
  try {
    if (finalWAL.length === 0) adapter.clearWAL();
    else writeWAL(adapter, finalWAL);
  } catch {
    /* 幂等重放会兜底 */
  }
  return report;
}

/** 放弃 WAL 中的某个操作（如校验不可能通过的提交），文档不受影响 */
export function discardWALOperation(adapter: StorageAdapter, opId: string): PendingOperation | null {
  const ops = readWAL(adapter);
  const target = ops.find((o) => o.id === opId) ?? null;
  const rest = ops.filter((o) => o.id !== opId);
  if (rest.length === 0) adapter.clearWAL();
  else writeWAL(adapter, rest);
  return target;
}

/**
 * 重开后续传：先把 WAL 条目标记 resumed（即使随后崩溃，也不会再次自动续传），
 * 每个操作在整个生命周期内只自动继续这一次；之后只能由审核员手动重试。
 */
export function resumeWAL(adapter: StorageAdapter): CommitReport | null {
  const ops = readWAL(adapter);
  if (ops.length === 0) return null;
  if (ops.some((op) => !op.resumed)) {
    // 先标记 resumed 再提交：即使提交过程中崩溃，重开也不会再次自动续传
    const marked = ops.map((op) => ({ ...op, resumed: true, attempts: op.attempts + 1 }));
    try {
      writeWAL(adapter, marked);
    } catch {
      /* 标记失败则本次不自动续传，下次重开再试 */
      return null;
    }
    return commitWAL(adapter);
  }
  // 全部已续传过：自动继续的机会已经用过，本生命周期不再自动提交，等待人工重试
  return null;
}

// ---------- 给 UI 用的查询辅助 ----------

export function unresolvedConflicts(doc: CollabDoc, issueId: string): PendingConflict[] {
  return doc.conflicts.filter((c) => c.issueId === issueId && !c.resolvedAt);
}

export function rootOf(doc: CollabDoc, issueId: string): RootResolution {
  return resolveRoot(doc.mergeLinks, issueId);
}

export const isDuplicate = (doc: CollabDoc, issueId: string): boolean => rootOf(doc, issueId).root !== issueId;

/** 构造保存操作的便捷方法 */
export function buildSaveOp(input: {
  id?: string;
  issueId: string;
  by: string;
  base: WorkflowSnapshot;
  patch: WorkflowPatch;
  kind?: SaveOp['kind'];
  message?: string;
}): SaveOp {
  const changed: string[] = [];
  for (const field of WORKFLOW_FIELDS) {
    if (input.patch[field] !== undefined && input.patch[field] !== input.base[field]) {
      changed.push(FIELD_LABELS[field]);
    }
  }
  const kind = input.kind ?? guessKind(input.base, input.patch);
  const message = input.message
    ?? (changed.length ? `审核员保存修订：更新${changed.join('、')}` : '审核员保存处理记录');
  return {
    id: input.id ?? newId('op'), type: 'save', issueId: input.issueId, by: input.by,
    createdAt: new Date().toISOString(), attempts: 0, resumed: false,
    base: input.base, patch: input.patch, kind, message
  };
}

function guessKind(base: WorkflowSnapshot, patch: WorkflowPatch): SaveOp['kind'] {
  if (patch.status && patch.status !== base.status) {
    switch (patch.status) {
      case 'triaged': return 'triage';
      case 'fixing': return 'fix-start';
      case 'verifying': return 'submit-retest';
      case 'closed': return 'retest-pass';
      case 'reopened': return 'retest-fail';
      default: return 'edit';
    }
  }
  if (patch.retestNote !== undefined && patch.retestNote !== base.retestNote) return 'retest-note';
  return 'fix-note';
}
