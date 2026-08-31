/** @type {import('eslint').Linter.Config} */
module.exports = {
    ignorePatterns: [
        'src/common/generated'
    ],
    rules: {
        // App Server and JSON-RPC payloads distinguish an explicit null from an
        // omitted property, so replacing null with undefined changes the wire format.
        'no-null/no-null': 'off'
    }
};
