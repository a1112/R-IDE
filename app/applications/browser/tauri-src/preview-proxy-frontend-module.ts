import URI from '@theia/core/lib/common/uri';
import {
    CommandContribution,
    MenuContribution,
    ResourceProvider,
    bindRootContributionProvider
} from '@theia/core/lib/common';
import {
    FrontendApplicationContribution,
    OpenHandler,
    WidgetFactory
} from '@theia/core/lib/browser';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { ContainerModule, type Container } from '@theia/core/shared/inversify';
import { PreviewContribution } from '@theia/preview/lib/browser/preview-contribution';
import {
    PreviewHandler,
    PreviewHandlerProvider,
    type RenderContentParams
} from '@theia/preview/lib/browser/preview-handler';
import { PreviewLinkNormalizer } from '@theia/preview/lib/browser/preview-link-normalizer';
import { PreviewUri } from '@theia/preview/lib/browser/preview-uri';
import {
    PreviewWidget,
    PreviewWidgetOptions
} from '@theia/preview/lib/browser/preview-widget';
import { bindPreviewPreferences } from '@theia/preview/lib/common/preview-preferences';
import '@theia/preview/src/browser/style/index.css';
import '@theia/preview/src/browser/markdown/style/index.css';

export interface RideMarkdownPreviewFeature {
    createMarkdownPreviewHandler(parentContainer: Container): PreviewHandler;
}

export type RideMarkdownPreviewFeatureLoader = () => Promise<RideMarkdownPreviewFeature>;

interface DisposablePreviewHandler extends PreviewHandler {
    dispose?(): void;
}

export class RideLazyMarkdownPreviewHandler implements PreviewHandler {
    readonly iconClass = 'markdown-icon file-icon';

    protected activation: Promise<PreviewHandler> | undefined;
    protected delegate: PreviewHandler | undefined;
    protected disposedDelegate: PreviewHandler | undefined;
    protected disposed = false;

    constructor(
        protected readonly parentContainer: Container,
        protected readonly loadFeature: RideMarkdownPreviewFeatureLoader = () => import('./preview-markdown-feature')
    ) { }

    canHandle(uri: URI): number {
        const extension = uri.path.ext.toLowerCase();
        return uri.scheme === 'file' && (extension === '.md' || extension === '.markdown') ? 500 : 0;
    }

    async renderContent(params: RenderContentParams): Promise<HTMLElement | undefined> {
        const delegate = await this.getDelegate();
        return await delegate.renderContent(params);
    }

    findElementForFragment(content: HTMLElement, fragment: string): HTMLElement | undefined {
        return this.delegate?.findElementForFragment?.(content, fragment);
    }

    findElementForSourceLine(content: HTMLElement, sourceLine: number): HTMLElement | undefined {
        return this.delegate?.findElementForSourceLine?.(content, sourceLine);
    }

    getSourceLineForOffset(content: HTMLElement, offset: number): number | undefined {
        return this.delegate?.getSourceLineForOffset?.(content, offset);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.delegate) {
            this.disposeDelegate(this.delegate);
            this.delegate = undefined;
        }
    }

    protected getDelegate(): Promise<PreviewHandler> {
        if (this.disposed) {
            return Promise.reject(new Error('Markdown preview handler is disposed.'));
        }
        if (this.delegate) {
            return Promise.resolve(this.delegate);
        }
        if (this.activation) {
            return this.activation;
        }

        const activation = (async (): Promise<PreviewHandler> => {
            const feature = await this.loadFeature();
            if (this.disposed) {
                throw new Error('Markdown preview handler was disposed while loading.');
            }
            const delegate = feature.createMarkdownPreviewHandler(this.parentContainer);
            if (this.disposed) {
                this.disposeDelegate(delegate);
                throw new Error('Markdown preview handler was disposed while activating.');
            }
            this.delegate = delegate;
            return delegate;
        })();
        this.activation = activation;
        void activation.catch(() => {
            if (this.activation === activation) {
                this.activation = undefined;
            }
        });
        return activation;
    }

    protected disposeDelegate(delegate: PreviewHandler): void {
        if (this.disposedDelegate === delegate) {
            return;
        }
        this.disposedDelegate = delegate;
        (delegate as DisposablePreviewHandler).dispose?.();
    }
}

export default new ContainerModule((bind, _unbind, _isBound, _rebind, _unbindAsync, _onActivation, onDeactivation) => {
    bindPreviewPreferences(bind);
    bind(PreviewHandlerProvider).toSelf().inSingletonScope();
    bindRootContributionProvider(bind, PreviewHandler);
    bind(RideLazyMarkdownPreviewHandler).toDynamicValue(context =>
        new RideLazyMarkdownPreviewHandler(context.container)
    ).inSingletonScope();
    bind(PreviewHandler).toService(RideLazyMarkdownPreviewHandler);
    onDeactivation(RideLazyMarkdownPreviewHandler, handler => handler.dispose());
    bind(PreviewLinkNormalizer).toSelf().inSingletonScope();
    bind(PreviewWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: PreviewUri.id,
        async createWidget(options: { uri: string }): Promise<PreviewWidget> {
            const resource = await context.container.get(ResourceProvider)(new URI(options.uri));
            const child = context.container.createChild();
            child.bind(PreviewWidgetOptions).toConstantValue({ resource });
            return child.get(PreviewWidget);
        }
    })).inSingletonScope();
    bind(PreviewContribution).toSelf().inSingletonScope();
    [
        CommandContribution,
        MenuContribution,
        OpenHandler,
        FrontendApplicationContribution,
        TabBarToolbarContribution
    ].forEach(serviceIdentifier => bind(serviceIdentifier).toService(PreviewContribution));
});
