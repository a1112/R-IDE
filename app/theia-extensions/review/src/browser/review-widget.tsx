/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { ConfirmDialog, SingleTextInputDialog } from '@theia/core/lib/browser/dialogs';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { Repository, RepositoryEvent, RepositoryService } from '../common/repository-protocol';
import { Review, ReviewFile, ReviewService, ReviewSummary, ReviewTarget } from '../common/review-protocol';
import { mergeEvents, snapshotAddress } from './review-state';
import { ReviewCommentDialog } from './review-comment-dialog';
import { ReviewAiDialog } from './review-ai-dialog';
import { ReviewModelCatalog } from './review-models';

export const REVIEW_WIDGET_ID = 'ride-repository-review';
const STATE: Record<string, string> = {
    idle: '就绪',
    syncing: '同步中',
    paused: '已暂停',
    error: '失败',
    queued: '排队中',
    running: '分析中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消'
};

@injectable()
export class ReviewWidget extends ReactWidget {
    @inject(RepositoryService) protected readonly repositories!: RepositoryService;
    @inject(ReviewService) protected readonly reviews!: ReviewService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(OpenerService) protected readonly opener!: OpenerService;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(ReviewModelCatalog) protected readonly models!: ReviewModelCatalog;

    protected roots: string[] = [];
    protected items: Repository[] = [];
    protected eventItems: RepositoryEvent[] = [];
    protected cursor = 0;
    protected selectedRepositoryId?: string;
    protected reviewItems: ReviewSummary[] = [];
    protected review?: Review;
    protected selectedPath?: string;
    protected importItems: Repository[] = [];
    protected importSelection = new Set<string>();
    protected historyItems: { oid: string; subject: string; author: string; date: string }[] = [];
    protected blameText?: string;
    protected busy = false;
    protected loading = false;
    protected generation = 0;
    protected error?: string;
    protected filter = '';
    protected activeTab: 'repositories' | 'review' | 'events' = 'repositories';

    @postConstruct()
    protected init(): void {
        this.id = REVIEW_WIDGET_ID;
        this.title.label = '仓库与审查';
        this.title.caption = '本地 Git 仓库同步与固定版本代码审查';
        this.title.iconClass = 'codicon codicon-git-pull-request';
        this.title.closable = true;
        this.addClass('ride-review-widget');
        this.node.tabIndex = 0;
        this.update();
        this.reload();
        const timer = window.setInterval(() => {
            if (this.isVisible) {
                this.reload();
            }
        }, 3000);
        this.toDispose.push({ dispose: () => window.clearInterval(timer) });
    }

