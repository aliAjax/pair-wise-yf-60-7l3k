import { createMemo, createSignal, onMount } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  CollabDoc,
  PendingOperation,
  ReviewerChoice,
  StagedOperationInput,
  StorageAdapter,
  WorkflowField,
  WorkflowPatch,
  WorkflowSnapshot,
  buildSaveOp,
  commitWAL,
  createLocalStorageAdapter,
  discardWALOperation,
  readDoc,
  readWAL,
  resumeWAL,
  seedDoc,
  snapshotOf,
  stageOperation
} from './collab';

const REVIEWER_KEY = 'a11y-audit-reviewer';

export type ToastKind = 'ok' | 'warn' | 'error';
export interface Toast { id: string; kind: ToastKind; text: string }

type CommitReport = ReturnType<typeof commitWAL>;

export interface CollabActions {
  saveWorkflow: (input: {
    issueId: string;
    base: WorkflowSnapshot;
    patch: WorkflowPatch;
    kind?: ReturnType<typeof buildSaveOp>['kind'];
    message?: string;
  }) => CommitReport | null;
  createIssue: (fields: {
    title: string; flow: string; steps: string; impactGroup: string;
    severity: 'critical' | 'serious' | 'moderate' | 'minor';
  }) => CommitReport | null;
  merge: (sourceId: string, targetId: string) => CommitReport | null;
  resolveConflict: (conflictId: string, choices: { field: WorkflowField; choice: ReviewerChoice }[]) => CommitReport | null;
  retryAll: () => void;
  discardOp: (opId: string) => void;
  simulateRemoteSave: (input: { issueId: string; patch: WorkflowPatch; by?: string }) => void;
  failNextWrite: (count?: number) => void;
  pendingFailures: () => number;
}

function createMemoryAdapter(): StorageAdapter {
  let docRaw = JSON.stringify(seedDoc());
  let walRaw: string | null = null;
  return {
    loadDoc: () => docRaw,
    saveDoc: (s: string) => { docRaw = s; },
    loadWAL: () => walRaw,
    writeWAL: (s: string) => { walRaw = s; },
    clearWAL: () => { walRaw = null; }
  };
}

