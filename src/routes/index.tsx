import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  AuditIssue,
  WorkbenchState,
  IssueStatus,
  commitBundle,
  resolveConflictBundle,
  retryOutboxItem,
  flushOutbox,
  resolveCanonicalId,
  deepClone,
  now,
  newId,
  issueStatusLabel
} from '~/lib/collab';

const seed: WorkbenchState = {
  issues: [
    { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString(), rev: 1 },
    { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString(), rev: 1 }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
  ],
  conflicts: [],
  outbox: []
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = localStorage.getItem('a11y-audit-v1');
    if (!raw) return seed;
    const parsed = JSON.parse(raw) as Partial<WorkbenchState>;
    // 兼容旧数据：补齐 rev / conflicts / outbox。
    return {
      issues: (parsed.issues ?? seed.issues).map((i, idx) => ({ ...i, rev: typeof i.rev === 'number' ? i.rev : (i.updatedAt ? idx + 1 : 1) })),
      events: parsed.events ?? seed.events,
      conflicts: parsed.conflicts ?? [],
      outbox: parsed.outbox ?? []
    };
  } catch {
    return seed;
  }
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const [failWrite, setFailWrite] = createSignal(false);
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  // 审核员当前持有的问题单快照（可能落后于 store 中对方已保存的版本）。
  const [snapshot, setSnapshot] = createSignal<AuditIssue | null>(
    (() => {
      const initial = state.issues.find((i) => i.id === selectedId());
      return initial ? deepClone(initial) : null;
    })()
  );
  createEffect(on(selectedId, (id) => {
    const live = state.issues.find((i) => i.id === id);
    if (live) setSnapshot(deepClone(live));
  }));

  const liveIssue = createMemo(() => state.issues.find((issue) => issue.id === selectedId()));
  const conflictForSelected = createMemo(() => state.conflicts.find((c) => c.issueId === selectedId()));
  const hasUnresolvedConflict = createMemo(() => !!conflictForSelected());
  const staleSnapshot = createMemo(() => {
    const snap = snapshot();
    const live = liveIssue();
    return !!snap && !!live && snap.id === live.id && snap.rev < live.rev;
  });
  const outboxCount = createMemo(() => state.outbox.length);

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-v1', JSON.stringify(state));
  });

  const refreshAfter = (issue: AuditIssue) => {
    setSnapshot(deepClone(issue));
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  // 统一的原子提交：问题单 + 处理记录 + 合并关系一起写入；冲突留两份，失败入箱。
  const runCommit = (input: { issueId: string; baseRev: number; local: AuditIssue; messages: string[]; mergeLink?: { fromId: string; toId: string } }) => {
    const result = commitBundle(state, input, { failWrite: failWrite() });
    setState(() => result.state);
    if (result.status === 'applied') refreshAfter(result.issue);
    // conflict / failed：保留审核员手中快照不变，由面板提示选择或重试。
  };

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string) => {
    const snap = snapshot();
    if (!snap || snap.id !== id) return;
    const local: AuditIssue = { ...deepClone(snap), ...patch };
    runCommit({ issueId: id, baseRev: snap.rev, local, messages: [message] });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = { id: newId(), ...values, status: 'open', fixNote: '', retestNote: '', updatedAt: now(), rev: 1 };
    // 新建问题：问题单与首条处理记录在同一次状态变更中原子写入。
    setState((prev) => ({
      ...prev,
      issues: [issue, ...prev.issues],
      events: [{ id: newId(), at: now(), issueId: issue.id, message: '审计员创建问题并保存证据' }, ...prev.events]
    }));
    setSelectedId(issue.id);
    setSnapshot(deepClone(issue));
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const chooseConflict = (choice: 'local' | 'remote') => {
    const result = resolveConflictBundle(state, selectedId(), choice, { failWrite: failWrite() });
    if (result.status === 'applied') {
      setState(() => result.state);
      refreshAfter(result.issue);
    } else if (result.status === 'failed') {
      setState(() => result.state);
    }
  };

  const retryItem = (itemId: string) => {
    const result = retryOutboxItem(state, itemId, { failWrite: failWrite() });
    setState(() => result.state);
    if (result.applied) {
      const item = result.state.outbox.find((o) => o.id === itemId);
      const live = result.state.issues.find((i) => i.id === (item?.issueId ?? selectedId()));
      if (live && live.id === selectedId()) refreshAfter(live);
    }
  };

  // 重新打开后只继续一次：挂载时对发件箱每条记录恰好尝试一次（幂等，不重复写入）。
  onMount(() => {
    const result = flushOutbox(state, {});
    if (result.applied > 0) {
      setState(() => result.state);
      const live = result.state.issues.find((i) => i.id === selectedId());
      if (live) setSnapshot(deepClone(live));
    }
  });

  const mergeDuplicate = () => {
    const duplicate = snapshot();
    if (!duplicate) return;
    const target = state.issues.find((issue) => issue.id === mergeInto());
    if (!target || duplicate.id === target.id) return;
    // 无论目标是否已指向其他问题，都沿链路解析到最终问题单。
    const finalTargetId = resolveCanonicalId(state.issues, target.id);
    const finalTarget = state.issues.find((issue) => issue.id === finalTargetId);
    const local: AuditIssue = { ...deepClone(duplicate), canonicalId: finalTargetId };
    runCommit({
      issueId: duplicate.id,
      baseRev: duplicate.rev,
      local,
      messages: [`重复问题已合并到 ${finalTarget?.title ?? '最终问题单'}（主问题）`],
      mergeLink: { fromId: duplicate.id, toId: finalTargetId }
    });
    setSelectedId(finalTargetId);
    setMergeInto('');
  };

  // 演示用：模拟另一位审核员并发更新了状态与修复说明（对方版本 rev+1）。
  const simulateRemoteEdit = () => {
    const snap = snapshot();
    if (!snap) return;
    setState((prev) => ({
      ...prev,
      issues: prev.issues.map((i) =>
        i.id === snap.id
          ? { ...i, rev: i.rev + 1, status: 'fixing' as IssueStatus, fixNote: i.fixNote || '对方已开始修复并更新修复说明', updatedAt: now() }
          : i
      ),
      events: [
        { id: newId(), at: now(), issueId: snap.id, message: '另一位审核员并发更新了状态与修复说明' },
        ...prev.events
      ]
    }));
  };

  const closeIssue = () => {
    if (hasUnresolvedConflict()) return; // 未选定不能关闭问题
    updateIssue(selectedId(), { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题');
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  const mergeTargets = createMemo(() =>
    state.issues.filter((item) => item.id !== selectedId())
  );

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <Show when={outboxCount() > 0}>
          <section class="banner warn" role="status">
            <strong>有 {outboxCount()} 条协作数据写入未完成，原值已保留未被覆盖。</strong>
            <For each={state.outbox}>{(item) => (
              <div class="outbox-row">
                <span>问题「{state.issues.find((i) => i.id === item.issueId)?.title ?? item.issueId}」· 已尝试 {item.attempts} 次</span>
                <button class="secondary" onClick={() => retryItem(item.id)}>重试写入</button>
              </div>
            )}</For>
          </section>
        </Show>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => {
              const canonical = state.issues.find((i) => i.id === resolveCanonicalId(state.issues, issue.id));
              return (
                <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                  <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                  <div class="meta">
                    <span class="badge">{issueStatusLabel(issue.status)}</span>
                    <span class="badge">{issue.severity}</span>
                    <span>修订 v{issue.rev}</span>
                    <span>{issue.flow}</span>
                    <span>{issue.impactGroup}</span>
                    <Show when={issue.canonicalId}><span class="badge">重复 → {canonical?.title ?? '最终问题单'}</span></Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={snapshot()} fallback={<p role="status">暂无审计问题。</p>}>{(snap) => {
              const issue = snap();
              const conflict = conflictForSelected();
              const stale = staleSnapshot();
              return (
                <>
                  <h3>{issue.title} <span class="badge">v{issue.rev}</span></h3>
                  <Show when={stale && !conflict}>
                    <p class="banner info" role="status">你持有的是旧版本，对方已保存更新（v{liveIssue()?.rev}）。此时提交会进入冲突选择，不会覆盖对方记录。</p>
                  </Show>

                  <Show when={conflict}>
                    <div class="banner conflict" role="alert">
                      <strong>检测到修订冲突：</strong>你与对方都基于 v{conflict!.baseRev} 修改了同一问题单。系统已保留两份修订，请选定一份继续；<strong>未选定前不能关闭问题</strong>。
                      <div class="conflict-grid">
                        <div class="conflict-card">
                          <h4>我方修订（旧版本 v{conflict!.local.rev}）</h4>
                          <p>{conflict!.localSummary}</p>
                          <button onClick={() => chooseConflict('local')}>采用我方修订</button>
                        </div>
                        <div class="conflict-card">
                          <h4>对方修订（新版本 v{conflict!.remote.rev}）</h4>
                          <p>{conflict!.remoteSummary}</p>
                          <button class="secondary" onClick={() => chooseConflict('remote')}>采用对方修订</button>
                        </div>
                      </div>
                    </div>
                  </Show>

                  <p><strong>复现步骤：</strong>{issue.steps}</p>
                  <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                  <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                  <div role="group" aria-label="问题状态操作">
                    <button onClick={() => updateIssue(issue.id, { status: 'triaged' }, '审核员完成分诊')}>确认问题</button>{' '}
                    <button onClick={() => updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                    <button onClick={() => updateIssue(issue.id, { status: 'verifying' }, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                    <button onClick={closeIssue} disabled={hasUnresolvedConflict()} title={hasUnresolvedConflict() ? '存在未选定的修订冲突，不能关闭问题' : ''}>复测通过</button>{' '}
                    <button class="danger" onClick={() => updateIssue(issue.id, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败</button>
                  </div>
                  <Show when={hasUnresolvedConflict()}><p class="error" role="alert">存在未选定的修订冲突，选定版本后才能关闭问题。</p></Show>
                  <hr />
                  <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={mergeTargets()}>{(item) => <option value={item.id}>{item.title}（v{item.rev}）</option>}</For></select></label>
                  <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
                  <hr />
                  <div class="meta" style="margin-top:10px">
                    <button class="secondary" onClick={simulateRemoteEdit}>模拟另一审核员并发修改</button>
                    <label class="fail-toggle"><input type="checkbox" checked={failWrite()} onChange={(e) => setFailWrite(e.currentTarget.checked)} />模拟写入失败（演示原值保留与重试）</label>
                  </div>
                </>
              );
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value ?? ''} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value ?? ''}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value ?? ''}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
