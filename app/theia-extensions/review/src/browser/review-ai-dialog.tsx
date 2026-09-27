/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { RideCodexModel } from 'theia-ide-codex-ext/lib/common/ride-codex-conversations';
import { selectDefaultModel } from './review-models';

export class ReviewAiDialog extends ReactDialog<string> {
    protected selectedModel: string;

    constructor(protected readonly models: readonly RideCodexModel[]) {
        super({ title: '开始只读 AI 审查', maxWidth: 600 });
        this.selectedModel = selectDefaultModel(models);
        this.appendCloseButton('取消');
        this.appendAcceptButton('开始审查');
        this.update();
    }

    get value(): string { return this.selectedModel; }

    protected isValid(value: string): string {
        return this.models.some(model => model.id === value) ? '' : '未找到可用模型，请先在 Codex 面板登录。';
    }

    protected render(): React.ReactNode {
        const selected = this.models.find(model => model.id === this.selectedModel);
        return <section className='ride-review-comment-form'>
            <p>复用现有 Codex 登录。AI 将读取此审查的固定快照，返回变更解释与问题建议。</p>
            <label>Codex 模型<select value={this.selectedModel} onChange={event => { this.selectedModel = event.target.value; this.update(); }}>
                {this.models.map(model => <option key={model.id} value={model.id}>{model.displayName}{model.isDefault ? '（默认）' : ''}</option>)}
            </select></label>
            {selected && <p>{selected.description}</p>}
        </section>;
    }
}
