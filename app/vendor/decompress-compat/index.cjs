'use strict';

// Theia requires a callable CommonJS export; extraction is already asynchronous.
// Dynamic import also works on Node 22 versions without require(ESM) support.
module.exports = async (...args) => {
    const { default: decompress } = await import('@xhmikosr/decompress');
    return decompress(...args);
};
