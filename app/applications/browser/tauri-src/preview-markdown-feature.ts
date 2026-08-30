import type { Container } from '@theia/core/shared/inversify';
import { MarkdownPreviewHandler } from '@theia/preview/lib/browser/markdown/markdown-preview-handler';

export function createMarkdownPreviewHandler(parentContainer: Container): MarkdownPreviewHandler {
    const child = parentContainer.createChild();
    child.bind(MarkdownPreviewHandler).toSelf().inSingletonScope();
    return child.get(MarkdownPreviewHandler);
}
