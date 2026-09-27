/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { ReviewFile, ReviewComment } from '../common/review-protocol';
import { validateCommentRange } from './review-state';

type CommentDraft = Omit<ReviewComment, 'id' | 'source' | 'resolved'>;

export class ReviewCommentDialog extends ReactDialog<CommentDraft> {
    protected side: 'before' | 'after' = 'after';
    protected start = 1;
    protected end = 1;
    protected body = '';

    constructor(protected readonly file: ReviewFile) {
        super({ title: '添加行级批注', maxWidth: 640 });
        this.appendCloseButton('取消');
        this.appendAcceptButton('保存批注');
        this.update();
    }

    get value(): CommentDraft {
        return { path: this.file.path, side: this.side, start: this.start, end: this.end, body: this.body.trim() };
    }

    protected isValid(value: CommentDraft): string {
        return validateCommentRange(this.file[value.side], value.start, value.end) || (value.body ? '' : '请输入批注内容。');
    }

    protected handleEnter(event: KeyboardEvent): boolean | void {
        if (event.target instanceof HTMLTextAreaElement && !event.ctrlKey && !event.metaKey) {
            return false;
        }
        return super.handleEnter(event);
    }

    protected render(): React.ReactNode {
        return <section className='ride-review-comment-form'>
            <code>{this.file.path}</code>
            <p>批注绑定此审查快照；之后同步仓库不会改变批注位置。</p>
            <div className='ride-review-comment-range'>
                <label>位置<select value={this.side} onChange={event => { this.side = event.target.value as 'before' | 'after'; this.update(); }}>
                    <option value='after'>修改后</option><option value='before'>修改前</option>
                </select></label>
                <label>起始行<input type='number' min={1} step={1} value={this.start}
                    onChange={event => { this.start = Number(event.target.value); this.update(); }} /></label>
                <label>结束行<input type='number' min={1} step={1} value={this.end}
                    onChange={event => { this.end = Number(event.target.value); this.update(); }} /></label>
            </div>
            <label>批注内容<textarea autoFocus rows={7} value={this.body}
                onChange={event => { this.body = event.target.value; this.update(); }} /></label>
        </section>;
    }
}
