// Shim to allow Vite/Vitest to resolve the node:sqlite built-in module
// This file is only used during testing
module.exports = require("node:sqlite");
