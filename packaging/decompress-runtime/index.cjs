'use strict';

// Theia expects an asynchronous CommonJS callable; the maintained safe fork
// exports an ESM default. Keep the existing call contract without legacy code.
module.exports = (...args) => import('@xhmikosr/decompress')
  .then(({ default: decompress }) => decompress(...args));
