import { SecondaryWindowHandler } from '@theia/core/lib/browser/secondary-window-handler';
import { ExtractableWidget, codicon } from '@theia/core/lib/browser/widgets';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Command, CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
    RideDeferredCommandProxy,
    RideDeferredFeatureLoader
} from 'theia-ide-product-ext/lib/browser/ride-deferred-feature-loader';

const EXTRACT_WIDGET = Command.toLocalizedCommand({
    id: 'extract-widget',
    label: 'Move View to Secondary Window'
}, 'theia/secondary-window/extract-widget');

const RideSecondaryWindowProxy = Symbol('RideSecondaryWindowProxy');

export default new ContainerModule(bind => {
    bind(RideSecondaryWindowProxy).toDynamicValue(context => {
        const secondaryWindowHandler = context.container.get(SecondaryWindowHandler);
        return new RideDeferredCommandProxy(
            context.container.get(RideDeferredFeatureLoader),
            {
                id: 'secondary-window',
                command: EXTRACT_WIDGET,
                toolbarItem: {
                    id: EXTRACT_WIDGET.id,
                    command: EXTRACT_WIDGET.id,
                    icon: codicon('window')
                },
                isEnabled: widget => ExtractableWidget.is(widget) && widget.secondaryWindow === undefined,
                isVisible: widget => ExtractableWidget.is(widget) && widget.secondaryWindow === undefined,
                load: () => import('./secondary-window-feature')
                    .then(module => module.createSecondaryWindowFeature(secondaryWindowHandler))
            }
        );
    }).inSingletonScope();
    bind(CommandContribution).toService(RideSecondaryWindowProxy);
    bind(TabBarToolbarContribution).toService(RideSecondaryWindowProxy);
    bind(FrontendApplicationContribution).toService(RideSecondaryWindowProxy);
});