export function createCollabStore() {
  // SSR / 首次渲染用内存种子；挂载后切换到 localStorage 适配器并装载同一份协作文档
  let adapter: StorageAdapter = createMemoryAdapter();

  const [doc, setDoc] = createStore<CollabDoc>(readDoc(adapter));
  const [wal, setWal] = createStore<PendingOperation[]>(readWAL(adapter));
  const [hydrated, setHydrated] = createSignal(false);
  const [reviewer, setReviewer] = createSignal('审核员甲');
  const [toasts, setToasts] = createStore<Toast[]>([]);
  const [staleNotice, setStaleNotice] = createSignal(false);

  const notify = (kind: ToastKind, text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((items) => [...items, { id, kind, text }]);
    window.setTimeout(() => setToasts((items) => items.filter((t) => t.id !== id)), 5200);
  };

  const refresh = () => {
    setDoc(reconcile(readDoc(adapter)));
    setWal(reconcile(readWAL(adapter)));
  };

  const describeReport = (report: CommitReport) => {
    if (report.failure) {
      notify('error', `写入失败，问题单与处理记录均保留原值；操作已留在待办队列，可重试：${report.failure.error}`);
      return;
    }
    if (report.rejected.length > 0) {
      notify('warn', `有 ${report.rejected.length} 个操作未通过校验、未写入文档：${report.rejected.map((r) => r.error).join('；')}`);
    }
    if (report.conflicted.length > 0) {
      notify('warn', '检测到与其他审核员的修订冲突，两份内容都已保留，请在冲突面板逐字段选定；选定前该问题不能关闭');
      return;
    }
    if (report.applied.length > 0) {
      notify('ok', `已原子写入 ${report.applied.length} 个操作（问题单与处理记录一起落盘）`);
    }
  };

  const enqueueAndCommit = (opInput: StagedOperationInput): CommitReport | null => {
    try {
      stageOperation(adapter, opInput);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
      return null;
    }
    const report = commitWAL(adapter);
    refresh();
    describeReport(report);
    return report;
  };

  const actions: CollabActions = {
    saveWorkflow: ({ issueId, base: baseSnap, patch, kind, message }) =>
      enqueueAndCommit(buildSaveOp({ issueId, by: reviewer(), base: baseSnap, patch, kind, message })),
    createIssue: (fields) => {
      const id = `issue-${Math.random().toString(36).slice(2, 9)}`;
      return enqueueAndCommit({
        id: `op-${id}`, type: 'create', issueId: id, by: reviewer(),
        createdAt: new Date().toISOString(), fields
      });
    },
    merge: (sourceId, targetId) => enqueueAndCommit({
      id: `op-merge-${Math.random().toString(36).slice(2, 9)}`,
      type: 'merge', sourceId, targetId, by: reviewer(),
      createdAt: new Date().toISOString()
    }),
    resolveConflict: (conflictId, choices) => enqueueAndCommit({
      id: `op-resolve-${Math.random().toString(36).slice(2, 9)}`,
      type: 'resolve', conflictId, choices,
      by: reviewer(), createdAt: new Date().toISOString()
    }),
    retryAll: () => {
      const report = commitWAL(adapter);
      refresh();
      describeReport(report);
    },
    discardOp: (opId) => {
      discardWALOperation(adapter, opId);
      refresh();
      notify('ok', '已从待办队列移除该操作，协作文档未受影响');
    },
    /**
     * 演示用：模拟“另一位审核员在另一个会话里直接落盘了修订”。
     */
    simulateRemoteSave: ({ issueId, patch, by }) => {
      const fresh = readDoc(adapter);
      const issue = fresh.issues.find((i) => i.id === issueId);
      if (!issue) return;
      const op = buildSaveOp({
        issueId, by: by ?? (reviewer() === '审核员甲' ? '审核员乙' : '审核员甲'),
        base: snapshotOf(issue), patch
      });
      stageOperation(adapter, op);
      commitWAL(adapter);
      refresh();
      setStaleNotice(true);
      notify('ok', `已模拟其他审核员保存了「${op.by}」的修订（rev 已前进），你本地仍可基于旧版本保存以触发冲突`);
    },
    failNextWrite: (count = 1) => {
      if (!('failNextDocWrites' in adapter)) return;
      (adapter as ReturnType<typeof createLocalStorageAdapter>).failNextDocWrites(count);
      notify('warn', `已设置下一次文档写入失败（${count} 次），用于演示原子写失败、保留原值与重试`);
    },
    pendingFailures: () => ('pendingFailures' in adapter ? (adapter as ReturnType<typeof createLocalStorageAdapter>).pendingFailures() : 0)
  };

  const changeReviewer = (name: string) => {
    setReviewer(name);
    localStorage.setItem(REVIEWER_KEY, name);
  };

  onMount(() => {
    // 切换为浏览器端适配器并装载持久化数据
    adapter = createLocalStorageAdapter();
    setReviewer(localStorage.getItem(REVIEWER_KEY) || '审核员甲');
    refresh();

    // 重开后续传恰好一次
    const report = resumeWAL(adapter);
    refresh();
    setHydrated(true);
    if (report) {
      if (report.failure) notify('error', `重开续传失败（自动续传已用一次），请在待办队列手动重试：${report.failure.error}`);
      else if (report.applied.length || report.conflicted.length) notify('ok', `重开后已自动续传 ${report.applied.length + report.conflicted.length} 个待办操作（仅自动继续这一次）`);
    }

    // 跨标签页：另一个会话写入后，本会话重新装载同一份协作文档
    window.addEventListener('storage', (event) => {
      if (event.key === 'a11y-audit-collab-v2' || event.key === 'a11y-audit-collab-v2-wal' || event.key === null) {
        refresh();
        setStaleNotice(true);
      }
    });
  });

  const issueById = createMemo(() => {
    const map = new Map(doc.issues.map((i) => [i.id, i]));
    return (id: string) => map.get(id);
  });

  return {
    doc, wal, hydrated, reviewer, changeReviewer, toasts, staleNotice, setStaleNotice,
    actions, issueById, refresh
  };
}
