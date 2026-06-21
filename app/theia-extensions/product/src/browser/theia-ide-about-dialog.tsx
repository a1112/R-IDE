/********************************************************************************
 * Copyright (C) 2020 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { AboutDialog, AboutDialogProps, ABOUT_CONTENT_CLASS } from '@theia/core/lib/browser/about-dialog';
import { injectable, inject } from '@theia/core/shared/inversify';
import { renderDocumentation, renderDownloads, renderProductName, renderSourceCode, renderSupport, renderTickets, renderWhatIs } from './branding-util';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
@injectable()
export class TheiaIDEAboutDialog extends AboutDialog {

    @inject(WindowService)
    protected readonly windowService: WindowService;

    constructor(
        @inject(AboutDialogProps) protected readonly props: AboutDialogProps
    ) {
        super(props);
    }

    protected render(): React.ReactNode {
        return <div className={ABOUT_CONTENT_CLASS}>
            {this.renderContent()}
        </div>;
    }

    protected renderContent(): React.ReactNode {
        return <div className='ad-container'>
            <div className='ad-float'>
                <div className='ad-logo'>
                </div>
                {this.renderExtensions()}
            </div>
            {this.renderTitle()}
            <hr className='gs-hr' />
            <div className='flex-grid'>
                <div className='col'>
                    {renderWhatIs(this.windowService)}
                </div>
            </div>
            <div className='flex-grid'>
                <div className='col'>
                    {renderSupport(this.windowService)}
                </div>
            </div>
            <div className='flex-grid'>
                <div className='col'>
                    {renderTickets(this.windowService)}
                </div>
            </div>
            <div className='flex-grid'>
                <div className='col'>
                    {renderSourceCode(this.windowService)}
                </div>
            </div>
            <div className='flex-grid'>
                <div className='col'>
                    {renderDocumentation(this.windowService)}
                </div>
            </div>
            <div className='flex-grid'>
                <div className='col'>
                    {renderDownloads()}
                </div>
            </div>
        </div>;

    }

    protected renderTitle(): React.ReactNode {
        return <div className='gs-header'>
            {renderProductName()}
            {this.renderVersion()}
        </div>;
    }

    protected renderVersion(): React.ReactNode {
        return <div>
            <p className='gs-sub-header' >
                {this.applicationInfo ? 'Version ' + this.applicationInfo.version : '-'}
            </p>
        </div>;
    }
}