    protected onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        this.node.focus();
    }

    protected async reload(): Promise<void> {
        if (this.loading || this.busy || this.isDisposed) {
            return;
        }
        this.loading = true;
        const generation = this.generation;
        try {
            const [roots, repositories, events] = await Promise.all([
                this.repositories.roots(),
                this.repositories.list(),
                this.repositories.events(this.cursor)
            ]);
            const selectedRepositoryId = repositories.some(repo => repo.id === this.selectedRepositoryId) ? this.selectedRepositoryId : repositories[0]?.id;
            const reviewItems = selectedRepositoryId ? await this.reviews.list(selectedRepositoryId) : [];
            let review = this.review;
            const activeSummary = reviewItems.find(item => item.id === review?.id);
            if (review && activeSummary && JSON.stringify(activeSummary.ai) !== JSON.stringify(review.ai)) {
                // Transfer file contents and generated comments only after a run finishes.
                review = activeSummary.ai.state === 'running' || activeSummary.ai.state === 'queued'
                    ? { ...review, ai: activeSummary.ai }
                    : await this.reviews.read(review.id);
            }
            if (this.isDisposed || this.busy || generation !== this.generation) {
                return;
            }
            this.roots = roots;
            this.items = repositories;
            this.eventItems = mergeEvents(this.eventItems, events);
            this.cursor = this.eventItems[this.eventItems.length - 1]?.id || this.cursor;
            this.selectedRepositoryId = selectedRepositoryId;
            this.reviewItems = reviewItems;
            this.review = review;
        } catch (error) {
            this.error = this.errorText(error);
        } finally {
            this.loading = false;
            this.update();
        }
    }

    protected async run(action: () => Promise<unknown>): Promise<void> {
        if (this.busy) {
            return;
        }
        this.generation++;
        this.busy = true;
        this.error = undefined;
        this.update();
        try {
            await action();
        } catch (error) {
            this.error = this.errorText(error);
            this.messages.error(this.error);
        } finally {
            this.busy = false;
            this.update();
            await this.reload();
        }
    }

    protected errorText(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    protected async input(title: string, initialValue = ''): Promise<string | undefined> {
        return new SingleTextInputDialog({ title, initialValue }).open();
    }

    protected async addRoot(): Promise<void> {
        const selected = await this.dialogs.showOpenDialog({ title: '添加项目父目录', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
        if (!selected) {
            return;
        }
        const found = await this.repositories.addRoot(FileUri.fsPath(selected));
        this.importItems = found.filter(repo => !repo.enabled && !repo.submodule);
        this.importSelection = new Set(this.importItems.map(repo => repo.id));
    }

    protected async enableImported(): Promise<void> {
        for (const id of this.importSelection) {
            await this.repositories.configure(id, { enabled: true });
        }
        this.importItems = [];
        this.importSelection.clear();
    }

    protected async recover(repository: Repository, action: 'continue' | 'abort'): Promise<void> {
        let confirmed = false;
        if (action === 'continue' && repository.recoveryNeedsConfirmation) {
            confirmed = !!(await new ConfirmDialog({
                title: '确认本地修改已完整恢复',
                msg: `请先手工核对本地修改、暂存区与未跟踪文件。恢复快照：${repository.recoveryStash || '见仓库阻塞原因'}。`,
                ok: '我已手工恢复并核对全部本地修改（含暂存区和未跟踪文件）',
                cancel: '返回继续检查'
            }).open());
            if (!confirmed) {
                return;
            }
        }
        await this.repositories.recover(repository.id, action, confirmed);
    }

    protected async selectRepository(id: string): Promise<void> {
        this.selectedRepositoryId = id;
        this.review = undefined;
        this.selectedPath = undefined;
        this.historyItems = [];
        this.blameText = undefined;
        this.reviewItems = await this.reviews.list(id);
        this.update();
    }

    protected async createReview(kind: ReviewTarget['kind'], previous?: Review): Promise<void> {
        if (!this.selectedRepositoryId) {
            return;
        }
        let target: ReviewTarget = previous?.target || { kind: 'working' };
        if (!previous && kind === 'commit') {
            const commit = await this.input('审查提交（哈希、标签或 HEAD）', 'HEAD');
            if (!commit?.trim()) {
                return;
            }
            target = { kind, commit: commit.trim() };
        } else if (!previous && kind === 'branch') {
            const base = await this.input('比较基准分支 / 提交', this.items.find(repo => repo.id === this.selectedRepositoryId)?.upstream || 'HEAD~1');
            if (!base?.trim()) {
                return;
            }
            const head = await this.input('比较目标分支 / 提交', 'HEAD');
            if (!head?.trim()) {
                return;
            }
            target = { kind, base: base.trim(), head: head.trim() };
        }
        this.review = await this.reviews.create(this.selectedRepositoryId, target, previous?.id);
        this.selectedPath = this.review.files[0]?.path;
        this.activeTab = 'review';
        this.blameText = undefined;
    }

    protected async openDiff(file: ReviewFile): Promise<void> {
        if (!this.review || file.skipped) {
            return;
        }
        const left = new URI(snapshotAddress(this.review.id, file.path, 'before'));
        const right = new URI(snapshotAddress(this.review.id, file.path, 'after'));
        await open(this.opener, DiffUris.encode(left, right, `${file.path} · ${this.review.title}（只读）`));
    }

    protected async addComment(file: ReviewFile): Promise<void> {
        if (!this.review || file.skipped) {
            return;
        }
        const reviewId = this.review.id;
        const comment = await new ReviewCommentDialog(file).open();
        if (comment) {
            this.review = await this.reviews.comment(reviewId, comment);
        }
    }

    protected async exportReview(): Promise<void> {
        if (!this.review) {
            return;
        }
        const report = await this.reviews.exportMarkdown(this.review.id);
        const target = await this.dialogs.showSaveDialog({ title: '导出审查报告', inputValue: `review-${this.review.id}.md`, filters: { Markdown: ['md'] } });
        if (target) {
            await this.files.writeFile(target, BinaryBuffer.fromString(report));
            this.messages.info('审查报告已保存。');
        }
    }

    protected async deleteReview(review: Review): Promise<void> {
        const confirmed = await new ConfirmDialog({
            title: '删除审查记录',
            msg: `删除“${review.title}”及其快照和批注？仓库代码不受影响。`,
            ok: '删除记录',
            cancel: '保留'
        }).open();
        if (!confirmed) {
            return;
        }
        await this.reviews.delete(review.id);
        this.review = undefined;
        this.selectedPath = undefined;
        this.blameText = undefined;
    }

    protected action(label: string, action: () => Promise<unknown>, disabled = false): React.ReactNode {
        return (
            <button
                type='button'
                disabled={this.busy || disabled}
                onClick={() => {
                    this.run(action);
                }}
            >
                {label}
            </button>
        );
    }

    protected render(): React.ReactNode {
        const repository = this.items.find(repo => repo.id === this.selectedRepositoryId);
        return (
            <main className='ride-review' aria-label='仓库与代码审查'>
                <header className='ride-review-header'>
                    <div>
                        <h1>仓库与审查</h1>
                        <p>自动同步本地仓库，阅读固定版本，保留审查结论</p>
                    </div>
                    <div className='ride-review-actions'>
                        {this.action('添加项目目录', () => this.addRoot())}
                        {this.action('刷新', async () => {
                            await this.repositories.refresh();
                        })}
                    {this.action('工作区全文搜索', () => this.commands.executeCommand('search-in-workspace.open'))}
                    {this.action('当前文件符号', () => this.commands.executeCommand('editor.action.quickOutline'))}
                    </div>
                </header>
                {this.error && (
                    <p className='ride-review-error' role='alert'>
                        {this.error}
                    </p>
                )}
                <nav className='ride-review-tabs' aria-label='工作台视图'>
                    {(['repositories', 'review', 'events'] as const).map(tab => (
                        <button
                            key={tab}
                            type='button'
                            aria-current={this.activeTab === tab ? 'page' : undefined}
                            onClick={() => {
                                this.activeTab = tab;
                                this.update();
                            }}
                        >
                            {tab === 'repositories' ? `仓库 ${this.items.length}` : tab === 'review' ? '审查工作区' : `事件 ${this.eventItems.length}`}
                        </button>
                    ))}
                    <span role='status'>{this.busy ? '正在处理…' : '快照不会随自动同步改变'}</span>
                </nav>
                {this.activeTab === 'repositories'
                    ? this.renderRepositories()
                    : this.activeTab === 'events'
                      ? this.renderEvents()
                      : this.renderReview(repository)}
            </main>
        );
    }

    protected renderRepositories(): React.ReactNode {
        return (
            <section aria-label='仓库中心'>
                <details className='ride-review-roots'>
                    <summary>扫描目录（{this.roots.length}）</summary>
                    {this.roots.map(root => (
                        <div key={root} className='ride-review-root'>
                            <code>{root}</code>
                            {this.action('移除扫描目录', () => this.repositories.removeRoot(root))}
                        </div>
                    ))}
                </details>
                {this.importItems.length > 0 && (
                    <section className='ride-review-import' aria-label='选择自动同步仓库'>
                        <h2>选择启用自动同步的仓库</h2>
                        <p>启用后将在应用运行时每 5 分钟检查上游，保存本地修改并尝试更新。后续发现的仓库需要手动启用。</p>
                        {this.importItems.map(repo => (
                            <label key={repo.id}>
                                <input
                                    type='checkbox'
                                    checked={this.importSelection.has(repo.id)}
                                    onChange={event => {
                                        if (event.target.checked) {
                                            this.importSelection.add(repo.id);
                                        } else {
                                            this.importSelection.delete(repo.id);
                                        }
                                        this.update();
                                    }}
                                />
                                {repo.path}
                            </label>
                        ))}
                        <div className='ride-review-actions'>
                            {this.action('启用所选仓库', () => this.enableImported())}
                            {this.action('仅导入', async () => {
                                this.importItems = [];
                            })}
                        </div>
                    </section>
                )}
                {!this.items.length && (
                    <div className='ride-review-empty'>
                        <h2>从本机项目目录开始</h2>
                        <p>添加一个父目录即可发现普通 Git 仓库与 worktree。代码审查可在不启用自动同步的情况下使用。</p>
                    </div>
                )}
                <div className='ride-review-repositories'>
                    {this.items.map(repo => (
                        <article key={repo.id} className={`ride-review-repository ${repo.id === this.selectedRepositoryId ? 'selected' : ''}`}>
                            <header>
                                <h2>
                                    <button
                                        type='button'
                                        onClick={() => {
                                            this.run(() => this.selectRepository(repo.id));
                                        }}
                                    >
                                        {repo.name}
                                    </button>
                                </h2>
                                <span className={`ride-review-state ${repo.state}`}>{STATE[repo.state] || repo.state}</span>
                            </header>
                            <code className='ride-review-path'>{repo.path}</code>
                            <dl>
                                <dt>分支</dt>
                                <dd>
                                    {repo.branch || '分离 HEAD'} → {repo.upstream || '未设置上游'}
                                </dd>
                                <dt>与上游比较</dt>
                                <dd>
                                    领先 {repo.ahead} · 落后 {repo.behind}
                                </dd>
                                <dt>工作区</dt>
                                <dd>
                                    {repo.dirty ? '有本地修改' : '干净'}
                                    {repo.submodule ? ' · 子模块（需手动管理）' : ''}
                                </dd>
                                <dt>最近同步</dt>
                                <dd>{repo.lastSync ? new Date(repo.lastSync).toLocaleString() : '尚未同步'}</dd>
                            </dl>
                            {repo.reason && <p className='ride-review-reason'>{repo.reason}</p>}
                            {repo.recoveryStash && <p>恢复快照：<code>{repo.recoveryStash}</code></p>}
                            {repo.retainedStash && <p>已保留本地修改备份：<code>{repo.retainedStash}</code></p>}
                            <div className='ride-review-actions'>
                                {this.action(
                                    repo.enabled ? '暂停自动同步' : '启用自动同步',
                                    () => this.repositories.configure(repo.id, { enabled: !repo.enabled }),
                                    !!repo.submodule || repo.state === 'syncing'
                                )}
                                {this.action('立即同步', () => this.repositories.sync(repo.id), repo.state === 'syncing' || !!repo.submodule)}
                                {this.action('阅读与审查', async () => {
                                    await this.selectRepository(repo.id);
                                    this.activeTab = 'review';
                                })}
                                {this.action('打开仓库工作区', async () => {
                                    await this.workspace.openWorkspace(FileUri.create(repo.path), { preserveWindow: true });
                                })}
                                {repo.state === 'paused' && (
                                    <>
                                        {this.action('继续恢复', () => this.recover(repo, 'continue'))}
                                        {this.action('中止并恢复', () => this.recover(repo, 'abort'))}
                                    </>
                                )}
                            </div>
                        </article>
                    ))}
                </div>
            </section>
        );
    }

    protected renderEvents(): React.ReactNode {
        return (
            <section aria-label='仓库事件'>
                <p className='ride-review-muted'>按观测时间记录可确认的状态变化；应用关闭期间的变化由重新核对补查。此视图显示最近 300 条。</p>
                {!this.eventItems.length && <p className='ride-review-empty'>暂无事件。</p>}
                <ol className='ride-review-events'>
                    {[...this.eventItems].reverse().map(event => (
                        <li key={event.id}>
                            <header>
                                <strong>{this.items.find(repo => repo.id === event.repositoryId)?.name || event.repositoryId}</strong>
                                <time>{new Date(event.observedAt).toLocaleString()}</time>
                            </header>
                            <p>
                                {this.eventLabel(event.type)}
                                {event.message ? ` · ${event.message}` : ''}
                            </p>
                            {(event.before || event.after) && (
                                <code>
                                    {event.before?.slice(0, 12) || '—'} → {event.after?.slice(0, 12) || '—'}
                                </code>
                            )}
                            {event.operationId && <small>同步事务 {event.operationId}</small>}
                        </li>
                    ))}
                </ol>
            </section>
        );
    }

    protected renderReview(repository?: Repository): React.ReactNode {
        if (!repository) {
            return <p className='ride-review-empty'>请先添加并选择一个仓库。</p>;
        }
        const review = this.review;
        const file = review?.files.find(item => item.path === this.selectedPath);
        return (
            <section aria-label='审查工作区'>
                <div className='ride-review-actions ride-review-reviewbar'>
                    <label>
                        仓库{' '}
                        <select
                            value={repository.id}
                            disabled={this.busy}
                            onChange={event => {
                                this.run(() => this.selectRepository(event.target.value));
                            }}
                        >
                            {this.items.map(repo => (
                                <option key={repo.id} value={repo.id}>
                                    {repo.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    {this.action('审查工作区', () => this.createReview('working'))}
                    {this.action('审查提交', () => this.createReview('commit'))}
                    {this.action('比较分支', () => this.createReview('branch'))}
                    {this.action('提交历史', async () => {
                        this.historyItems = await this.reviews.history(repository.id);
                    })}
                    <label>
                        审查记录{' '}
                        <select
                            value={review?.id || ''}
                            disabled={this.busy}
                            onChange={event => {
                                const id = event.target.value;
                                if (id) {
                                    this.run(async () => {
                                        this.review = await this.reviews.read(id);
                                        this.selectedPath = this.review.files[0]?.path;
                                        this.blameText = undefined;
                                    });
                                }
                            }}
                        >
                            <option value=''>选择已保存的审查</option>
                            {this.reviewItems.map(item => (
                                <option key={item.id} value={item.id}>
                                    {new Date(item.createdAt).toLocaleString()} · {item.title}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                {this.historyItems.length > 0 && (
                    <details open>
                        <summary>提交历史</summary>
                        <ol className='ride-review-history'>
                            {this.historyItems.map(commit => (
                                <li key={commit.oid}>
                                    {this.action(`${commit.oid.slice(0, 8)} ${commit.subject}`, async () => {
                                        this.review = await this.reviews.create(repository.id, { kind: 'commit', commit: commit.oid });
                                        this.selectedPath = this.review.files[0]?.path;
                                    })}
                                    <span>
                                        {commit.author} · {commit.date}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </details>
                )}
                {!review ? (
                    <div className='ride-review-empty'>
                        <h2>选择一个版本开始阅读</h2>
                        <p>工作区、提交和分支比较都会创建不可变的审查快照，已读状态与批注自动保存。</p>
                    </div>
                ) : (
                    <>
                        <header className='ride-review-revision'>
                            <div>
                                <h2>{review.title}</h2>
                                <code>
                                    {review.base.slice(0, 12)} → {review.head.slice(0, 12)}
                                </code>
                                <p>
                                    创建于 {new Date(review.createdAt).toLocaleString()} · {review.files.filter(item => item.read).length}/{review.files.length}{' '}
                                    文件已读{review.previousReviewId ? ' · 增量修订' : ''}
                                </p>
                            </div>
                            <div className='ride-review-actions'>
                                {this.action('增量审查', () => this.createReview(review.target.kind, review))}
                                {this.action('导出 Markdown', () => this.exportReview())}
                            {this.action('删除审查', () => this.deleteReview(review), review.ai.state === 'running' || review.ai.state === 'queued')}
                            </div>
                        </header>
                        <section className='ride-review-ai' aria-label='AI 辅助审查'>
                            <div className='ride-review-actions'>
                                <strong>AI 审查：{STATE[review.ai.state] || review.ai.state}</strong>
                                {this.action(
                                    '开始只读 AI 审查',
                                    async () => {
                                        const model = await new ReviewAiDialog(await this.models.list()).open();
                                        if (model !== undefined) {
                                            this.review = await this.reviews.startAi(review.id, model);
                                        }
                                    },
                                    review.ai.state === 'running' || review.ai.state === 'queued'
                                )}
                                {this.action(
                                    '取消 AI',
                                    async () => {
                                        this.review = await this.reviews.cancelAi(review.id);
                                    },
                                    review.ai.state !== 'running' && review.ai.state !== 'queued'
                                )}
                                <span>
                                    已覆盖 {review.ai.covered.length}/{review.files.length} 个文件
                                </span>
                            </div>
                            {review.ai.message && <p role='status'>{review.ai.message}</p>}
                            {review.ai.summary && <p className='ride-review-summary'>{review.ai.summary}</p>}
                        </section>
                        <div className='ride-review-layout'>
                            <aside aria-label='变更文件'>
                                <label className='ride-review-filter'>
                                    筛选文件
                                    <input
                                        value={this.filter}
                                        placeholder='输入路径'
                                        onChange={event => {
                                            this.filter = event.target.value;
                                            this.update();
                                        }}
                                    />
                                </label>
                                <ul className='ride-review-filelist'>
                                    {review.files
                                        .filter(item => item.path.toLocaleLowerCase().includes(this.filter.toLocaleLowerCase()))
                                        .map(item => (
                                            <li key={item.path}>
                                                <button
                                                    type='button'
                                                    aria-pressed={item.path === this.selectedPath}
                                                    onClick={() => {
                                                        this.selectedPath = item.path;
                                                        this.blameText = undefined;
                                                        this.update();
                                                    }}
                                                >
                                                    <span>
                                                        {item.read ? '✓ ' : ''}
                                                        {item.bookmarked ? '★ ' : ''}
                                                        {item.path}
                                                    </span>
                                                    <small>
                                                        {item.status} ·{' '}
                                                        {item.skipped
                                                            ? `未分析：${item.skipped}`
                                                            : review.ai.covered.includes(item.path)
                                                              ? 'AI 已覆盖'
                                                              : 'AI 未覆盖'}
                                                    </small>
                                                </button>
                                            </li>
                                        ))}
                                </ul>
                                {!review.files.length && <p>此快照没有变更文件。</p>}
                            </aside>
                            <article className='ride-review-file' aria-label='文件审查'>
                                {file ? (
                                    <>
                                        <header>
                                            <h3>{file.path}</h3>
                                            <div className='ride-review-actions'>
                                                {this.action('打开双栏 Diff', () => this.openDiff(file), !!file.skipped)}
                                                {this.action('打开当前工作区文件', () => open(this.opener, FileUri.create(repository.path).resolve(file.path)))}
                                                {this.action(file.read ? '标记未读' : '标记已读', async () => {
                                                    this.review = await this.reviews.markFile(review.id, file.path, { read: !file.read });
                                                })}
                                                {this.action(file.bookmarked ? '取消书签' : '添加书签', async () => {
                                                    this.review = await this.reviews.markFile(review.id, file.path, { bookmarked: !file.bookmarked });
                                                })}
                                                {this.action('添加行批注', () => this.addComment(file), !!file.skipped)}
                                                {this.action(
                                                    'Blame',
                                                    async () => {
                                                        this.blameText = await this.reviews.blame(review.id, file.path);
                                                    },
                                                    !!file.skipped
                                                )}
                                            </div>
                                        </header>
                                        {file.beforeMode !== file.afterMode && (
                                            <p className='ride-review-muted'>
                                                文件模式：{file.beforeMode || '不存在'} → {file.afterMode || '不存在'}
                                            </p>
                                        )}
                                        {file.skipped ? (
                                            <p className='ride-review-reason'>未分析此文件：{file.skipped}</p>
                                        ) : (
                                            <div className='ride-review-preview' aria-label='固定快照预览'>
                                                <div>
                                                    <h4>修改前</h4>
                                                    <pre>{this.preview(file.before)}</pre>
                                                </div>
                                                <div>
                                                    <h4>修改后</h4>
                                                    <pre>{this.preview(file.after)}</pre>
                                                </div>
                                            </div>
                                        )}
                                        {this.blameText && (
                                            <details open>
                                                <summary>Blame（快照版本）</summary>
                                                <pre className='ride-review-blame'>{this.blameText}</pre>
                                            </details>
                                        )}
                                        <section className='ride-review-comments' aria-label='行级批注'>
                                            <h3>批注</h3>
                                            {review.comments
                                                .filter(comment => comment.path === file.path)
                                                .map(comment => (
                                                    <article key={comment.id} className={comment.resolved ? 'resolved' : ''}>
                                                        <header>
                                                            <strong>
                                                                {comment.source === 'ai' ? 'AI' : '人工'} · {comment.side === 'before' ? '修改前' : '修改后'} L
                                                                {comment.start}
                                                                {comment.end !== comment.start ? `–${comment.end}` : ''} {comment.severity || ''}
                                                            </strong>
                                                            {this.action(comment.resolved ? '重新打开' : '标记已解决', async () => {
                                                                this.review = await this.reviews.resolveComment(review.id, comment.id, !comment.resolved);
                                                            })}
                                                        </header>
                                                        <p>{comment.body}</p>
                                                    </article>
                                                ))}
                                            {!review.comments.some(comment => comment.path === file.path) && (
                                                <p className='ride-review-muted'>此文件暂无批注。</p>
                                            )}
                                        </section>
                                    </>
                                ) : (
                                    <p className='ride-review-empty'>从左侧选择一个变更文件。</p>
                                )}
                            </article>
                        </div>
                    </>
                )}
            </section>
        );
    }

    protected preview(text: string): string {
        const lines = text.split('\n');
        const preview = lines
            .slice(0, 150)
            .map((line, index) => `${String(index + 1).padStart(4, ' ')}  ${line}`)
            .join('\n');
        return preview + (lines.length > 150 ? '\n… 打开双栏 Diff 查看完整文件' : '');
    }

    protected eventLabel(type: RepositoryEvent['type']): string {
        const labels: Record<RepositoryEvent['type'], string> = {
            discovered: '发现仓库',
            observed: '重新核对仓库状态',
            'worktree-changed': '工作区或暂存区已变化',
            'head-changed': 'HEAD 已变化',
            'branch-changed': '分支已变化',
            'commits-discovered': '发现新提交',
            'sync-start': '开始同步',
            'sync-success': '同步完成',
            'sync-failed': '同步失败',
            'sync-conflict': '同步发生冲突',
            recovery: '恢复同步事务'
        };
        return labels[type];
    }
}
