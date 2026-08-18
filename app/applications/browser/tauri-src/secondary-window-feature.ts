import type { TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import type { SecondaryWindowHandler } from '@theia/core/lib/browser/secondary-window-handler';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import type { Disposable } from '@theia/core/lib/common/disposable';
import {
    SecondaryWindowContribution
} from '@theia/secondary-window/lib/browser/secondary-window-frontend-contribution';
import {
    RideDeferredContributionType,
    type RideDeferredFeatureModule
} from 'theia-ide-product-ext/lib/browser/ride-deferred-feature-loader';

class RideSecondaryWindowContributionAdapter extends SecondaryWindowContribution {
    constructor(protected override readonly secondaryWindowHandler: SecondaryWindowHandler) {
        super();
    }
}

export function createSecondaryWindowFeature(
    secondaryWindowHandler: SecondaryWindowHandler
): RideDeferredFeatureModule {
    const contribution = new RideSecondaryWindowContributionAdapter(secondaryWindowHandler);
    return {
        contributionTypes: [
            RideDeferredContributionType.Commands,
            RideDeferredContributionType.TabBarToolbar
        ],
        registerCommands: commands => {
            let commandRegistration: Disposable | undefined;
            const adapter = new Proxy(commands, {
                get(target, property, receiver) {
                    if (property === 'registerCommand') {
                        return (...args: Parameters<CommandRegistry['registerCommand']>) => {
                            commandRegistration = target.registerCommand(...args);
                            return commandRegistration;
                        };
                    }
                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            contribution.registerCommands(adapter);
            if (!commandRegistration) {
                throw new Error('Secondary-window command adapter did not register a command.');
            }
            return commandRegistration;
        },
        registerToolbarItems: toolbar => {
            let toolbarRegistration: Disposable | undefined;
            const adapter = new Proxy(toolbar, {
                get(target, property, receiver) {
                    if (property === 'registerItem') {
                        return (...args: Parameters<TabBarToolbarRegistry['registerItem']>) => {
                            toolbarRegistration = target.registerItem(...args);
                            return toolbarRegistration;
                        };
                    }
                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            contribution.registerToolbarItems(adapter);
            if (!toolbarRegistration) {
                throw new Error('Secondary-window toolbar adapter did not register an item.');
            }
            return toolbarRegistration;
        }
    };
}
